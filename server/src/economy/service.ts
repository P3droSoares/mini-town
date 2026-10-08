/**
 * Operações econômicas. Cada função roda dentro da transação aberta pelo
 * runner e recebe só intenções do cliente (lotId, listingId, tipo, preço
 * pedido); preço, saldo, dono e horário são sempre do servidor.
 *
 * Ordem das travas: imóveis (lot_id ↑) → anúncio → contas de jogador (id ↑)
 * → usuários → índice de mercado (sempre por último, depois das respostas).
 */
import type pg from 'pg';
import { audit } from '../audit.js';
import { AppError, conflict, forbidden, notFound } from '../http/errors.js';
import { ECONOMY, type BusinessType, type Category } from './config.js';
import { bumpIndex, readRefPrice } from './indices.js';
import { lockAccounts, post, requireFunds, type Entry, type LockedAccount, type SystemAccounts } from './ledger.js';
import {
  askRange,
  businessOpenCost,
  businessUpgradeCost,
  cityPrice,
  demandWeight,
  marketFee,
  mulFrac,
  sellToCityPrice,
} from './pricing.js';
import {
  isStarterEligible,
  ownedCount,
  ownedPropertyRows,
  pendingFor,
  propertyRecord,
  propertyView,
  walletView,
  type PropertyRecord,
} from './views.js';

export interface EconCtx {
  sys: SystemAccounts;
  userId: string;
  accountId: bigint;
  ipHmac: Buffer | null;
  /** relógio lido DEPOIS das travas do usuário (nunca retrocede entre operações dele) */
  now: Date;
}

const DAY = 86_400_000;

interface LockedProperty {
  lotId: string;
  category: Category;
  sellable: boolean;
  retired: boolean;
  ownerId: string | null;
  lockedUntil: Date | null;
}

/** Trava imóveis em ordem de lot_id. Ausente = 404. */
async function lockProperties(c: pg.PoolClient, lotIds: string[]): Promise<Map<string, LockedProperty>> {
  const ids = [...new Set(lotIds)].sort();
  const { rows } = await c.query<{
    lot_id: string;
    category: Category;
    sellable: boolean;
    retired_at: Date | null;
    owner_id: string | null;
    locked_until: Date | null;
  }>(
    `SELECT lot_id, category, sellable, retired_at, owner_id, locked_until
       FROM properties WHERE lot_id = ANY($1::text[]) ORDER BY lot_id FOR UPDATE`,
    [ids],
  );
  if (rows.length !== ids.length) throw notFound('Imóvel não encontrado.');
  return new Map(
    rows.map((r) => [
      r.lot_id,
      {
        lotId: r.lot_id,
        category: r.category,
        sellable: r.sellable,
        retired: r.retired_at !== null,
        ownerId: r.owner_id,
        lockedUntil: r.locked_until,
      },
    ]),
  );
}

async function lockProperty(c: pg.PoolClient, lotId: string): Promise<LockedProperty> {
  return (await lockProperties(c, [lotId])).get(lotId)!;
}

function requireOwner(p: LockedProperty, ctx: EconCtx): void {
  if (p.ownerId !== ctx.userId) throw forbidden('Você não é dono deste imóvel.', 'NOT_OWNER');
}

function requireUnlocked(p: LockedProperty, ctx: EconCtx): void {
  if (p.lockedUntil && p.lockedUntil > ctx.now) {
    throw conflict('PROPERTY_LOCKED', 'A casa inicial só pode ser vendida após o período de carência.');
  }
}

async function record(c: pg.PoolClient, lotId: string): Promise<PropertyRecord> {
  const r = await propertyRecord(c, lotId);
  if (!r) throw notFound('Imóvel não encontrado.');
  return r;
}

/** Dívida de IPTU do usuário (sem trava: só operações do próprio usuário a alteram). */
async function taxDebt(c: pg.PoolClient, userId: string): Promise<bigint> {
  const { rows } = await c.query<{ tax_debt: bigint }>('SELECT tax_debt FROM users WHERE id = $1', [userId]);
  return rows[0]?.tax_debt ?? 0n;
}

async function requireNoDebt(c: pg.PoolClient, userId: string): Promise<void> {
  if ((await taxDebt(c, userId)) > 0n) {
    throw conflict('TAX_DEBT', 'Há IPTU atrasado. Colete a renda ou venda um imóvel para quitar antes.');
  }
}

