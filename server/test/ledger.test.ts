import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ECONOMY } from '../src/economy/config.js';
import { checkInvariants, runInvariantJob, setEconomyLock } from '../src/economy/invariants.js';
import { call, freeLots, makeApp, register, type Player, type TestApp } from './helpers.js';

let t: TestApp;
let p: Player;
const silent = { error: () => {}, info: () => {} };

beforeAll(async () => {
  t = await makeApp();
  p = await register(t.app);
});
afterAll(async () => {
  await t.close();
});

const pgCode = async (fn: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

describe('razão append-only e privilégios mínimos', () => {
  it('papel app não altera nem apaga lançamentos, transações ou auditoria', async () => {
    const app = t.ctx.pool;
    expect(await pgCode(() => app.query('UPDATE ledger_entries SET amount = amount + 1'))).toBe('42501');
    expect(await pgCode(() => app.query('DELETE FROM ledger_entries'))).toBe('42501');
    expect(await pgCode(() => app.query('UPDATE ledger_transactions SET amount = 0'))).toBe('42501');
    expect(await pgCode(() => app.query('DELETE FROM audit_log'))).toBe('42501');
    expect(await pgCode(() => app.query('SELECT * FROM audit_log'))).toBe('42501');
    expect(await pgCode(() => app.query('TRUNCATE ledger_entries'))).toBe('42501');
  });

  it('papel app não escreve saldo, catálogo nem DDL', async () => {
    const app = t.ctx.pool;
    expect(await pgCode(() => app.query('UPDATE accounts SET balance = 999999999'))).toBe('42501');
    expect(await pgCode(() => app.query('UPDATE properties SET base_price = 1'))).toBe('42501');
    expect(await pgCode(() => app.query(`INSERT INTO properties (lot_id, category, area_m2, levels, x, z, dist_center_m, base_price, sellable) VALUES ('ITB-X1','vacant',1,0,0,0,0,1,true)`))).toBe('42501');
    expect(await pgCode(() => app.query('CREATE TABLE hack (id int)'))).toBe('42501');
    expect(await pgCode(() => app.query('DROP TABLE ledger_entries'))).toBe('42501');
    expect(await pgCode(() => app.query('SELECT * FROM schema_migrations'))).toBe('42501');
    expect(await pgCode(() => app.query('UPDATE users SET email_hash = email_hash'))).toBe('42501');
  });

  it('papel app não cria conta com saldo, não destrava a manutenção e não faz ajuste contábil', async () => {
    const app = t.ctx.pool;
    expect(await pgCode(() => app.query(`INSERT INTO accounts (kind, user_id, balance) VALUES ('player', $1, 1000000000)`, [p.id]))).toBe('42501');
    expect(await pgCode(() => app.query(`INSERT INTO businesses (lot_id, type, level) VALUES ('ITB-X1', 'loja', 5)`))).toBe('42501');
    expect(await pgCode(() => app.query(`UPDATE system_flags SET value = '{"locked": false}'`))).toBe('42501');
    expect(await pgCode(() => app.query(`SELECT anonymize_user($1)`, [p.id]))).toBe('42501');
    expect(await pgCode(() => app.query(`SELECT audit_log_drop_before(current_date)`))).toBe('42501');
    // ajuste (emissão manual) só pelo dono: recusado no COMMIT
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      const acc = await c.query('SELECT id FROM accounts WHERE user_id = $1', [p.id]);
      const tes = await c.query(`SELECT id FROM accounts WHERE code = 'TESOURO'`);
      const { rows } = await c.query(`INSERT INTO ledger_transactions (kind, user_id, amount) VALUES ('adjustment', $1, 5) RETURNING id`, [p.id]);
      await c.query('INSERT INTO ledger_entries (tx_id, account_id, amount) VALUES ($1, $2, 5), ($1, $3, -5)', [rows[0].id, acc.rows[0].id, tes.rows[0].id]);
      expect(await pgCode(() => c.query('COMMIT'))).toBe('42501');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  });

  it('banco recusa débito do TESOURO fora dos tipos autorizados e bônus de cadastro repetido/errado', async () => {
    const tryTx = async (kind: string, amount: number, tesAmount: number) => {
      const c = await t.ctx.pool.connect();
      try {
        await c.query('BEGIN');
        const acc = await c.query('SELECT id FROM accounts WHERE user_id = $1', [p.id]);
        const tes = await c.query(`SELECT id FROM accounts WHERE code = 'TESOURO'`);
        const { rows } = await c.query(`INSERT INTO ledger_transactions (kind, user_id, amount) VALUES ($1, $2, $3) RETURNING id`, [kind, p.id, amount]);
        await c.query('INSERT INTO ledger_entries (tx_id, account_id, amount) VALUES ($1, $2, $3), ($1, $4, $5)', [
          rows[0].id,
          acc.rows[0].id,
          -tesAmount,
          tes.rows[0].id,
          tesAmount,
        ]);
        return await pgCode(() => c.query('COMMIT'));
      } catch (e) {
        return (e as { code?: string }).code;
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
    };
    // compra "paga" pelo Tesouro (dinheiro do nada com tipo errado)
    expect(await tryTx('city_purchase', 100, -100)).toBe('23514');
    // segundo bônus de cadastro para o mesmo usuário
    expect(await tryTx('signup_grant', Number(ECONOMY.signupGrant), -Number(ECONOMY.signupGrant))).toBe('23505');
    const fn = await t.owner.query('SELECT economy_signup_grant()::text AS v');
    expect(BigInt(fn.rows[0].v)).toBe(ECONOMY.signupGrant);
  });

  it('app só consegue travar a economia; destravar é do dono', async () => {
    await t.ctx.pool.query(`SELECT economy_lock('teste')`);
    const res = await call(t.app, p, 'POST', '/api/income/collect');
    expect(res.json().error.code).toBe('MAINTENANCE');
    await setEconomyLock(t.owner, false, 'teste');
    expect((await call(t.app, p, 'POST', '/api/income/collect')).statusCode).toBe(200);
  });

  it('nem o dono consegue alterar o razão (trigger)', async () => {
    expect(await pgCode(() => t.owner.query('UPDATE ledger_entries SET amount = amount WHERE id = (SELECT min(id) FROM ledger_entries)'))).toBe('42501');
    expect(await pgCode(() => t.owner.query('DELETE FROM ledger_entries WHERE id = (SELECT min(id) FROM ledger_entries)'))).toBe('42501');
    expect(await pgCode(() => t.owner.query('TRUNCATE ledger_entries CASCADE'))).toBe('42501');
  });

  it('transação desbalanceada é recusada no COMMIT', async () => {
    const c = await t.ctx.pool.connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query(`INSERT INTO ledger_transactions (kind, user_id, amount) VALUES ('income', $1, 1) RETURNING id`, [p.id]);
      const acc = await c.query('SELECT id FROM accounts WHERE user_id = $1', [p.id]);
      await c.query('INSERT INTO ledger_entries (tx_id, account_id, amount) VALUES ($1, $2, 100)', [rows[0].id, acc.rows[0].id]);
      expect(await pgCode(() => c.query('COMMIT'))).toBe('23514');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  });

  it('saldo de jogador nunca fica negativo (CHECK no banco)', async () => {
    const c = await t.ctx.pool.connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query(`INSERT INTO ledger_transactions (kind, user_id, amount) VALUES ('city_purchase', $1, 1) RETURNING id`, [p.id]);
      const acc = await c.query('SELECT id FROM accounts WHERE user_id = $1', [p.id]);
      const gov = await c.query(`SELECT id FROM accounts WHERE code = 'GOVERNO'`);
      const code = await pgCode(() =>
        c.query('INSERT INTO ledger_entries (tx_id, account_id, amount) VALUES ($1, $2, -999999999999), ($1, $3, 999999999999)', [
          rows[0].id,
          acc.rows[0].id,
          gov.rows[0].id,
        ]),
      );
      expect(code).toBe('23514');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  });
});

describe('invariantes e modo manutenção', () => {
  it('soma por transação = 0, saldo = soma dos lançamentos, massa = emissão = emissão esperada', async () => {
    const r = await checkInvariants(t.ctx.pool, { full: true });
    expect(r).toMatchObject({ ok: true, mode: 'full', unauthorizedDebits: [], ownershipMismatch: [], signupMismatch: 0 });
    expect(BigInt(r.moneySupply)).toBeGreaterThan(0n);
    expect(r.moneySupply).toBe(r.emission);
    expect(r.emission).toBe(r.expectedEmission);
    // incremental logo depois: mesmo resultado
    const inc = await checkInvariants(t.ctx.pool);
    expect(inc.mode).toBe('incremental');
    expect(inc.ok).toBe(true);
  });

  it('emissão indevida balanceada (bug que paga do Tesouro) é detectada', async () => {
    const acc = (await t.owner.query('SELECT id FROM accounts WHERE user_id = $1', [p.id])).rows[0].id;
    const tes = (await t.owner.query(`SELECT id FROM accounts WHERE code = 'TESOURO'`)).rows[0].id;
    // "renda" de valor declarado 0 que credita o jogador: partidas dobradas fecham, emissão não
    const post = async (amount: bigint) => {
      const c = await t.owner.connect();
      try {
        await c.query('BEGIN');
        const { rows } = await c.query(`INSERT INTO ledger_transactions (kind, user_id, amount) VALUES ('income', $1, 0) RETURNING id`, [p.id]);
        await c.query('INSERT INTO ledger_entries (tx_id, account_id, amount) VALUES ($1, $2, $3), ($1, $4, $5)', [
          rows[0].id,
          acc,
          amount.toString(),
          tes,
          (-amount).toString(),
        ]);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
    };
    await post(12_345n);
    try {
      const r = await checkInvariants(t.ctx.pool);
      expect(r.ok).toBe(false);
      expect(r.unbalancedTx).toEqual([]);
      expect(r.balanceMismatch).toEqual([]);
      expect(BigInt(r.emission) - BigInt(r.expectedEmission)).toBe(12_345n);
    } finally {
      // estorno (mesmo tipo, sentido inverso) para não contaminar os outros testes
      await post(-12_345n);
    }
    expect((await checkInvariants(t.ctx.pool)).ok).toBe(true);
  });

  it('divergência trava a economia (503) até liberação manual', async () => {
    const [lot] = await freeLots(t.owner, 'vacant', 1, { maxBase: 500_000n });
    const acc = (await t.owner.query('SELECT id FROM accounts WHERE user_id = $1', [p.id])).rows[0].id;
    // corrompe o cache de saldo por fora do razão (simula bug/adulteração)
    await t.owner.query('UPDATE accounts SET balance = balance + 1 WHERE id = $1', [acc]);
    try {
      const r = await runInvariantJob(t.ctx.pool, silent);
      expect(r.ok).toBe(false);
      expect(r.balanceMismatch).toContain(String(acc));
      const res = await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('MAINTENANCE');
      const alarms = await t.owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'invariant_violation'`);
      expect(alarms.rows[0].n).toBeGreaterThan(0);
      // leitura continua funcionando
      expect((await call(t.app, p, 'GET', '/api/me/wallet')).statusCode).toBe(200);
    } finally {
      await t.owner.query('UPDATE accounts SET balance = balance - 1 WHERE id = $1', [acc]);
      await setEconomyLock(t.owner, false, 'teste');
    }
    expect((await runInvariantJob(t.ctx.pool, silent)).ok).toBe(true);
    expect((await call(t.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`)).statusCode).toBe(200);
  });
});
