import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ECONOMY } from '../src/economy/config.js';
import { accrual, appraisal, businessOpenCost, marketFee, mulFrac, sellToCityPrice } from '../src/economy/pricing.js';
import {
  ageAccount,
  balanceOf,
  drain,
  call,
  freeLots,
  grant,
  makeApp,
  register,
  systemBalance,
  type TestApp,
} from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => {
  await t.close();
});

const appraisalOf = async (lotId: string) => {
  const p = await register(t.app);
  return BigInt((await call(t.app, p, 'GET', `/api/properties/${lotId}`)).json().appraisal);
};

describe('casa inicial', () => {
  it('lista até 30 casas elegíveis com avaliação ≤ teto', async () => {
    const p = await register(t.app);
    const res = await call(t.app, p, 'GET', '/api/starter-homes');
    expect(res.statusCode).toBe(200);
    const homes = res.json().homes;
    expect(homes.length).toBeGreaterThan(0);
    expect(homes.length).toBeLessThanOrEqual(30);
    const { rows } = await t.owner.query<{ base_price: bigint }>('SELECT base_price FROM properties WHERE lot_id = ANY($1)', [
      homes.map((h: { lotId: string }) => h.lotId),
    ]);
    // elegibilidade pela avaliação BASE (o índice não esvazia a lista)
    for (const r of rows) expect(r.base_price).toBeLessThanOrEqual(ECONOMY.starter.maxBase);
    for (const h of homes) {
      expect(h.category).toBe('residential');
      expect(h.owner).toBeNull();
    }
  });

  it('subsídio de 80%: jogador paga 20%, só uma vez por conta', async () => {
    const p = await register(t.app);
    const homes = (await call(t.app, p, 'GET', '/api/starter-homes')).json().homes;
    const [h1, h2] = homes.slice(-2);
    const price = BigInt(h1.appraisal);
    const res = await call(t.app, p, 'POST', '/api/starter-homes/claim', { body: { lotId: h1.lotId } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const pays = price - mulFrac(price, 0.8);
    expect(BigInt(body.wallet.balance)).toBe(3_000_000n - pays);
    expect(body.wallet.starterAvailable).toBe(false);
    expect(body.property.mine).toBe(true);
    expect(body.property.isResidence).toBe(true);
    expect(body.property.lockedUntil).toBeTruthy();
    expect(body.property.incomePerHour).toBe('0');
    const again = await call(t.app, p, 'POST', '/api/starter-homes/claim', { body: { lotId: h2.lotId } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('STARTER_ALREADY_CLAIMED');
  });

  it('corrida: 10 pedidos simultâneos (chaves diferentes) da mesma conta = 1 casa', async () => {
    const p = await register(t.app);
    const homes = (await call(t.app, p, 'GET', '/api/starter-homes')).json().homes.filter((h: { owner: unknown }) => !h.owner);
    const res = await Promise.all(
      homes.slice(0, 10).map((h: { lotId: string }) => call(t.app, p, 'POST', '/api/starter-homes/claim', { body: { lotId: h.lotId } })),
    );
    expect(res.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const { rows } = await t.owner.query('SELECT count(*)::int AS n FROM starter_claims WHERE user_id = $1', [p.id]);
    expect(rows[0].n).toBe(1);
  });

  it('não aceita imóvel não elegível (comercial, caro, ou já com dono)', async () => {
    const p = await register(t.app);
    const [com] = await freeLots(t.owner, 'commercial', 1);
    expect((await call(t.app, p, 'POST', '/api/starter-homes/claim', { body: { lotId: com!.lotId } })).json().error.code).toBe('NOT_ELIGIBLE');
    const [big] = await freeLots(t.owner, 'residential', 1, { minBase: ECONOMY.starter.maxBase * 2n });
    expect((await call(t.app, p, 'POST', '/api/starter-homes/claim', { body: { lotId: big!.lotId } })).statusCode).toBe(409);
    expect((await call(t.app, p, 'POST', '/api/starter-homes/claim', { body: { lotId: 'ITB-NAOEXISTE1' } })).statusCode).toBe(404);
  });

  it('casa inicial fica travada para venda/anúncio durante a carência', async () => {
    const p = await register(t.app);
    const [h] = (await call(t.app, p, 'GET', '/api/starter-homes')).json().homes.slice(-3, -2);
    expect((await call(t.app, p, 'POST', '/api/starter-homes/claim', { body: { lotId: h.lotId } })).statusCode).toBe(200);
    const sell = await call(t.app, p, 'POST', `/api/properties/${h.lotId}/sell-to-city`);
    expect(sell.json().error.code).toBe('PROPERTY_LOCKED');
    const list = await call(t.app, p, 'POST', '/api/market/listings', { body: { lotId: h.lotId, askPrice: h.appraisal } });
    expect(list.json().error.code).toBe('PROPERTY_LOCKED');
  });
});

describe('governo', () => {
  it('compra ao governo pelo preço do servidor e vende por 70% da avaliação', async () => {
    const p = await register(t.app);
    await grant(t.owner, p.id, 100_000_000n);
    const [lot] = await freeLots(t.owner, 'industrial', 1, { maxBase: 50_000_000n });
    const before = await balanceOf(t.app, p);
    const view = (await call(t.app, p, 'GET', `/api/properties/${lot!.lotId}`)).json();
    expect(view.buyable).toBe(true);
    expect(view.cityPrice).toBe(view.appraisal);
    const buy = await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`);
    expect(buy.statusCode).toBe(200);
    const price = BigInt(view.appraisal);
    expect(BigInt(buy.json().wallet.balance)).toBe(before - price);
    expect(buy.json().property.owner.displayName).toBe(p.displayName);

    const appr = BigInt((await call(t.app, p, 'GET', `/api/properties/${lot!.lotId}`)).json().appraisal);
    const mid = await balanceOf(t.app, p);
    // segundos de IPTU podem ser cobrados na liquidação: tolerância pequena
    const sell = await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/sell-to-city`);
    expect(sell.statusCode).toBe(200);
    const got = BigInt(sell.json().wallet.balance) - mid;
    const d = mulFrac(appr < price ? appr : price, 0.7) - got;
    expect(d > -100n && d < 100n).toBe(true);
    expect((await call(t.app, p, 'GET', `/api/properties/${lot!.lotId}`)).json().owner).toBeNull();
  });

  it('saldo insuficiente = 409 sem mexer no saldo', async () => {
    const p = await register(t.app);
    const [lot] = await freeLots(t.owner, 'commercial', 1, { minBase: 10_000_000n });
    const res = await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(t.app, p)).toBe(3_000_000n);
  });

  it('institucional e religioso não são vendáveis', async () => {
    const p = await register(t.app);
    const { rows } = await t.owner.query(`SELECT lot_id FROM properties WHERE category IN ('institutional','religious') LIMIT 1`);
    const res = await call(t.app, p, 'POST', `/api/properties/${rows[0].lot_id}/buy`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_SELLABLE');
  });

  it('compras movem o índice de mercado dentro dos limites', async () => {
    // outros testes podem ter esgotado a variação da hora: começa de uma janela nova
    await t.owner.query(
      `UPDATE market_indices SET index_bp = 10000, anchor_bp = 10000, anchor_at = now(), updated_at = now() WHERE category = 'vacant'`,
    );
    const before = (await call(t.app, null, 'GET', '/api/market/overview')).json().indices.vacant;
    const p = await register(t.app);
    const lots = await freeLots(t.owner, 'vacant', 3, { maxBase: 500_000n });
    for (const l of lots) expect((await call(t.app, p, 'POST', `/api/properties/${l.lotId}/buy`)).statusCode).toBe(200);
    const after = (await call(t.app, null, 'GET', '/api/market/overview')).json().indices.vacant;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(before + ECONOMY.index.maxHourlyChangeBp / 10_000 + 1e-9);
  });
});

describe('mercado entre jogadores', () => {
  it('faixa de preço 80%–130% da avaliação', async () => {
    const s = await register(t.app);
    await ageAccount(t.owner, s.id);
    await grant(t.owner, s.id, 50_000_000n);
    const [lot] = await freeLots(t.owner, 'residential', 1, { maxBase: 10_000_000n });
    expect((await call(t.app, s, 'POST', `/api/properties/${lot!.lotId}/buy`)).statusCode).toBe(200);
    const appr = BigInt((await call(t.app, s, 'GET', `/api/properties/${lot!.lotId}`)).json().appraisal);
    const min = mulFrac(appr, ECONOMY.market.minAskRatio);
    const max = mulFrac(appr, ECONOMY.market.maxAskRatio);
    const low = await call(t.app, s, 'POST', '/api/market/listings', { body: { lotId: lot!.lotId, askPrice: (min - 1n).toString() } });
    expect(low.statusCode).toBe(422);
    expect(low.json().error.code).toBe('ASK_OUT_OF_RANGE');
    const high = await call(t.app, s, 'POST', '/api/market/listings', { body: { lotId: lot!.lotId, askPrice: (max + 1n).toString() } });
    expect(high.statusCode).toBe(422);
    const okMax = await call(t.app, s, 'POST', '/api/market/listings', { body: { lotId: lot!.lotId, askPrice: max.toString() } });
    expect(okMax.statusCode).toBe(201);
    expect(okMax.json().askPrice).toBe(max.toString());
    expect((await call(t.app, s, 'DELETE', `/api/market/listings/${okMax.json().id}`)).statusCode).toBe(204);
    const okMin = await call(t.app, s, 'POST', '/api/market/listings', { body: { lotId: lot!.lotId, askPrice: Number(min) } });
    expect(okMin.statusCode).toBe(201);
    // anunciado: não pode vender ao governo nem anunciar de novo
    expect((await call(t.app, s, 'POST', `/api/properties/${lot!.lotId}/sell-to-city`)).json().error.code).toBe('PROPERTY_LISTED');
    expect((await call(t.app, s, 'POST', '/api/market/listings', { body: { lotId: lot!.lotId, askPrice: Number(min) } })).json().error.code).toBe('ALREADY_LISTED');
  });

  it('compra entre jogadores: comprador paga, vendedor recebe menos taxa (progressiva acima de 110%)', async () => {
    const s = await register(t.app);
    const buyer = await register(t.app);
    await ageAccount(t.owner, s.id);
    await ageAccount(t.owner, buyer.id);
    await grant(t.owner, s.id, 50_000_000n);
    await grant(t.owner, buyer.id, 50_000_000n);
    const [lot] = await freeLots(t.owner, 'residential', 1, { maxBase: 10_000_000n });
    await call(t.app, s, 'POST', `/api/properties/${lot!.lotId}/buy`);
    const appr = BigInt((await call(t.app, s, 'GET', `/api/properties/${lot!.lotId}`)).json().appraisal);
    const ask = mulFrac(appr, 1.25);
    const listing = (await call(t.app, s, 'POST', '/api/market/listings', { body: { lotId: lot!.lotId, askPrice: ask.toString() } })).json();
    const items = (await call(t.app, buyer, 'GET', '/api/market/listings?category=residential')).json().items;
    expect(items.some((i: { id: string }) => i.id === listing.id)).toBe(true);

    const own = await call(t.app, s, 'POST', `/api/market/listings/${listing.id}/buy`);
    expect(own.json().error.code).toBe('OWN_LISTING');

    const sBefore = await balanceOf(t.app, s);
    const bBefore = await balanceOf(t.app, buyer);
    const taxas0 = await systemBalance(t.owner, 'TAXAS');
    const res = await call(t.app, buyer, 'POST', `/api/market/listings/${listing.id}/buy`);
    expect(res.statusCode).toBe(200);
    expect(res.json().property.mine).toBe(true);
    const fee = marketFee(ask, appr);
    expect(fee).toBeGreaterThan(mulFrac(ask, 0.05));
    expect(await balanceOf(t.app, buyer)).toBe(bBefore - ask);
    const sAfter = await balanceOf(t.app, s);
    // vendedor também liquida renda/IPTU pendentes (segundos) do imóvel
    const diff = sAfter - sBefore - (ask - fee);
    expect(diff > -1000n && diff < 1000n).toBe(true);
    expect((await systemBalance(t.owner, 'TAXAS')) - taxas0).toBe(fee);
    // anúncio vendido não pode ser comprado de novo
    const again = await call(t.app, buyer, 'POST', `/api/market/listings/${listing.id}/buy`);
    expect(again.json().error.code).toBe('LISTING_UNAVAILABLE');
  });

  it('conta nova não negocia com outros jogadores (carência)', async () => {
    const s = await register(t.app);
    const fresh = await register(t.app);
    await ageAccount(t.owner, s.id);
    await grant(t.owner, s.id, 20_000_000n);
    const [lot] = await freeLots(t.owner, 'vacant', 1, { maxBase: 500_000n });
    await call(t.app, s, 'POST', `/api/properties/${lot!.lotId}/buy`);
    const appr = (await call(t.app, s, 'GET', `/api/properties/${lot!.lotId}`)).json().appraisal;
    const listing = (await call(t.app, s, 'POST', '/api/market/listings', { body: { lotId: lot!.lotId, askPrice: appr } })).json();
    const buy = await call(t.app, fresh, 'POST', `/api/market/listings/${listing.id}/buy`);
    expect(buy.statusCode).toBe(409);
    expect(buy.json().error.code).toBe('ACCOUNT_TOO_NEW');
    const w = (await call(t.app, fresh, 'GET', '/api/me/wallet')).json();
    expect(w.marketUnlockAt).toBeTruthy();
    // a conta nova também não anuncia
    const [own] = await freeLots(t.owner, 'vacant', 1, { maxBase: 500_000n });
    await call(t.app, fresh, 'POST', `/api/properties/${own!.lotId}/buy`);
    const ownAppr = (await call(t.app, fresh, 'GET', `/api/properties/${own!.lotId}`)).json().appraisal;
    const list = await call(t.app, fresh, 'POST', '/api/market/listings', { body: { lotId: own!.lotId, askPrice: ownAppr } });
    expect(list.json().error.code).toBe('ACCOUNT_TOO_NEW');
  });

  it('contas da mesma rede não negociam entre si; mesmo par só 1 negócio por semana', async () => {
    const ip = '10.200.0.7';
    const main = await register(t.app, { ip });
    const alt = await register(t.app, { ip });
    const other = await register(t.app);
    for (const p of [main, alt, other]) {
      await ageAccount(t.owner, p.id);
      await grant(t.owner, p.id, 20_000_000n);
    }
    const lots = await freeLots(t.owner, 'vacant', 2, { maxBase: 500_000n });
    for (const l of lots) await call(t.app, main, 'POST', `/api/properties/${l.lotId}/buy`);
    const mk = async (lotId: string) => {
      const appr = (await call(t.app, main, 'GET', `/api/properties/${lotId}`)).json().appraisal;
      return (await call(t.app, main, 'POST', '/api/market/listings', { body: { lotId, askPrice: appr } })).json().id as string;
    };
    const l1 = await mk(lots[0]!.lotId);
    const l2 = await mk(lots[1]!.lotId);
    const linked = await call(t.app, alt, 'POST', `/api/market/listings/${l1}/buy`);
    expect(linked.json().error.code).toBe('MARKET_LINKED_ACCOUNTS');
    expect((await call(t.app, other, 'POST', `/api/market/listings/${l1}/buy`)).statusCode).toBe(200);
    const pair = await call(t.app, other, 'POST', `/api/market/listings/${l2}/buy`);
    expect(pair.json().error.code).toBe('MARKET_PAIR_COOLDOWN');
  });

  it('anúncio vencido some da lista e não pode ser comprado', async () => {
    const s = await register(t.app);
    const b = await register(t.app);
    await ageAccount(t.owner, s.id);
    await ageAccount(t.owner, b.id);
    await grant(t.owner, s.id, 20_000_000n);
    const [lot] = await freeLots(t.owner, 'vacant', 1, { maxBase: 500_000n });
    await call(t.app, s, 'POST', `/api/properties/${lot!.lotId}/buy`);
    const appr = (await call(t.app, s, 'GET', `/api/properties/${lot!.lotId}`)).json().appraisal;
    const listing = (await call(t.app, s, 'POST', '/api/market/listings', { body: { lotId: lot!.lotId, askPrice: appr } })).json();
    await t.owner.query(`UPDATE listings SET created_at = now() - interval '8 days' WHERE id = $1`, [listing.id]);
    const items = (await call(t.app, b, 'GET', '/api/market/listings?category=vacant')).json().items;
    expect(items.some((i: { id: string }) => i.id === listing.id)).toBe(false);
    expect((await call(t.app, b, 'POST', `/api/market/listings/${listing.id}/buy`)).json().error.code).toBe('LISTING_UNAVAILABLE');
  });
});

describe('índice e venda ao governo (sem arbitragem)', () => {
  const setIndex = (category: string, bp: number) =>
    t.owner.query(
      `UPDATE market_indices SET index_bp = $2, ema_bp = $2, anchor_bp = $2, anchor_at = now(), updated_at = now() WHERE category = $1`,
      [category, bp],
    );

  it('índice bombeado ao teto: comprar da prefeitura e vender de volta sempre dá prejuízo', async () => {
    const p = await register(t.app);
    await grant(t.owner, p.id, 200_000_000n);
    const [lot] = await freeLots(t.owner, 'industrial', 1, { maxBase: 50_000_000n });
    await setIndex('industrial', 10_000);
    const before = await balanceOf(t.app, p);
    expect((await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`)).statusCode).toBe(200);
    const paid = before - (await balanceOf(t.app, p));
    // manipulação leva o índice ao teto (1,8) antes da venda
    await setIndex('industrial', 18_000);
    const appr = BigInt((await call(t.app, p, 'GET', `/api/properties/${lot!.lotId}`)).json().appraisal);
    expect(appr).toBeGreaterThan(paid);
    const mid = await balanceOf(t.app, p);
    expect((await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/sell-to-city`)).statusCode).toBe(200);
    const got = (await balanceOf(t.app, p)) - mid;
    // recebe no máximo 70% do que pagou (renda de segundos à parte)
    expect(got).toBeLessThanOrEqual(sellToCityPrice(appr, paid) + 1000n);
    expect(got).toBeLessThan(paid);
    await setIndex('industrial', 10_000);
  });

  it('venda entre jogadores barata ou revenda rápida não move o índice', async () => {
    const a = await register(t.app);
    const b = await register(t.app);
    const c = await register(t.app);
    for (const p of [a, b, c]) {
      await ageAccount(t.owner, p.id);
      await grant(t.owner, p.id, 100_000_000n);
    }
    const [lot] = await freeLots(t.owner, 'commercial', 1, { maxBase: 5_000_000n });
    expect((await call(t.app, a, 'POST', `/api/properties/${lot!.lotId}/buy`)).statusCode).toBe(200);
    await setIndex('commercial', 10_000);
    const idx = async () =>
      (await t.owner.query(`SELECT index_bp FROM market_indices WHERE category = 'commercial'`)).rows[0].index_bp as number;
    const appr = BigInt((await call(t.app, a, 'GET', `/api/properties/${lot!.lotId}`)).json().appraisal);
    // 80% da avaliação: abaixo do piso de demanda (90%)
    const cheap = (await call(t.app, a, 'POST', '/api/market/listings', { body: { lotId: lot!.lotId, askPrice: mulFrac(appr, 0.8).toString() } })).json();
    expect((await call(t.app, b, 'POST', `/api/market/listings/${cheap.id}/buy`)).statusCode).toBe(200);
    expect(await idx()).toBe(10_000);
    // revenda do mesmo imóvel em menos de 24 h, a preço cheio: também não conta
    const full = (await call(t.app, b, 'POST', '/api/market/listings', { body: { lotId: lot!.lotId, askPrice: appr.toString() } })).json();
    expect((await call(t.app, c, 'POST', `/api/market/listings/${full.id}/buy`)).statusCode).toBe(200);
    expect(await idx()).toBe(10_000);
  });
});

describe('renda, IPTU, residência e negócios', () => {
  it('renda acumula até 24 h; IPTU por tempo real (48 h) é cobrado na coleta', async () => {
    const p = await register(t.app);
    await grant(t.owner, p.id, 100_000_000n);
    const [lot] = await freeLots(t.owner, 'industrial', 1, { maxBase: 50_000_000n });
    await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`);
    // 48 h atrás: renda limitada a 24 h, IPTU das 48 h
    await t.owner.query(`UPDATE properties SET last_collected_at = now() - interval '48 hours' WHERE lot_id = $1`, [lot!.lotId]);
    const ix = (await t.owner.query(`SELECT index_bp, ema_bp FROM market_indices WHERE category = 'industrial'`)).rows[0] as {
      index_bp: number;
      ema_bp: number;
    };
    const rec = {
      category: 'industrial' as const,
      appraisal: appraisal(lot!.base, Math.min(ix.index_bp, ix.ema_bp)),
      isResidence: false,
      business: null,
    };
    const t0 = new Date(Date.now() - 48 * 3_600_000);
    const exp = accrual(rec, t0, new Date(), appraisal(lot!.base, Math.max(ix.index_bp, ix.ema_bp)));
    const wallet = (await call(t.app, p, 'GET', '/api/me/wallet')).json();
    const pend = BigInt(wallet.pendingIncome) - (exp.gross - exp.tax);
    expect(pend > -1000n && pend < 1000n).toBe(true);
    const before = await balanceOf(t.app, p);
    const res = await call(t.app, p, 'POST', '/api/income/collect');
    expect(res.statusCode).toBe(200);
    // no teto de 24 h a renda é exata; o IPTU segue o relógio (alguns ms a mais)
    expect(res.json().collected).toBe(exp.gross.toString());
    // relógios do Node e do Postgres podem diferir alguns ms/s
    const dTax = BigInt(res.json().tax) - exp.tax;
    expect(dTax > -1000n && dTax < 1000n).toBe(true);
    expect(await balanceOf(t.app, p)).toBe(before + exp.gross - BigInt(res.json().tax));
    // coletar de novo logo em seguida não rende nada relevante
    const again = (await call(t.app, p, 'POST', '/api/income/collect')).json();
    expect(BigInt(again.collected)).toBeLessThan(10n);
  });

  it('IPTU que não cabe no saldo vira dívida: bloqueia anúncio e é quitado na venda', async () => {
    const p = await register(t.app);
    await ageAccount(t.owner, p.id);
    // terrenos vagos do catálogo valem até ~I$ 5,4 mil; 30 dias de IPTU (12%) cabem na venda (70%)
    const [lot] = await freeLots(t.owner, 'vacant', 1, { minBase: 200_000n });
    expect(lot, 'catálogo sem terreno vago na faixa').toBeTruthy();
    expect((await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`)).statusCode).toBe(200);
    // sem saldo e com IPTU de 40 dias acumulado (teto de 30)
    await drain(t.owner, p.id);
    await t.owner.query(`UPDATE properties SET last_collected_at = now() - interval '40 days' WHERE owner_id = $1`, [p.id]);
    const col = (await call(t.app, p, 'POST', '/api/income/collect')).json();
    expect(BigInt(col.wallet.taxDebt)).toBeGreaterThan(0n);
    expect(col.wallet.balance).toBe('0');
    const appr = (await call(t.app, p, 'GET', `/api/properties/${lot!.lotId}`)).json().appraisal;
    const list = await call(t.app, p, 'POST', '/api/market/listings', { body: { lotId: lot!.lotId, askPrice: appr } });
    expect(list.json().error.code).toBe('TAX_DEBT');
    const sell = await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/sell-to-city`);
    expect(sell.statusCode).toBe(200);
    expect(sell.json().wallet.taxDebt).toBe('0');
  });

  it('residência não gera aluguel e é isenta de IPTU até o limite', async () => {
    const p = await register(t.app);
    await grant(t.owner, p.id, 100_000_000n);
    const [lot] = await freeLots(t.owner, 'residential', 1, { minBase: 10_000_000n, maxBase: 40_000_000n });
    await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`);
    const r = await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/residence`);
    expect(r.json().property.isResidence).toBe(true);
    expect(r.json().property.incomePerHour).toBe('0');
    await t.owner.query(`UPDATE properties SET last_collected_at = now() - interval '10 hours' WHERE lot_id = $1`, [lot!.lotId]);
    const res = (await call(t.app, p, 'POST', '/api/income/collect')).json();
    expect(res.collected).toBe('0');
    const appr = BigInt((await call(t.app, p, 'GET', `/api/properties/${lot!.lotId}`)).json().appraisal);
    const fullTax = BigInt(Math.floor((Number(appr) * ECONOMY.iptuPerDay * 10) / 24));
    expect(BigInt(res.tax)).toBeGreaterThan(0n);
    expect(BigInt(res.tax)).toBeLessThan(fullTax);
  });

  it('só residencial pode ser residência', async () => {
    const p = await register(t.app);
    await grant(t.owner, p.id, 100_000_000n);
    const [lot] = await freeLots(t.owner, 'commercial', 1, { maxBase: 30_000_000n });
    await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`);
    expect((await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/residence`)).json().error.code).toBe('NOT_RESIDENTIAL');
  });

  it('negócio: custo proporcional à avaliação, aumenta renda, upgrade até nível 5, fecha', async () => {
    const p = await register(t.app);
    await grant(t.owner, p.id, 2_000_000_000n);
    const [lot] = await freeLots(t.owner, 'commercial', 1, { maxBase: 50_000_000n });
    await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`);
    const view = (await call(t.app, p, 'GET', `/api/properties/${lot!.lotId}`)).json();
    const before = BigInt(view.incomePerHour);
    const cost = businessOpenCost(BigInt(view.appraisal));
    expect(view.openBusinessCost).toBe(cost.toString());
    const bad = await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/business`, { body: { type: 'cassino' } });
    expect(bad.statusCode).toBe(400);
    const bal0 = await balanceOf(t.app, p);
    const open = await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/business`, { body: { type: 'padaria' } });
    expect(open.statusCode).toBe(200);
    expect(open.json().property.business).toEqual({ type: 'padaria', level: 1 });
    expect(BigInt(open.json().property.upgradeCost)).toBe(businessOpenCost(BigInt(open.json().property.appraisal)));
    expect(BigInt(open.json().wallet.balance)).toBeLessThanOrEqual(bal0 - cost + 1000n);
    expect(BigInt(open.json().property.incomePerHour)).toBeGreaterThanOrEqual(before);
    const dup = await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/business`, { body: { type: 'loja' } });
    expect(dup.json().error.code).toBe('BUSINESS_EXISTS');
    for (let lvl = 2; lvl <= 5; lvl++) {
      const up = await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/business/upgrade`);
      expect(up.statusCode).toBe(200);
      expect(up.json().property.business.level).toBe(lvl);
    }
    const max = await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/business/upgrade`);
    expect(max.json().error.code).toBe('MAX_LEVEL');
    const close = await call(t.app, p, 'DELETE', `/api/properties/${lot!.lotId}/business`);
    expect(close.statusCode).toBe(200);
    expect(close.json().property.business).toBeNull();
  });

  it('negócio só em imóvel comercial (também no banco)', async () => {
    const p = await register(t.app);
    await grant(t.owner, p.id, 100_000_000n);
    const [lot] = await freeLots(t.owner, 'industrial', 1, { maxBase: 50_000_000n });
    await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`);
    const res = await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/business`, { body: { type: 'loja' } });
    expect(res.json().error.code).toBe('NOT_COMMERCIAL');
    await expect(
      t.ctx.pool.query(`INSERT INTO businesses (lot_id, type, opened_at, updated_at) VALUES ($1, 'loja', now(), now())`, [lot!.lotId]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('casa inicial: subsídio não vira lucro', () => {
  it('venda ao governo paga no máximo 70% do que o jogador desembolsou; imóvel volta a ser elegível', async () => {
    const p = await register(t.app);
    const h = (await call(t.app, p, 'GET', '/api/starter-homes')).json().homes[0];
    const claim = await call(t.app, p, 'POST', '/api/starter-homes/claim', { body: { lotId: h.lotId } });
    expect(claim.statusCode).toBe(200);
    const paid = 3_000_000n - BigInt(claim.json().wallet.balance);
    await t.owner.query(`UPDATE properties SET locked_until = now() - interval '1 second' WHERE lot_id = $1`, [h.lotId]);
    const mid = await balanceOf(t.app, p);
    expect((await call(t.app, p, 'POST', `/api/properties/${h.lotId}/sell-to-city`)).statusCode).toBe(200);
    expect((await balanceOf(t.app, p)) - mid).toBeLessThanOrEqual(mulFrac(paid, ECONOMY.sellToCityRate));
    // outro jogador pode receber a mesma casa como inicial
    const q = await register(t.app);
    expect((await call(t.app, q, 'POST', '/api/starter-homes/claim', { body: { lotId: h.lotId } })).statusCode).toBe(200);
  });

  it('venda da casa inicial a outro jogador devolve o subsídio ao Tesouro', async () => {
    const s = await register(t.app);
    const b = await register(t.app);
    await ageAccount(t.owner, s.id);
    await ageAccount(t.owner, b.id);
    await grant(t.owner, b.id, 100_000_000n);
    const h = (await call(t.app, s, 'GET', '/api/starter-homes')).json().homes[1];
    expect((await call(t.app, s, 'POST', '/api/starter-homes/claim', { body: { lotId: h.lotId } })).statusCode).toBe(200);
    const { rows } = await t.owner.query('SELECT subsidy FROM starter_claims WHERE user_id = $1', [s.id]);
    const subsidy = BigInt(rows[0].subsidy);
    await t.owner.query(`UPDATE properties SET locked_until = now() - interval '1 second' WHERE lot_id = $1`, [h.lotId]);
    const appr = BigInt((await call(t.app, s, 'GET', `/api/properties/${h.lotId}`)).json().appraisal);
    const listing = (await call(t.app, s, 'POST', '/api/market/listings', { body: { lotId: h.lotId, askPrice: appr.toString() } })).json();
    const before = await balanceOf(t.app, s);
    expect((await call(t.app, b, 'POST', `/api/market/listings/${listing.id}/buy`)).statusCode).toBe(200);
    const got = (await balanceOf(t.app, s)) - before;
    expect(got).toBeLessThanOrEqual(appr - marketFee(appr, appr) - subsidy + 1000n);
    const sc = await t.owner.query('SELECT subsidy_repaid, released_at FROM starter_claims WHERE user_id = $1', [s.id]);
    expect(BigInt(sc.rows[0].subsidy_repaid)).toBe(subsidy);
    expect(sc.rows[0].released_at).toBeTruthy();
  });

  it('casas de entrada reservadas: quem já tem vários imóveis não compra da prefeitura', async () => {
    const p = await register(t.app);
    await grant(t.owner, p.id, 50_000_000n);
    for (const l of await freeLots(t.owner, 'vacant', ECONOMY.starter.reserveMaxOwned, { maxBase: 300_000n })) {
      expect((await call(t.app, p, 'POST', `/api/properties/${l.lotId}/buy`)).statusCode).toBe(200);
    }
    const [house] = await freeLots(t.owner, 'residential', 1, { maxBase: ECONOMY.starter.maxBase });
    const res = await call(t.app, p, 'POST', `/api/properties/${house!.lotId}/buy`);
    expect(res.json().error.code).toBe('STARTER_RESERVED');
  });
});

describe('idempotência', () => {
  it('exige Idempotency-Key UUID v4 nas operações econômicas', async () => {
    const p = await register(t.app);
    const [lot] = await freeLots(t.owner, 'vacant', 1, { maxBase: 500_000n });
    expect((await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`, { idem: false })).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`, { idem: 'abc' })).statusCode).toBe(400);
    expect((await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`, { idem: '00000000-0000-1000-8000-000000000000' })).statusCode).toBe(400);
  });

  it('replay devolve a mesma resposta sem cobrar de novo', async () => {
    const p = await register(t.app);
    const [lot] = await freeLots(t.owner, 'vacant', 1, { maxBase: 500_000n });
    const key = randomUUID();
    const first = await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`, { idem: key });
    expect(first.statusCode).toBe(200);
    const bal = await balanceOf(t.app, p);
    const second = await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`, { idem: key });
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(await balanceOf(t.app, p)).toBe(bal);
    const { rows } = await t.owner.query(`SELECT count(*)::int AS n FROM ledger_transactions WHERE user_id = $1 AND kind = 'city_purchase'`, [p.id]);
    expect(rows[0].n).toBe(1);
  });

  it('mesma chave em outro pedido = 422; chave é por usuário', async () => {
    const p = await register(t.app);
    const q = await register(t.app);
    const [l1, l2] = await freeLots(t.owner, 'vacant', 2, { maxBase: 500_000n });
    const key = randomUUID();
    expect((await call(t.app, p, 'POST', `/api/properties/${l1!.lotId}/buy`, { idem: key })).statusCode).toBe(200);
    const other = await call(t.app, p, 'POST', `/api/properties/${l2!.lotId}/buy`, { idem: key });
    expect(other.statusCode).toBe(422);
    expect(other.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // outro usuário com a mesma chave não vê a resposta do primeiro
    const q1 = await call(t.app, q, 'POST', `/api/properties/${l2!.lotId}/buy`, { idem: key });
    expect(q1.statusCode).toBe(200);
    expect(q1.json().property.owner.displayName).toBe(q.displayName);
  });

  it('replay concorrente (20× a mesma chave ao mesmo tempo) cobra uma vez', async () => {
    const p = await register(t.app);
    const [lot] = await freeLots(t.owner, 'vacant', 1, { maxBase: 500_000n });
    const price = await appraisalOf(lot!.lotId);
    const key = randomUUID();
    const res = await Promise.all(Array.from({ length: 20 }, () => call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`, { idem: key })));
    expect(res.every((r) => r.statusCode === 200)).toBe(true);
    expect(res.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(19);
    expect(await balanceOf(t.app, p)).toBe(3_000_000n - price);
  });
});

describe('consultas', () => {
  it('ownership, extrato paginado e overview', async () => {
    const p = await register(t.app);
    const lots = await freeLots(t.owner, 'vacant', 2, { maxBase: 500_000n });
    for (const l of lots) await call(t.app, p, 'POST', `/api/properties/${l.lotId}/buy`);
    const own = (await call(t.app, p, 'GET', '/api/properties/ownership')).json();
    for (const l of lots) {
      expect(own.mine).toContain(l.lotId);
      expect(own.owned).toContain(l.lotId);
    }
    const mine = (await call(t.app, p, 'GET', '/api/me/properties')).json().properties;
    expect(mine.map((x: { lotId: string }) => x.lotId).sort()).toEqual(lots.map((l) => l.lotId).sort());
    const tx = (await call(t.app, p, 'GET', '/api/me/transactions')).json();
    expect(tx.items.map((i: { kind: string }) => i.kind)).toEqual(['city_purchase', 'city_purchase', 'signup_grant']);
    expect(tx.nextCursor).toBeNull();
    for (const i of tx.items) expect(typeof i.amount).toBe('string');
    const ov = (await call(t.app, null, 'GET', '/api/market/overview')).json();
    expect(Object.keys(ov).sort()).toEqual(['indices', 'recentSales', 'stats']);
    expect(ov.recentSales.length).toBeGreaterThan(0);
    // histórico público sem lote, com preço arredondado a I$ 1.000 e sem massa monetária
    for (const r of ov.recentSales) {
      expect(r.lotId).toBeUndefined();
      expect(BigInt(r.price) % 100_000n).toBe(0n);
    }
    expect(ov.stats.moneySupply).toBeUndefined();
  });

  it('ranking ordena por patrimônio e arredonda a I$ 1.000', async () => {
    const rich = await register(t.app);
    await grant(t.owner, rich.id, 9_000_000_000n);
    const lb = (await call(t.app, null, 'GET', '/api/leaderboard')).json();
    expect(lb.items[0].displayName).toBe(rich.displayName);
    expect(lb.items.length).toBeLessThanOrEqual(50);
    const values = lb.items.map((i: { netWorth: string }) => BigInt(i.netWorth));
    for (let i = 1; i < values.length; i++) expect(values[i - 1] >= values[i]).toBe(true);
  });
});