/** Conta nova não negocia com outros jogadores (contra contas descartáveis). */
async function requireMarketAccess(c: pg.PoolClient, userId: string, now: Date): Promise<void> {
  const { rows } = await c.query<{ created_at: Date }>('SELECT created_at FROM users WHERE id = $1', [userId]);
  const days = ECONOMY.market.minAccountAgeDays;
  const created = rows[0]?.created_at;
  if (!created || created.getTime() + days * DAY > now.getTime()) {
    throw conflict('ACCOUNT_TOO_NEW', `Contas novas só negociam com outros jogadores depois de ${days} dias.`);
  }
}

/** Atualiza o saldo em memória das contas travadas após um lançamento. */
function applyLocal(accts: Map<bigint, LockedAccount>, entries: Entry[]): void {
  for (const e of entries) {
    const a = accts.get(e.account);
    if (a) a.balance += e.amount;
  }
}

async function postAndApply(
  c: pg.PoolClient,
  accts: Map<bigint, LockedAccount>,
  input: Parameters<typeof post>[1],
): Promise<void> {
  await post(c, input);
  applyLocal(accts, input.entries);
}

/**
 * Liquida renda/IPTU pendentes de imóveis do jogador antes de qualquer mudança
 * que altere a renda (venda, negócio, residência). Exige a conta do jogador
 * travada. O IPTU (mais a dívida anterior) é pago com saldo + renda; o que não
 * couber vira dívida (users.tax_debt), cobrada antes de qualquer renda futura.
 */
async function settle(
  c: pg.PoolClient,
  ctx: EconCtx,
  accountId: bigint,
  userId: string,
  records: PropertyRecord[],
  accts: Map<bigint, LockedAccount>,
): Promise<{ gross: bigint; tax: bigint; debt: bigint }> {
  const withAccrual = records.filter((r) => r.ownerId === userId && r.lastCollectedAt);
  const { rows } = await c.query<{ tax_debt: bigint }>('SELECT tax_debt FROM users WHERE id = $1 FOR UPDATE', [userId]);
  const debt = rows[0]?.tax_debt ?? 0n;
  const p = withAccrual.length
    ? pendingFor(withAccrual, ctx.now, await ownedCount(c, userId))
    : { gross: 0n, tax: 0n, perLot: new Map<string, { until: Date }>() };
  const balance = accts.get(accountId)?.balance ?? 0n;
  const due = p.tax + debt;
  const avail = balance + p.gross;
  const paid = due > avail ? avail : due;
  const newDebt = due - paid;
  if (p.gross !== 0n || paid !== 0n) {
    const lotId = withAccrual.length === 1 ? withAccrual[0]!.lotId : null;
    await postAndApply(c, accts, {
      kind: 'income',
      userId,
      lotId,
      amount: p.gross,
      entries: [
        { account: accountId, amount: p.gross - paid },
        { account: ctx.sys.TESOURO, amount: -p.gross },
        { account: ctx.sys.IMPOSTOS, amount: paid },
      ],
    });
  }
  if (withAccrual.length) {
    // o relógio avança só o tempo cobrado (resto de centavo fica para a próxima
    // coleta: coletas seguidas não zeram o IPTU por arredondamento).
    // GREATEST: uma coleta atrasada na fila nunca volta o relógio do imóvel
    const lots = withAccrual.map((r) => r.lotId);
    const until = withAccrual.map((r) => p.perLot.get(r.lotId)?.until ?? r.lastCollectedAt!);
    await c.query(
      `UPDATE properties p SET last_collected_at = GREATEST(p.last_collected_at, u.until)
         FROM unnest($1::text[], $2::timestamptz[]) AS u(lot_id, until)
        WHERE p.lot_id = u.lot_id AND p.owner_id = $3`,
      [lots, until, userId],
    );
  }
  if (newDebt !== debt) await c.query('UPDATE users SET tax_debt = $2 WHERE id = $1', [userId, newDebt.toString()]);
  return { gross: p.gross, tax: paid, debt: newDebt };
}

/** Variação do índice ponderada pelo valor da operação. */
async function demandDelta(c: pg.PoolClient, category: Category, bp: number, price: bigint): Promise<number> {
  return bp * demandWeight(price, await readRefPrice(c, category));
}

const result = (status: number, body: unknown) => ({ status, body });

