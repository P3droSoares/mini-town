import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkInvariants } from '../src/economy/invariants.js';
import { ageAccount, balanceOf, call, freeLots, grant, makeApp, register, type Player, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => {
  await t.close();
});

describe('corridas', () => {
  it('50 compras simultâneas do mesmo imóvel (50 jogadores) = exatamente 1 sucesso', async () => {
    const players: Player[] = await Promise.all(Array.from({ length: 50 }, () => register(t.app)));
    const [lot] = await freeLots(t.owner, 'residential', 1, { maxBase: 2_500_000n });
    const res = await Promise.all(players.map((p) => call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`)));
    const ok = res.filter((r) => r.statusCode === 200);
    expect(ok).toHaveLength(1);
    expect(res.filter((r) => r.statusCode === 409)).toHaveLength(49);
    const winner = ok[0]!.json().property.owner.displayName;
    const { rows } = await t.owner.query(
      `SELECT u.display_name FROM properties p JOIN users u ON u.id = p.owner_id WHERE p.lot_id = $1`,
      [lot!.lotId],
    );
    expect(rows[0].display_name).toBe(winner);
    // só o vencedor pagou
    const balances = await Promise.all(players.map((p) => balanceOf(t.app, p)));
    expect(balances.filter((b) => b < 3_000_000n)).toHaveLength(1);
    const sales = await t.owner.query(`SELECT count(*)::int AS n FROM ledger_transactions WHERE kind = 'city_purchase' AND lot_id = $1`, [lot!.lotId]);
    expect(sales.rows[0].n).toBe(1);
  });

  it('50 gastos simultâneos do mesmo jogador nunca deixam o saldo negativo', async () => {
    const p = await register(t.app);
    // 50 terrenos baratos; o saldo cobre só parte deles
    const lots = await freeLots(t.owner, 'vacant', 50, { maxBase: 400_000n });
    expect(lots.length).toBe(50);
    const res = await Promise.all(lots.map((l) => call(t.app, p, 'POST', `/api/properties/${l.lotId}/buy`)));
    const ok = res.filter((r) => r.statusCode === 200).length;
    // sem saldo ou cota diária de compras à prefeitura esgotada
    const broke = res.filter(
      (r) => r.statusCode === 409 && ['INSUFFICIENT_FUNDS', 'CITY_PURCHASE_QUOTA'].includes(r.json().error.code),
    ).length;
    expect(ok + broke).toBe(50);
    expect(broke).toBeGreaterThan(0);
    const bal = await balanceOf(t.app, p);
    expect(bal).toBeGreaterThanOrEqual(0n);
    const { rows } = await t.owner.query(
      `SELECT coalesce(sum(-e.amount), 0)::bigint AS spent FROM ledger_entries e
         JOIN accounts a ON a.id = e.account_id JOIN ledger_transactions t ON t.id = e.tx_id
        WHERE a.user_id = $1 AND t.kind = 'city_purchase'`,
      [p.id],
    );
    expect(3_000_000n - BigInt(rows[0].spent)).toBe(bal);
    const owned = (await call(t.app, p, 'GET', '/api/me/properties')).json().properties.length;
    expect(owned).toBe(ok);
  });

  it('gastos concorrentes de tipos diferentes (compra, negócio, anúncio) mantêm saldo ≥ 0', async () => {
    const p = await register(t.app);
    await grant(t.owner, p.id, 30_000_000n);
    const coms = await freeLots(t.owner, 'commercial', 4, { maxBase: 6_000_000n });
    for (const c of coms) await call(t.app, p, 'POST', `/api/properties/${c.lotId}/buy`);
    const owned = (await call(t.app, p, 'GET', '/api/me/properties')).json().properties.map((x: { lotId: string }) => x.lotId);
    const vac = await freeLots(t.owner, 'vacant', 20, { maxBase: 400_000n });
    const reqs = [
      ...owned.map((lotId: string) => call(t.app, p, 'POST', `/api/properties/${lotId}/business`, { body: { type: 'mercado' } })),
      ...vac.map((l) => call(t.app, p, 'POST', `/api/properties/${l.lotId}/buy`)),
      call(t.app, p, 'POST', '/api/income/collect'),
      call(t.app, p, 'POST', '/api/income/collect'),
    ];
    const res = await Promise.all(reqs);
    for (const r of res) expect([200, 409]).toContain(r.statusCode);
    expect(await balanceOf(t.app, p)).toBeGreaterThanOrEqual(0n);
  });

  it('corrida comprador × cancelamento × venda ao governo no mesmo anúncio', async () => {
    const s = await register(t.app);
    await ageAccount(t.owner, s.id);
    await grant(t.owner, s.id, 20_000_000n);
    const [lot] = await freeLots(t.owner, 'residential', 1, { maxBase: 5_000_000n });
    await call(t.app, s, 'POST', `/api/properties/${lot!.lotId}/buy`);
    const appr = (await call(t.app, s, 'GET', `/api/properties/${lot!.lotId}`)).json().appraisal;
    const listing = (await call(t.app, s, 'POST', '/api/market/listings', { body: { lotId: lot!.lotId, askPrice: appr } })).json();
    const buyers = await Promise.all(Array.from({ length: 10 }, () => register(t.app)));
    for (const b of buyers) {
      await ageAccount(t.owner, b.id);
      await grant(t.owner, b.id, 20_000_000n);
    }
    const res = await Promise.all([
      ...buyers.map((b) => call(t.app, b, 'POST', `/api/market/listings/${listing.id}/buy`)),
      call(t.app, s, 'DELETE', `/api/market/listings/${listing.id}`),
      call(t.app, s, 'POST', `/api/properties/${lot!.lotId}/sell-to-city`),
    ]);
    const buys = res.slice(0, 10).filter((r) => r.statusCode === 200).length;
    const cancelled = res[10]!.statusCode === 204;
    expect(buys + (cancelled ? 1 : 0)).toBe(1);
    // nunca as duas coisas: vender ao governo com anúncio ativo é proibido
    const { rows } = await t.owner.query(`SELECT count(*)::int AS n FROM ledger_transactions WHERE lot_id = $1 AND kind IN ('market_sale','city_sale')`, [lot!.lotId]);
    expect(rows[0].n).toBeLessThanOrEqual(2);
    const sales = await t.owner.query(`SELECT count(*)::int AS n FROM ledger_transactions WHERE lot_id = $1 AND kind = 'market_sale'`, [lot!.lotId]);
    expect(sales.rows[0].n).toBe(buys);
  });

  it('coletas simultâneas (chaves diferentes) não pagam a mesma renda duas vezes', async () => {
    const p = await register(t.app);
    await grant(t.owner, p.id, 100_000_000n);
    const [lot] = await freeLots(t.owner, 'industrial', 1, { maxBase: 50_000_000n });
    expect((await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`)).statusCode).toBe(200);
    await t.owner.query(`UPDATE properties SET last_collected_at = now() - interval '10 hours' WHERE lot_id = $1`, [lot!.lotId]);
    const res = await Promise.all(Array.from({ length: 10 }, () => call(t.app, p, 'POST', '/api/income/collect')));
    for (const r of res) expect(r.statusCode).toBe(200);
    const total = res.reduce((s, r) => s + BigInt(r.json().collected), 0n);
    const first = res.map((r) => BigInt(r.json().collected)).reduce((m, v) => (v > m ? v : m), 0n);
    // tudo além da maior coleta é só o tempo que passou entre elas (milissegundos)
    expect(total - first).toBeLessThan(first / 100n + 100n);
    const { rows } = await t.owner.query(`SELECT last_collected_at FROM properties WHERE lot_id = $1`, [lot!.lotId]);
    expect(Date.now() - rows[0].last_collected_at.getTime()).toBeLessThan(60_000);
  });

  it('invariantes do razão continuam válidos depois das corridas', async () => {
    const r = await checkInvariants(t.owner);
    expect(r).toMatchObject({ ok: true, unbalancedTx: [], balanceMismatch: [], negativePlayers: 0 });
    expect(r.moneySupply).toBe(r.emission);
  });
});
