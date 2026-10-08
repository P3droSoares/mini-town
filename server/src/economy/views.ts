/**
 * Visões públicas (PropertyView, carteira). Só expõem o que o contrato
 * permite: de terceiros, apenas displayName.
 */
import type pg from 'pg';
import { ECONOMY, type BusinessType, type Category } from './config.js';
import {
  accrual,
  appraisal,
  askRange,
  businessOpenCost,
  businessUpgradeCost,
  cityPrice,
  incomePerHour,
  iptuMultiplier,
} from './pricing.js';

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

interface PropertyRow {
  lot_id: string;
  category: Category;
  area_m2: string;
  levels: number;
  address: string | null;
  base_price: bigint;
  sellable: boolean;
  retired_at: Date | null;
  owner_id: string | null;
  owner_name: string | null;
  owner_residence: string | null;
  last_collected_at: Date | null;
  locked_until: Date | null;
  acquired_price: bigint | null;
  starter_encumbered_until: Date | null;
  starter_subsidy_due: bigint | null;
  biz_type: BusinessType | null;
  biz_level: number | null;
  rival_levels: number;
  listing_id: string | null;
  ask_price: bigint | null;
  index_bp: number;
  ema_bp: number;
}

export interface PropertyView {
  lotId: string;
  category: Category;
  area: number;
  levels: number;
  address: string | null;
  appraisal: string;
  cityPrice: string | null;
  buyable: boolean;
  owner: { displayName: string } | null;
  mine: boolean;
  isResidence: boolean;
  business: { type: BusinessType; level: number } | null;
  /** suspended = preço saiu da faixa permitida (índice mudou); não pode ser comprado */
  listing: { id: string; askPrice: string; suspended: boolean } | null;
  incomePerHour: string;
  /** só para o dono: casa inicial travada para venda até essa data */
  lockedUntil: string | null;
  /** só para o dono: custo do próximo nível do negócio (null = sem negócio/nível máximo) */
  upgradeCost: string | null;
  /** só para o dono de comercial sem negócio: custo de abertura */
  openBusinessCost: string | null;
}

/** Dados internos usados pelos serviços (além da visão). */
export interface PropertyRecord {
  lotId: string;
  category: Category;
  basePrice: bigint;
  /** avaliação atual (índice instantâneo): preço, patrimônio, faixa do anúncio */
  appraisal: bigint;
  /** avaliação para a renda: menor entre índice e média móvel */
  incomeAppraisal: bigint;
  /** avaliação para o IPTU: maior entre índice e média móvel */
  taxAppraisal: bigint;
  ownerId: string | null;
  isResidence: boolean;
  lastCollectedAt: Date | null;
  acquiredPrice: bigint | null;
  retired: boolean;
  /** casa inicial do dono atual ainda sob gravame */
  starter: { encumberedUntil: Date; subsidyDue: bigint } | null;
  business: { type: BusinessType; level: number; competitors: number } | null;
}

const R = ECONOMY.business.competitionRadiusM;
const SELECT_PROPERTY = `
  SELECT p.lot_id, p.category, p.area_m2::text AS area_m2, p.levels, p.address, p.base_price, p.sellable, p.retired_at,
         p.owner_id, u.display_name AS owner_name, u.residence_lot_id AS owner_residence,
         p.last_collected_at, p.locked_until, p.acquired_price,
         sc.encumbered_until AS starter_encumbered_until, (sc.subsidy - sc.subsidy_repaid) AS starter_subsidy_due,
         b.type AS biz_type, b.level AS biz_level,
         CASE WHEN b.type IS NULL THEN 0 ELSE (
           -- rivais do mesmo tipo, de outros donos, no raio (caixa primeiro: usa o índice em x)
           SELECT coalesce(sum(b2.level), 0)::int FROM properties p2 JOIN businesses b2 ON b2.lot_id = p2.lot_id
            WHERE b2.type = b.type AND p2.lot_id <> p.lot_id
              AND p2.owner_id IS DISTINCT FROM p.owner_id
              AND p2.x BETWEEN p.x - ${R} AND p.x + ${R}
              AND p2.z BETWEEN p.z - ${R} AND p.z + ${R}
              AND (p2.x - p.x) ^ 2 + (p2.z - p.z) ^ 2 <= ${R ** 2}
         ) END AS rival_levels,
         l.id AS listing_id, l.ask_price, mi.index_bp, mi.ema_bp
    FROM properties p
    JOIN market_indices mi ON mi.category = p.category
    LEFT JOIN users u ON u.id = p.owner_id
    LEFT JOIN starter_claims sc ON sc.lot_id = p.lot_id AND sc.user_id = p.owner_id AND sc.released_at IS NULL
    LEFT JOIN businesses b ON b.lot_id = p.lot_id
    LEFT JOIN listings l ON l.lot_id = p.lot_id AND l.status = 'active'`;