// ---------------------------------------------------------------- casa inicial
export async function claimStarterHome(c: pg.PoolClient, ctx: EconCtx, lotId: string) {
  const prop = await lockProperty(c, lotId);
  const already = await c.query('SELECT 1 FROM starter_claims WHERE user_id = $1', [ctx.userId]);
  if (already.rowCount) throw conflict('STARTER_ALREADY_CLAIMED', 'Você já recebeu sua casa inicial.');
  const rec = await record(c, lotId);
  if (!prop.sellable || prop.retired || prop.ownerId !== null || !isStarterEligible(prop.category, rec.basePrice)) {
    throw conflict('NOT_ELIGIBLE', 'Este imóvel não é elegível como casa inicial.');
  }
  const S = ECONOMY.starter;
  const price = rec.appraisal;
  const subsidy = mulFrac(price, S.subsidy);
  const pays = price - subsidy;
  const accts = await lockAccounts(c, [ctx.accountId]);
  requireFunds(accts.get(ctx.accountId), pays);
  await postAndApply(c, accts, {
    kind: 'starter_home',
    userId: ctx.userId,
    lotId,
    amount: price,
    entries: [
      { account: ctx.accountId, amount: -pays },
      { account: ctx.sys.TESOURO, amount: -subsidy },
      { account: ctx.sys.GOVERNO, amount: price },
    ],
  });
  await c.query(
    `INSERT INTO starter_claims (user_id, lot_id, claimed_at, price, subsidy, encumbered_until)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ctx.userId, lotId, ctx.now, price.toString(), subsidy.toString(), new Date(ctx.now.getTime() + S.encumbranceDays * DAY)],
  );
  // preço de aquisição = o que o jogador pagou: o subsídio nunca vira lucro na venda ao governo
  await c.query(
    `UPDATE properties SET owner_id = $2, acquired_at = $3, last_collected_at = $3, locked_until = $4, acquired_price = $5
      WHERE lot_id = $1`,
    [lotId, ctx.userId, ctx.now, new Date(ctx.now.getTime() + S.lockDays * DAY), pays.toString()],
  );
  // vira residência só se o jogador ainda não mora em outro imóvel (não altera renda alheia)
  await c.query('UPDATE users SET residence_lot_id = $2 WHERE id = $1 AND residence_lot_id IS NULL', [ctx.userId, lotId]);
  await audit(c, 'starter_claimed', ctx.userId, ctx.ipHmac, { lotId, price, subsidy });
  return result(200, {
    property: await propertyView(c, lotId, ctx.userId, ctx.now),
    wallet: await walletView(c, ctx.userId, ctx.now),
  });
}

// ---------------------------------------------------------------- governo
export async function buyFromCity(c: pg.PoolClient, ctx: EconCtx, lotId: string) {
  const prop = await lockProperty(c, lotId);
  if (!prop.sellable || prop.retired) throw conflict('NOT_SELLABLE', 'Este imóvel não pode ser comprado.');
  if (prop.ownerId !== null) throw conflict('ALREADY_OWNED', 'Este imóvel já tem dono.');
  await requireNoDebt(c, ctx.userId);
  const quota = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_transactions
      WHERE user_id = $1 AND kind = 'city_purchase' AND created_at > $2`,
    [ctx.userId, new Date(ctx.now.getTime() - DAY)],
  );
  if ((quota.rows[0]?.n ?? 0) >= ECONOMY.city.dailyPurchaseQuota) {
    throw conflict('CITY_PURCHASE_QUOTA', 'Limite diário de compras à prefeitura atingido. Tente amanhã.');
  }
  const rec = await record(c, lotId);
  const owned = await ownedCount(c, ctx.userId);
  if (isStarterEligible(prop.category, rec.basePrice) && owned >= ECONOMY.starter.reserveMaxOwned) {
    throw conflict('STARTER_RESERVED', 'Casas de entrada ficam reservadas para quem ainda tem poucos imóveis.');
  }
  const price = cityPrice(rec.appraisal, owned);
  const accts = await lockAccounts(c, [ctx.accountId]);
  requireFunds(accts.get(ctx.accountId), price);
  await postAndApply(c, accts, {
    kind: 'city_purchase',
    userId: ctx.userId,
    lotId,
    amount: price,
    entries: [
      { account: ctx.accountId, amount: -price },
      { account: ctx.sys.GOVERNO, amount: price },
    ],
  });
  await c.query(
    `UPDATE properties SET owner_id = $2, acquired_at = $3, last_collected_at = $3, locked_until = NULL, acquired_price = $4
      WHERE lot_id = $1`,
    [lotId, ctx.userId, ctx.now, price.toString()],
  );
  await audit(c, 'city_purchase', ctx.userId, ctx.ipHmac, { lotId, price });
  const body = {
    property: await propertyView(c, lotId, ctx.userId, ctx.now),
    wallet: await walletView(c, ctx.userId, ctx.now),
  };
  await bumpIndex(c, prop.category, await demandDelta(c, prop.category, ECONOMY.index.buyFromCityBp, rec.appraisal), ctx.now);
  return result(200, body);
}

