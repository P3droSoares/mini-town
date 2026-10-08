/**
 * Razão contábil de partidas dobradas. Toda movimentação = uma transação com
 * lançamentos que somam zero; o saldo em cache das contas de JOGADOR é
 * atualizado por trigger na mesma transação SQL (o papel app não escreve em
 * accounts.balance). Contas de sistema não têm saldo em cache: o saldo delas
 * é a soma dos lançamentos (sem linha quente travada por toda a economia).
 */
import type pg from 'pg';
import { AppError } from '../http/errors.js';

export type SystemCode = 'TESOURO' | 'IMPOSTOS' | 'TAXAS' | 'GOVERNO';
export type SystemAccounts = Record<SystemCode, bigint>;

export type TxKind =
  | 'signup_grant'
  | 'starter_home'
  | 'city_purchase'
  | 'city_sale'
  | 'market_sale'
  | 'income'
  | 'business_open'
  | 'business_upgrade'
  /** ajuste manual (só o papel dono; o banco recusa vindo do app) */
  | 'adjustment';

export async function loadSystemAccounts(db: Pick<pg.Pool, 'query'>): Promise<SystemAccounts> {
  const { rows } = await db.query<{ id: bigint; code: SystemCode }>(
    `SELECT id, code FROM accounts WHERE kind = 'system'`,
  );
  const out = Object.fromEntries(rows.map((r) => [r.code, r.id])) as Partial<SystemAccounts>;
  for (const c of ['TESOURO', 'IMPOSTOS', 'TAXAS', 'GOVERNO'] as const) {
    if (out[c] === undefined) throw new Error(`conta de sistema ${c} ausente`);
  }
  return out as SystemAccounts;
}

export interface LockedAccount {
  id: bigint;
  balance: bigint;
  userId: string | null;
}

/**
 * Trava contas de JOGADOR em ordem crescente de id (ordem global → sem
 * deadlock). Contas de sistema nunca são travadas (não têm CHECK nem cache).
 */
export async function lockAccounts(c: pg.PoolClient, ids: bigint[]): Promise<Map<bigint, LockedAccount>> {
  const uniq = [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const { rows } = await c.query<{ id: bigint; balance: bigint; user_id: string | null }>(
    `SELECT id, balance, user_id FROM accounts WHERE id = ANY($1::bigint[]) AND kind = 'player' ORDER BY id FOR UPDATE`,
    [uniq.map(String)],
  );
  if (rows.length !== uniq.length) throw new Error('conta de jogador inexistente');
  return new Map(rows.map((r) => [r.id, { id: r.id, balance: r.balance, userId: r.user_id }]));
}

/** Conta do jogador (sem trava). */
export async function playerAccountId(db: Pick<pg.Pool, 'query'>, userId: string): Promise<bigint> {
  const { rows } = await db.query<{ id: bigint }>(`SELECT id FROM accounts WHERE user_id = $1`, [userId]);
  if (!rows[0]) throw new Error('conta do jogador ausente');
  return rows[0].id;
}

/** Saldo de uma conta de sistema = soma dos lançamentos. */
export async function systemBalance(db: Pick<pg.Pool, 'query'>, accountId: bigint): Promise<bigint> {
  const { rows } = await db.query<{ s: string }>(
    `SELECT coalesce(sum(amount), 0)::text AS s FROM ledger_entries WHERE account_id = $1`,
    [accountId.toString()],
  );
  return BigInt(rows[0]?.s ?? '0');
}

export interface Entry {
  account: bigint;
  amount: bigint;
}

export interface PostInput {
  kind: TxKind;
  userId: string | null;
  lotId: string | null;
  /** valor principal (informativo, ex.: preço do imóvel; na renda = bruto emitido) */
  amount: bigint;
  entries: Entry[];
}

/**
 * Lança uma transação. As contas de jogador envolvidas já devem estar
 * travadas com lockAccounts. Lançamentos zerados são descartados; a soma
 * precisa ser zero.
 */
export async function post(c: pg.PoolClient, input: PostInput): Promise<bigint> {
  const merged = new Map<bigint, bigint>();
  for (const e of input.entries) merged.set(e.account, (merged.get(e.account) ?? 0n) + e.amount);
  const entries = [...merged].filter(([, a]) => a !== 0n);
  const sum = entries.reduce((s, [, a]) => s + a, 0n);
  if (sum !== 0n || entries.length < 2) throw new Error(`lançamento desbalanceado (${input.kind})`);
  const { rows } = await c.query<{ id: bigint }>(
    `INSERT INTO ledger_transactions (kind, user_id, lot_id, amount) VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.kind, input.userId, input.lotId, input.amount.toString()],
  );
  const txId = rows[0]!.id;
  try {
    await c.query(
      `INSERT INTO ledger_entries (tx_id, account_id, amount)
       SELECT $1, a, m FROM unnest($2::bigint[], $3::bigint[]) AS t(a, m)`,
      [txId.toString(), entries.map(([a]) => a.toString()), entries.map(([, m]) => m.toString())],
    );
  } catch (err) {
    // CHECK (balance >= 0) da conta do jogador: última barreira contra saldo negativo
    if ((err as { constraint?: string }).constraint === 'accounts_player_nonnegative') {
      throw new AppError(409, 'INSUFFICIENT_FUNDS', 'Saldo insuficiente.');
    }
    throw err;
  }
  return txId;
}

export function requireFunds(acc: LockedAccount | undefined, amount: bigint): void {
  if (!acc || acc.balance < amount) throw new AppError(409, 'INSUFFICIENT_FUNDS', 'Saldo insuficiente.');
}