function toRecord(r: PropertyRow): PropertyRecord {
  const lo = Math.min(r.index_bp, r.ema_bp);
  const hi = Math.max(r.index_bp, r.ema_bp);
  const level = r.biz_level ?? 1;
  return {
    lotId: r.lot_id,
    category: r.category,
    basePrice: r.base_price,
    appraisal: appraisal(r.base_price, r.index_bp),
    incomeAppraisal: appraisal(r.base_price, lo),
    taxAppraisal: appraisal(r.base_price, hi),
    ownerId: r.owner_id,
    isResidence: r.owner_id !== null && r.owner_residence === r.lot_id,
    lastCollectedAt: r.last_collected_at,
    acquiredPrice: r.acquired_price,
    retired: r.retired_at !== null,
    starter:
      r.starter_encumbered_until && r.owner_id
        ? { encumberedUntil: r.starter_encumbered_until, subsidyDue: r.starter_subsidy_due ?? 0n }
        : null,
    business: r.biz_type ? { type: r.biz_type, level, competitors: r.rival_levels / level } : null,
  };
}

/** Casa inicial sob gravame não rende aluguel (residência ou não). */
export const isEncumbered = (rec: PropertyRecord, now: Date): boolean =>
  rec.starter !== null && rec.starter.encumberedUntil > now;

/** Casa elegível como inicial (avaliação BASE, sem índice). */
export const isStarterEligible = (category: Category, base: bigint): boolean =>
  category === 'residential' && base <= ECONOMY.starter.maxBase;

function toView(r: PropertyRow, viewerId: string | null, viewerOwned: number, now: Date): PropertyView {
  const rec = toRecord(r);
  const mine = viewerId !== null && r.owner_id === viewerId;
  const forSale = r.owner_id === null && r.sellable && !rec.retired;
  // residência/gravame de terceiros não são expostos: renda mostrada como potencial
  const isResidence = mine && rec.isResidence;
  const encumbered = mine && isEncumbered(rec, now);
  const range = askRange(rec.appraisal, ECONOMY.market.buyTolerance);
  const suspended = r.ask_price !== null && (r.ask_price < range.min || r.ask_price > range.max);
  return {
    lotId: r.lot_id,
    category: r.category,
    area: Number(r.area_m2),
    levels: r.levels,
    address: r.address,
    appraisal: rec.appraisal.toString(),
    cityPrice: forSale ? cityPrice(rec.appraisal, viewerOwned).toString() : null,
    buyable: forSale || (r.listing_id !== null && !mine && !suspended),
    owner: r.owner_name ? { displayName: r.owner_name } : null,
    mine,
    isResidence,
    business: rec.business ? { type: rec.business.type, level: rec.business.level } : null,
    listing:
      r.listing_id && r.ask_price !== null ? { id: r.listing_id, askPrice: r.ask_price.toString(), suspended } : null,
    incomePerHour: BigInt(
      Math.floor(incomePerHour({ ...rec, appraisal: rec.incomeAppraisal, isResidence, encumbered })),
    ).toString(),
    lockedUntil: mine && r.locked_until && r.locked_until > now ? r.locked_until.toISOString() : null,
    upgradeCost:
      mine && rec.business ? (businessUpgradeCost(rec.appraisal, rec.business.level)?.toString() ?? null) : null,
    openBusinessCost:
      mine && !rec.business && r.category === 'commercial' ? businessOpenCost(rec.appraisal).toString() : null,
  };
}