export async function sellToCity(c: pg.PoolClient, ctx: EconCtx, lotId: string) {
  const prop = await lockProperty(c, lotId);
  requireOwner(prop, ctx);
  requireUnlocked(prop, ctx);
  const listed = await c.query(`SELECT 1 FROM listings WHERE lot_id = $1 AND status = 'active' FOR UPDATE`, [lotId]);
  if (listed.rowCount) throw conflict('PROPERTY_LISTED', 'Cancele o anúncio antes de vender ao governo.');
  const rec = await record(c, lotId);
  // 70% do menor valor entre avaliação atual e preço pago: subir o índice não gera lucro
  const price = sellToCityPrice(rec.appraisal, rec.acquiredPrice);
  const accts = await lockAccounts(c, [ctx.accountId]);
  const s = await settle(c, ctx, ctx.accountId, ctx.userId, [rec], accts);
  const debtPaid = s.debt < price ? s.debt : price;
  await postAndApply(c, accts, {
    kind: 'city_sale',
    userId: ctx.userId,
    lotId,
    amount: price,
    entries: [
      { account: ctx.sys.GOVERNO, amount: -price },
      { account: ctx.accountId, amount: price - debtPaid },
      { account: ctx.sys.IMPOSTOS, amount: debtPaid },
    ],
  });
  if (debtPaid > 0n) await c.query('UPDATE users SET tax_debt = tax_debt - $2 WHERE id = $1', [ctx.userId, debtPaid.toString()]);
  await c.query('DELETE FROM businesses WHERE lot_id = $1', [lotId]);
  await c.query(
    `UPDATE properties SET owner_id = NULL, acquired_at = NULL, last_collected_at = NULL, locked_until = NULL,
            acquired_price = NULL WHERE lot_id = $1`,
    [lotId],
  );
  await c.query('UPDATE users SET residence_lot_id = NULL WHERE id = $1 AND residence_lot_id = $2', [ctx.userId, lotId]);
  // a casa volta a poder ser casa inicial de outro jogador
  await c.query('UPDATE starter_claims SET released_at = $3 WHERE user_id = $1 AND lot_id = $2 AND released_at IS NULL', [
    ctx.userId,
    lotId,
    ctx.now,
  ]);
  await audit(c, 'city_sale', ctx.userId, ctx.ipHmac, { lotId, price, debtPaid });
  const body = { wallet: await walletView(c, ctx.userId, ctx.now) };
  await bumpIndex(c, prop.category, await demandDelta(c, prop.category, ECONOMY.index.sellToCityBp, rec.appraisal), ctx.now);
  return result(200, body);
}

// ---------------------------------------------------------------- residência
export async function setResidence(c: pg.PoolClient, ctx: EconCtx, lotId: string) {
  // o runner já serializa as operações do usuário (advisory lock): a leitura é estável
  const { rows } = await c.query<{ residence_lot_id: string | null }>('SELECT residence_lot_id FROM users WHERE id = $1', [
    ctx.userId,
  ]);
  const current = rows[0]?.residence_lot_id ?? null;
  const locked = await lockProperties(c, current && current !== lotId ? [lotId, current] : [lotId]);
  const prop = locked.get(lotId)!;
  requireOwner(prop, ctx);
  if (prop.category !== 'residential') throw conflict('NOT_RESIDENTIAL', 'Só é possível morar em imóvel residencial.');
  if (current !== lotId) {
    // renda e IPTU mudam nos dois imóveis: liquida antes
    const recs: PropertyRecord[] = [];
    for (const id of locked.keys()) recs.push(await record(c, id));
    const accts = await lockAccounts(c, [ctx.accountId]);
    await settle(c, ctx, ctx.accountId, ctx.userId, recs, accts);
    await c.query('UPDATE users SET residence_lot_id = $2 WHERE id = $1', [ctx.userId, lotId]);
    await audit(c, 'residence_set', ctx.userId, ctx.ipHmac, { lotId });
  }
  return result(200, { property: await propertyView(c, lotId, ctx.userId, ctx.now) });
}

