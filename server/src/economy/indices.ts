/**
 * Índice de mercado por categoria (pontos-base). Sobe com compras (ponderadas
 * pelo valor), cai com vendas ao governo, reverte à média e respeita a
 * variação máxima por hora e a faixa [0,6; 1,8]. Guarda também uma média
 * móvel exponencial (EMA), usada na renda/IPTU para que um pico curto do
 * índice não infle a coleta.
 */
import type pg from 'pg';
import { CATEGORIES, ECONOMY, type Category } from './config.js';

const I = ECONOMY.index;
const HOUR = 3_600_000;

export interface IndexState {
  indexBp: number;
  anchorBp: number;
  anchorAt: Date;
  updatedAt: Date;
  emaBp: number;
}

const clampBp = (v: number) => Math.min(I.maxBp, Math.max(I.minBp, v));

/** Cálculo puro do novo estado (testável sem banco). */
export function nextIndex(s: IndexState, deltaBp: number, now: Date): IndexState {
  const hours = Math.max(0, (now.getTime() - s.updatedAt.getTime()) / HOUR);
  // reversão à média proporcional ao tempo parado
  let v = I.baseBp + (s.indexBp - I.baseBp) * (1 - I.reversionPerHour) ** hours;
  // EMA acompanha o valor do período que passou (antes da operação atual)
  const ema = s.emaBp + (s.indexBp - s.emaBp) * (1 - Math.exp(-hours / I.emaHours));
  let anchorBp = s.anchorBp;
  let anchorAt = s.anchorAt;
  if (now.getTime() - s.anchorAt.getTime() >= HOUR) {
    anchorBp = Math.round(v);
    anchorAt = now;
  }
  v += deltaBp;
  const lo = Math.max(I.minBp, anchorBp - I.maxHourlyChangeBp);
  const hi = Math.min(I.maxBp, anchorBp + I.maxHourlyChangeBp);
  const indexBp = Math.round(Math.min(hi, Math.max(lo, v)));
  return { indexBp, anchorBp: clampBp(anchorBp), anchorAt, updatedAt: now, emaBp: Math.round(clampBp(ema)) };
}

/**
 * Aplica variação de demanda na categoria (trava a linha; chamar por último
 * na transação, depois de montar as respostas, para segurar a trava pouco).
 */
export async function bumpIndex(c: pg.PoolClient, category: Category, deltaBp: number, now: Date): Promise<number> {
  const { rows } = await c.query<{ index_bp: number; anchor_bp: number; anchor_at: Date; updated_at: Date; ema_bp: number }>(
    `SELECT index_bp, anchor_bp, anchor_at, updated_at, ema_bp FROM market_indices WHERE category = $1 FOR UPDATE`,
    [category],
  );
  const r = rows[0];
  if (!r) throw new Error(`índice ausente: ${category}`);
  const n = nextIndex(
    { indexBp: r.index_bp, anchorBp: r.anchor_bp, anchorAt: r.anchor_at, updatedAt: r.updated_at, emaBp: r.ema_bp },
    deltaBp,
    // relógio nunca anda para trás no índice
    now > r.updated_at ? now : r.updated_at,
  );
  await c.query(
    `UPDATE market_indices SET index_bp = $2, anchor_bp = $3, anchor_at = $4, updated_at = $5, ema_bp = $6 WHERE category = $1`,
    [category, n.indexBp, n.anchorBp, n.anchorAt, n.updatedAt, n.emaBp],
  );
  return n.indexBp;
}

/** Preço de referência da categoria (mediana da base, gravada na sincronização do catálogo). */
export async function readRefPrice(db: Pick<pg.Pool, 'query'>, category: Category): Promise<bigint | null> {
  const { rows } = await db.query<{ ref_price: bigint | null }>(`SELECT ref_price FROM market_indices WHERE category = $1`, [
    category,
  ]);
  return rows[0]?.ref_price ?? null;
}

export async function readAllIndices(db: Pick<pg.Pool, 'query'>): Promise<Record<Category, number>> {
  const { rows } = await db.query<{ category: Category; index_bp: number }>(
    `SELECT category, index_bp FROM market_indices`,
  );
  const out = Object.fromEntries(CATEGORIES.map((c) => [c, I.baseBp])) as Record<Category, number>;
  for (const r of rows) out[r.category] = r.index_bp;
  return out;
}