/** Quantos imóveis o jogador tem (preço progressivo da prefeitura, IPTU progressivo). */
export async function ownedCount(db: Queryable, userId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM properties WHERE owner_id = $1`, [userId]);
  return rows[0]?.n ?? 0;
}

export async function propertyView(
  db: Queryable,
  lotId: string,
  viewerId: string | null,
  now: Date = new Date(),
): Promise<PropertyView | null> {
  const { rows } = await db.query<PropertyRow>(`${SELECT_PROPERTY} WHERE p.lot_id = $1`, [lotId]);
  const r = rows[0];
  if (!r) return null;
  const owned = viewerId && r.owner_id === null ? await ownedCount(db, viewerId) : 0;
  return toView(r, viewerId, owned, now);
}

export async function propertyRecord(db: Queryable, lotId: string): Promise<PropertyRecord | null> {
  const { rows } = await db.query<PropertyRow>(`${SELECT_PROPERTY} WHERE p.lot_id = $1`, [lotId]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function ownedPropertyRows(
  db: Queryable,
  userId: string,
  now: Date = new Date(),
): Promise<{ views: PropertyView[]; records: PropertyRecord[] }> {
  const { rows } = await db.query<PropertyRow>(`${SELECT_PROPERTY} WHERE p.owner_id = $1 ORDER BY p.lot_id`, [userId]);
  return { views: rows.map((r) => toView(r, userId, 0, now)), records: rows.map(toRecord) };
}

/**
 * Amostra de casas iniciais elegíveis: residenciais sem dono, avaliação BASE ≤
 * teto. Ordem pseudoaleatória por jogador (espalha a disputa pela cidade).
 */
export async function starterHomeViews(db: Queryable, viewerId: string | null): Promise<PropertyView[]> {
  const S = ECONOMY.starter;
  const { rows } = await db.query<PropertyRow>(
    `${SELECT_PROPERTY}
      WHERE p.category = 'residential' AND p.sellable AND p.owner_id IS NULL AND p.retired_at IS NULL
        AND p.base_price <= $1
      ORDER BY md5(p.lot_id || $3::text)
      LIMIT $2`,
    [S.maxBase.toString(), S.sampleSize, viewerId ?? ''],
  );
  const now = new Date();
  return rows.map((r) => toView(r, viewerId, 0, now));
}

export interface Wallet {
  balance: string;
  netWorth: string;
  pendingIncome: string;
  starterAvailable: boolean;
  /** IPTU vencido que não coube no saldo (cobrado antes de qualquer renda) */
  taxDebt: string;
  /** conta nova: mercado entre jogadores liberado a partir desta data (null = liberado) */
  marketUnlockAt: string | null;
}

export interface PendingTotals {
  gross: bigint;
  tax: bigint;
  /** `until` = novo last_collected_at do lote (só o tempo efetivamente cobrado) */
  perLot: Map<string, { gross: bigint; tax: bigint; until: Date }>;
}

/**
 * Renda (teto de 24 h) e IPTU (tempo real, teto de 30 dias, progressivo pelo
 * tamanho da carteira) pendentes dos imóveis.
 */
export function pendingFor(records: PropertyRecord[], now: Date, ownedTotal: number): PendingTotals {
  let gross = 0n;
  let tax = 0n;
  const mult = iptuMultiplier(ownedTotal);
  const perLot = new Map<string, { gross: bigint; tax: bigint; until: Date }>();
  for (const r of records) {
    if (!r.lastCollectedAt) continue;
    // residência: isenta de IPTU até o limite (morar tem benefício real)
    const exempt = r.isResidence ? ECONOMY.residenceTaxExemption : 0n;
    const taxBase = r.taxAppraisal > exempt ? r.taxAppraisal - exempt : 0n;
    const a = accrual(
      { ...r, appraisal: r.incomeAppraisal, encumbered: isEncumbered(r, now) },
      r.lastCollectedAt,
      now,
      taxBase,
      mult,
    );
    perLot.set(r.lotId, { gross: a.gross, tax: a.tax, until: new Date(r.lastCollectedAt.getTime() + a.consumedMs) });
    gross += a.gross;
    tax += a.tax;
  }
  return { gross, tax, perLot };
}

export async function walletView(db: Queryable, userId: string, now: Date): Promise<Wallet> {
  // sequencial: `db` pode ser um client dentro de transação
  const { rows: acc } = await db.query<{ balance: bigint; tax_debt: bigint; created_at: Date; starter: boolean }>(
    `SELECT a.balance, u.tax_debt, u.created_at,
            EXISTS (SELECT 1 FROM starter_claims s WHERE s.user_id = u.id) AS starter
       FROM users u JOIN accounts a ON a.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const { records } = await ownedPropertyRows(db, userId, now);
  const a = acc[0];
  const balance = a?.balance ?? 0n;
  const debt = a?.tax_debt ?? 0n;
  const props = records.reduce((s, r) => s + r.appraisal, 0n);
  const p = pendingFor(records, now, records.length);
  const unlock = a ? new Date(a.created_at.getTime() + ECONOMY.market.minAccountAgeDays * 86_400_000) : null;
  return {
    balance: balance.toString(),
    netWorth: (balance + props - debt).toString(),
    pendingIncome: (p.gross - p.tax).toString(),
    starterAvailable: a ? !a.starter : false,
    taxDebt: debt.toString(),
    marketUnlockAt: unlock && unlock > now ? unlock.toISOString() : null,
  };
}