// ---------------------------------------------------------------- negócios
async function requireCommercialOwner(c: pg.PoolClient, ctx: EconCtx, lotId: string) {
  const prop = await lockProperty(c, lotId);
  requireOwner(prop, ctx);
  if (prop.category !== 'commercial') throw conflict('NOT_COMMERCIAL', 'Negócios só podem ser abertos em imóvel comercial.');
  return { prop, rec: await record(c, lotId) };
}

export async function openBusiness(c: pg.PoolClient, ctx: EconCtx, lotId: string, type: BusinessType) {
  const { rec } = await requireCommercialOwner(c, ctx, lotId);
  if (rec.business) throw conflict('BUSINESS_EXISTS', 'Este imóvel já tem um negócio.');
  const cost = businessOpenCost(rec.appraisal);
  const accts = await lockAccounts(c, [ctx.accountId]);
  const s = await settle(c, ctx, ctx.accountId, ctx.userId, [rec], accts);
  if (s.debt > 0n) throw conflict('TAX_DEBT', 'Há IPTU atrasado. Quite antes de investir.');
  requireFunds(accts.get(ctx.accountId), cost);
  await postAndApply(c, accts, {
    kind: 'business_open',
    userId: ctx.userId,
    lotId,
    amount: cost,
    entries: [
      { account: ctx.accountId, amount: -cost },
      { account: ctx.sys.GOVERNO, amount: cost },
    ],
  });
  await c.query('INSERT INTO businesses (lot_id, type, opened_at, updated_at) VALUES ($1, $2, $3, $3)', [lotId, type, ctx.now]);
  await audit(c, 'business_opened', ctx.userId, ctx.ipHmac, { lotId, type, cost });
  return result(200, {
    property: await propertyView(c, lotId, ctx.userId, ctx.now),
    wallet: await walletView(c, ctx.userId, ctx.now),
  });
}

export async function upgradeBusiness(c: pg.PoolClient, ctx: EconCtx, lotId: string) {
  const { rec } = await requireCommercialOwner(c, ctx, lotId);
  if (!rec.business) throw conflict('NO_BUSINESS', 'Este imóvel não tem negócio aberto.');
  const cost = businessUpgradeCost(rec.appraisal, rec.business.level);
  if (cost === null) throw conflict('MAX_LEVEL', 'O negócio já está no nível máximo.');
  const accts = await lockAccounts(c, [ctx.accountId]);
  const s = await settle(c, ctx, ctx.accountId, ctx.userId, [rec], accts);
  if (s.debt > 0n) throw conflict('TAX_DEBT', 'Há IPTU atrasado. Quite antes de investir.');
  requireFunds(accts.get(ctx.accountId), cost);
  await postAndApply(c, accts, {
    kind: 'business_upgrade',
    userId: ctx.userId,
    lotId,
    amount: cost,
    entries: [
      { account: ctx.accountId, amount: -cost },
      { account: ctx.sys.GOVERNO, amount: cost },
    ],
  });
  await c.query('UPDATE businesses SET level = level + 1, updated_at = $2 WHERE lot_id = $1', [lotId, ctx.now]);
  await audit(c, 'business_upgraded', ctx.userId, ctx.ipHmac, { lotId, level: rec.business.level + 1, cost });
  return result(200, {
    property: await propertyView(c, lotId, ctx.userId, ctx.now),
    wallet: await walletView(c, ctx.userId, ctx.now),
  });
}

/** Fecha o negócio (sem reembolso): permite trocar de tipo abrindo outro. */
export async function closeBusiness(c: pg.PoolClient, ctx: EconCtx, lotId: string) {
  const { rec } = await requireCommercialOwner(c, ctx, lotId);
  if (!rec.business) throw conflict('NO_BUSINESS', 'Este imóvel não tem negócio aberto.');
  const accts = await lockAccounts(c, [ctx.accountId]);
  await settle(c, ctx, ctx.accountId, ctx.userId, [rec], accts);
  await c.query('DELETE FROM businesses WHERE lot_id = $1', [lotId]);
  await audit(c, 'business_closed', ctx.userId, ctx.ipHmac, { lotId, type: rec.business.type, level: rec.business.level });
  return result(200, {
    property: await propertyView(c, lotId, ctx.userId, ctx.now),
    wallet: await walletView(c, ctx.userId, ctx.now),
  });
}

// ---------------------------------------------------------------- renda
export async function collectIncome(c: pg.PoolClient, ctx: EconCtx) {
  // trava todos os imóveis do jogador (ordem de lot_id) e relê com os dados já travados
  await c.query('SELECT lot_id FROM properties WHERE owner_id = $1 ORDER BY lot_id FOR UPDATE', [ctx.userId]);
  const { records: recs } = await ownedPropertyRows(c, ctx.userId, ctx.now);
  const accts = await lockAccounts(c, [ctx.accountId]);
  const { gross, tax, debt } = await settle(c, ctx, ctx.accountId, ctx.userId, recs, accts);
  if (gross !== 0n || tax !== 0n) {
    await audit(c, 'income_collected', ctx.userId, ctx.ipHmac, { gross, tax, debt, lots: recs.length });
  }
  return result(200, {
    collected: gross.toString(),
    tax: tax.toString(),
    wallet: await walletView(c, ctx.userId, ctx.now),
  });
}

// ---------------------------------------------------------------- mercado entre jogadores
export interface ListingView {
  id: string;
  lotId: string;
  category: Category;
  address: string | null;
  area: number;
  levels: number;
  askPrice: string;
  appraisal: string;
  seller: { displayName: string };
  mine: boolean;
  createdAt: string;
}

export async function listingView(db: pg.PoolClient | pg.Pool, id: string, viewerId: string | null): Promise<ListingView | null> {
  const { rows } = await db.query<ListingRow>(`${SELECT_LISTING} WHERE l.id = $1`, [id]);
  return rows[0] ? toListingView(rows[0], viewerId) : null;
}

export interface ListingRow {
  seq: bigint;
  id: string;
  lot_id: string;
  category: Category;
  address: string | null;
  area_m2: string;
  levels: number;
  ask_price: bigint;
  base_price: bigint;
  index_bp: number;
  seller_id: string;
  seller_name: string;
  created_at: Date;
}

export const SELECT_LISTING = `
  SELECT l.seq, l.id, l.lot_id, p.category, p.address, p.area_m2::text AS area_m2, p.levels, l.ask_price,
         p.base_price, mi.index_bp, l.seller_id, u.display_name AS seller_name, l.created_at
    FROM listings l
    JOIN properties p ON p.lot_id = l.lot_id
    JOIN market_indices mi ON mi.category = p.category
    JOIN users u ON u.id = l.seller_id`;

/** Condição SQL: anúncio ainda dentro da faixa (com tolerância) para o índice atual. */
export const LISTING_IN_RANGE = (() => {
  const M = ECONOMY.market;
  const lo = Math.round(M.minAskRatio * (1 - M.buyTolerance) * 1_000_000);
  const hi = Math.round(M.maxAskRatio * (1 + M.buyTolerance) * 1_000_000);
  const appr = `(p.base_price * mi.index_bp / ${ECONOMY.index.baseBp})`;
  return `l.ask_price * 1000000 BETWEEN ${appr} * ${lo} AND ${appr} * ${hi}`;
})();

export function toListingView(r: ListingRow, viewerId: string | null): ListingView {
  return {
    id: r.id,
    lotId: r.lot_id,
    category: r.category,
    address: r.address,
    area: Number(r.area_m2),
    levels: r.levels,
    askPrice: r.ask_price.toString(),
    appraisal: ((r.base_price * BigInt(r.index_bp)) / BigInt(ECONOMY.index.baseBp)).toString(),
    seller: { displayName: r.seller_name },
    mine: viewerId !== null && r.seller_id === viewerId,
    createdAt: r.created_at.toISOString(),
  };
}

export async function createListing(c: pg.PoolClient, ctx: EconCtx, lotId: string, askPrice: bigint) {
  const prop = await lockProperty(c, lotId);
  requireOwner(prop, ctx);
  requireUnlocked(prop, ctx);
  await requireMarketAccess(c, ctx.userId, ctx.now);
  await requireNoDebt(c, ctx.userId);
  const existing = await c.query(`SELECT 1 FROM listings WHERE lot_id = $1 AND status = 'active'`, [lotId]);
  if (existing.rowCount) throw conflict('ALREADY_LISTED', 'Este imóvel já está anunciado.');
  const rec = await record(c, lotId);
  const range = askRange(rec.appraisal);
  if (askPrice < range.min || askPrice > range.max) {
    const M = ECONOMY.market;
    throw new AppError(
      422,
      'ASK_OUT_OF_RANGE',
      `O preço precisa ficar entre ${range.min.toString()} e ${range.max.toString()} centavos ` +
        `(${Math.round(M.minAskRatio * 100)}% a ${Math.round(M.maxAskRatio * 100)}% da avaliação).`,
    );
  }
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO listings (lot_id, seller_id, ask_price, created_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [lotId, ctx.userId, askPrice.toString(), ctx.now],
  );
  const id = rows[0]!.id;
  await audit(c, 'listing_created', ctx.userId, ctx.ipHmac, { lotId, listingId: id, askPrice });
  return result(201, await listingView(c, id, ctx.userId));
}

async function lockListing(c: pg.PoolClient, listingId: string) {
  // descobre o imóvel sem trava, trava imóvel → anúncio (ordem global) e revalida
  const pre = await c.query<{ lot_id: string }>('SELECT lot_id FROM listings WHERE id = $1', [listingId]);
  if (!pre.rows[0]) throw notFound('Anúncio não encontrado.');
  const prop = await lockProperty(c, pre.rows[0].lot_id);
  const { rows } = await c.query<{ lot_id: string; seller_id: string; ask_price: bigint; status: string; created_at: Date }>(
    'SELECT lot_id, seller_id, ask_price, status, created_at FROM listings WHERE id = $1 FOR UPDATE',
    [listingId],
  );
  return { prop, listing: rows[0]! };
}

export async function cancelListing(c: pg.PoolClient, ctx: EconCtx, listingId: string) {
  const { listing } = await lockListing(c, listingId);
  if (listing.seller_id !== ctx.userId) throw forbidden('Este anúncio não é seu.', 'NOT_OWNER');
  if (listing.status !== 'active') throw conflict('LISTING_UNAVAILABLE', 'Este anúncio não está mais ativo.');
  await c.query(`UPDATE listings SET status = 'cancelled', closed_at = $2 WHERE id = $1`, [listingId, ctx.now]);
  await audit(c, 'listing_cancelled', ctx.userId, ctx.ipHmac, { listingId, lotId: listing.lot_id });
  return result(204, null);
}

/** Contas que usaram a mesma rede (/64 no IPv6) na janela não negociam entre si. */
async function linkedAccounts(c: pg.PoolClient, a: string, b: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - ECONOMY.market.linkWindowDays * DAY);
  const { rows } = await c.query<{ linked: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM user_ips x JOIN user_ips y ON y.net_hmac = x.net_hmac
        WHERE x.user_id = $1 AND y.user_id = $2 AND x.last_seen_at > $3 AND y.last_seen_at > $3
     ) AS linked`,
    [a, b, since],
  );
  return rows[0]?.linked ?? false;
}

/** Já houve negócio entre o par (em qualquer sentido) na janela? */
async function recentPairDeal(c: pg.PoolClient, a: string, b: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - ECONOMY.market.pairCooldownDays * DAY);
  const { rows } = await c.query<{ hit: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM listings
        WHERE status = 'sold' AND closed_at > $3
          AND ((seller_id = $1 AND buyer_id = $2) OR (seller_id = $2 AND buyer_id = $1))
     ) AS hit`,
    [a, b, since],
  );
  return rows[0]?.hit ?? false;
}

export async function buyListing(c: pg.PoolClient, ctx: EconCtx, listingId: string) {
  const M = ECONOMY.market;
  const { prop, listing } = await lockListing(c, listingId);
  const expired = listing.created_at.getTime() + M.listingTtlDays * DAY <= ctx.now.getTime();
  if (listing.status !== 'active' || expired) throw conflict('LISTING_UNAVAILABLE', 'Este anúncio não está mais ativo.');
  if (listing.seller_id === ctx.userId) throw conflict('OWN_LISTING', 'Você não pode comprar o próprio anúncio.');
  if (prop.ownerId !== listing.seller_id) throw conflict('LISTING_UNAVAILABLE', 'Este anúncio não está mais ativo.');
  await requireMarketAccess(c, ctx.userId, ctx.now);
  await requireNoDebt(c, ctx.userId);
  if (await linkedAccounts(c, ctx.userId, listing.seller_id, ctx.now)) {
    throw conflict('MARKET_LINKED_ACCOUNTS', 'Negócio bloqueado: as contas usaram a mesma rede recentemente.');
  }
  if (await recentPairDeal(c, ctx.userId, listing.seller_id, ctx.now)) {
    throw conflict('MARKET_PAIR_COOLDOWN', `Vocês já negociaram nos últimos ${M.pairCooldownDays} dias.`);
  }
  const rec = await record(c, prop.lotId);
  const ask = listing.ask_price;
  const range = askRange(rec.appraisal, M.buyTolerance);
  // índice pode ter mudado desde o anúncio: mantém a trava anti-lavagem (com tolerância)
  if (ask < range.min || ask > range.max) {
    throw conflict('LISTING_PRICE_OUT_OF_RANGE', 'O preço deste anúncio saiu da faixa permitida.');
  }
  // revenda rápida do mesmo imóvel não conta como demanda (lavagem de índice)
  const resale = await c.query<{ hit: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ledger_transactions WHERE lot_id = $1 AND kind = 'market_sale' AND created_at > $2) AS hit`,
    [prop.lotId, new Date(ctx.now.getTime() - ECONOMY.index.resaleIgnoreHours * 3_600_000)],
  );
  const { rows: sellerAcc } = await c.query<{ id: bigint }>('SELECT id FROM accounts WHERE user_id = $1', [
    listing.seller_id,
  ]);
  const sellerAccount = sellerAcc[0]!.id;
  const accts = await lockAccounts(c, [ctx.accountId, sellerAccount]);
  requireFunds(accts.get(ctx.accountId), ask);
  // o vendedor recebe a renda pendente do imóvel até a venda (e paga o IPTU dele)
  const s = await settle(c, ctx, sellerAccount, listing.seller_id, [rec], accts);
  const fee = marketFee(ask, rec.appraisal);
  let net = ask - fee;
  // gravame da casa inicial: o subsídio volta ao Tesouro na venda a outro jogador
  const subsidyDue = rec.starter && rec.ownerId === listing.seller_id ? rec.starter.subsidyDue : 0n;
  const repay = subsidyDue < net ? subsidyDue : net;
  net -= repay;
  const debtPaid = s.debt < net ? s.debt : net;
  await postAndApply(c, accts, {
    kind: 'market_sale',
    userId: ctx.userId,
    lotId: prop.lotId,
    amount: ask,
    entries: [
      { account: ctx.accountId, amount: -ask },
      { account: sellerAccount, amount: net - debtPaid },
      { account: ctx.sys.TAXAS, amount: fee },
      { account: ctx.sys.TESOURO, amount: repay },
      { account: ctx.sys.IMPOSTOS, amount: debtPaid },
    ],
  });
  await c.query(`UPDATE listings SET status = 'sold', buyer_id = $2, closed_at = $3 WHERE id = $1`, [
    listingId,
    ctx.userId,
    ctx.now,
  ]);
  await c.query(
    `UPDATE properties SET owner_id = $2, acquired_at = $3, last_collected_at = $3, locked_until = NULL, acquired_price = $4
      WHERE lot_id = $1`,
    [prop.lotId, ctx.userId, ctx.now, ask.toString()],
  );
  await c.query(
    `UPDATE starter_claims SET released_at = $3, subsidy_repaid = subsidy_repaid + $4
      WHERE user_id = $1 AND lot_id = $2 AND released_at IS NULL`,
    [listing.seller_id, prop.lotId, ctx.now, repay.toString()],
  );
  if (debtPaid > 0n) {
    await c.query('UPDATE users SET tax_debt = tax_debt - $2 WHERE id = $1', [listing.seller_id, debtPaid.toString()]);
  }
  await c.query('UPDATE users SET residence_lot_id = NULL WHERE id = $1 AND residence_lot_id = $2', [
    listing.seller_id,
    prop.lotId,
  ]);
  await audit(c, 'market_sale', ctx.userId, ctx.ipHmac, { listingId, lotId: prop.lotId, price: ask, fee, repay });
  const body = {
    property: await propertyView(c, prop.lotId, ctx.userId, ctx.now),
    wallet: await walletView(c, ctx.userId, ctx.now),
  };
  // demanda só de venda "de verdade": perto da avaliação e sem revenda rápida
  const counts = !resale.rows[0]?.hit && ask >= mulFrac(rec.appraisal, ECONOMY.index.marketSaleMinRatio);
  if (counts) await bumpIndex(c, prop.category, await demandDelta(c, prop.category, ECONOMY.index.marketSaleBp, ask), ctx.now);
  return result(200, body);
}
