import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ageAccount, call, freeLots, grant, makeApp, nextIp, register, type Player, type TestApp } from './helpers.js';

let t: TestApp;
let a: Player;
let b: Player;
let lotA: string;

beforeAll(async () => {
  t = await makeApp();
  a = await register(t.app);
  b = await register(t.app);
  await grant(t.owner, a.id, 50_000_000n);
  await ageAccount(t.owner, a.id);
  const [lot] = await freeLots(t.owner, 'residential', 1, { maxBase: 3_000_000n });
  lotA = lot!.lotId;
  const res = await call(t.app, a, 'POST', `/api/properties/${lotA}/buy`);
  expect(res.statusCode).toBe(200);
});
afterAll(async () => {
  await t.close();
});

describe('cabeçalhos e formato de erro', () => {
  it('envia cabeçalhos de segurança em toda resposta', async () => {
    const res = await call(t.app, null, 'GET', '/api/health');
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['permissions-policy']).toBeTruthy();
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('404 e erros sem stack trace, no formato { error: { code, message } }', async () => {
    const res = await call(t.app, null, 'GET', '/api/nao-existe');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
    const bad = await call(t.app, a, 'POST', '/api/market/listings', { rawBody: '{"lotId": ' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toMatch(/at .*\.ts|stack|node_modules/i);
  });
});

describe('Origin + CSRF', () => {
  const url = () => `/api/properties/${lotA}/residence`;

  it('sem token CSRF = 403', async () => {
    const res = await call(t.app, a, 'POST', url(), { csrf: null });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('BAD_CSRF');
  });

  it('token CSRF de outra sessão = 403', async () => {
    const res = await call(t.app, a, 'POST', url(), { csrf: b.csrf });
    expect(res.statusCode).toBe(403);
  });

  it('Origin ausente ou de outro site = 403', async () => {
    expect((await call(t.app, a, 'POST', url(), { origin: null })).json().error.code).toBe('BAD_ORIGIN');
    expect((await call(t.app, a, 'POST', url(), { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await call(t.app, a, 'POST', url(), { origin: 'https://localhost:8443.evil.example' })).statusCode).toBe(403);
    // login também exige Origin (login CSRF)
    const login = await call(t.app, null, 'POST', '/api/auth/login', {
      body: { email: a.email, password: a.password },
      origin: 'https://evil.example',
      idem: false,
    });
    expect(login.statusCode).toBe(403);
  });

  it('logout exige CSRF quando há sessão', async () => {
    const res = await call(t.app, a, 'POST', '/api/auth/logout', { csrf: null, idem: false });
    expect(res.statusCode).toBe(403);
    expect((await call(t.app, a, 'GET', '/api/auth/me')).statusCode).toBe(200);
  });

  it('com Origin e CSRF válidos a operação passa', async () => {
    const res = await call(t.app, a, 'POST', url());
    expect(res.statusCode).toBe(200);
    expect(res.json().property.isResidence).toBe(true);
  });
});

describe('validação de entrada', () => {
  it('corpo só em JSON: text/plain e form são recusados', async () => {
    const res = await call(t.app, a, 'POST', '/api/market/listings', {
      rawBody: JSON.stringify({ lotId: lotA, askPrice: 100 }),
      contentType: 'text/plain',
    });
    expect(res.statusCode).toBe(415);
    const form = await call(t.app, a, 'POST', '/api/market/listings', { rawBody: 'lotId=x', contentType: 'application/x-www-form-urlencoded' });
    expect(form.statusCode).toBe(415);
  });

  it('corpo acima de 16 KB = 413', async () => {
    const res = await call(t.app, a, 'POST', '/api/starter-homes/claim', { rawBody: JSON.stringify({ lotId: 'ITB-' + 'A'.repeat(20_000) }) });
    expect(res.statusCode).toBe(413);
  });

  it('__proto__ / constructor no JSON = 400', async () => {
    const res = await call(t.app, a, 'POST', '/api/starter-homes/claim', { rawBody: '{"lotId":"ITB-W1","__proto__":{"admin":true}}' });
    expect(res.statusCode).toBe(400);
    const res2 = await call(t.app, a, 'POST', '/api/starter-homes/claim', { rawBody: '{"lotId":"ITB-W1","constructor":{"prototype":{"x":1}}}' });
    expect(res2.statusCode).toBe(400);
  });

  it('lotId malicioso é rejeitado antes de chegar ao banco', async () => {
    const evil = [
      "ITB-W1' OR '1'='1",
      'ITB-../../etc/passwd',
      '../ITB-W1',
      'itb-w1',
      'ITB-',
      'ITB-' + 'A'.repeat(41),
      'ITB-W1;DROP TABLE users',
      'ITB-W1%00',
    ];
    for (const lotId of evil) {
      const r1 = await call(t.app, a, 'GET', `/api/properties/${encodeURIComponent(lotId)}`);
      expect([400, 404], lotId).toContain(r1.statusCode);
      const r2 = await call(t.app, a, 'POST', '/api/starter-homes/claim', { body: { lotId } });
      expect(r2.statusCode, lotId).toBe(400);
    }
    const ok = await t.owner.query('SELECT count(*)::int AS n FROM users');
    expect(ok.rows[0].n).toBeGreaterThan(0);
  });

  it('campos extras são rejeitados (cliente não manda preço, dono, saldo, userId)', async () => {
    const bodies = [
      { lotId: lotA, price: 1 },
      { lotId: lotA, ownerId: b.id },
      { lotId: lotA, userId: b.id },
      { lotId: lotA, balance: '999999999' },
    ];
    for (const body of bodies) {
      const res = await call(t.app, a, 'POST', '/api/starter-homes/claim', { body });
      expect(res.statusCode).toBe(400);
    }
    const buy = await call(t.app, b, 'POST', `/api/properties/${lotA}/buy`, { body: { price: 1 } });
    expect(buy.statusCode).toBe(400);
  });

  it('preço de anúncio: negativo, zero, float, gigante, notação científica e string não numérica = 400', async () => {
    for (const askPrice of [-100, 0, 10.5, 1e300, Number.MAX_SAFE_INTEGER + 2, '1e9', '-5', '12.50', 'abc', null, true, '0x10', '99999999999999999999']) {
      const res = await call(t.app, a, 'POST', '/api/market/listings', { body: { lotId: lotA, askPrice } });
      expect(res.statusCode, String(askPrice)).toBe(400);
    }
  });

  it('query string estrita (parâmetros desconhecidos ou repetidos = 400)', async () => {
    expect((await call(t.app, a, 'GET', '/api/market/listings?category=residential&admin=1')).statusCode).toBe(400);
    expect((await call(t.app, a, 'GET', '/api/market/listings?category=foo')).statusCode).toBe(400);
    expect((await call(t.app, a, 'GET', '/api/me/transactions?cursor=1&cursor=2')).statusCode).toBe(400);
    expect((await call(t.app, a, 'GET', '/api/me/transactions?cursor=-1')).statusCode).toBe(400);
  });

  it('id de anúncio inválido = 400', async () => {
    const res = await call(t.app, a, 'POST', `/api/market/listings/${encodeURIComponent("1' OR 1=1")}/buy`);
    expect(res.statusCode).toBe(400);
  });
});

describe('isolamento entre jogadores (IDOR)', () => {
  it('B não age sobre imóvel de A', async () => {
    for (const path of ['sell-to-city', 'residence', 'business/upgrade']) {
      const res = await call(t.app, b, 'POST', `/api/properties/${lotA}/${path}`);
      expect(res.statusCode, path).toBe(403);
    }
    const biz = await call(t.app, b, 'POST', `/api/properties/${lotA}/business`, { body: { type: 'loja' } });
    expect(biz.statusCode).toBe(403);
    const list = await call(t.app, b, 'POST', '/api/market/listings', { body: { lotId: lotA, askPrice: '100000' } });
    expect(list.statusCode).toBe(403);
    const buy = await call(t.app, b, 'POST', `/api/properties/${lotA}/buy`);
    expect(buy.statusCode).toBe(409);
  });

  it('B não cancela nem vê dados privados do anúncio de A', async () => {
    const view = (await call(t.app, a, 'GET', `/api/properties/${lotA}`)).json();
    const create = await call(t.app, a, 'POST', '/api/market/listings', { body: { lotId: lotA, askPrice: view.appraisal } });
    expect(create.statusCode).toBe(201);
    const listingId = create.json().id;
    const del = await call(t.app, b, 'DELETE', `/api/market/listings/${listingId}`);
    expect(del.statusCode).toBe(403);
    const fromB = (await call(t.app, b, 'GET', `/api/properties/${lotA}`)).json();
    expect(fromB.owner).toEqual({ displayName: a.displayName });
    expect(fromB.mine).toBe(false);
    expect(fromB.isResidence).toBe(false); // residência de terceiros não vaza
    expect(fromB.lockedUntil).toBeNull();
    expect(JSON.stringify(fromB)).not.toContain(a.id);
    expect((await call(t.app, a, 'DELETE', `/api/market/listings/${listingId}`)).statusCode).toBe(204);
  });

  it('carteira, imóveis e extrato são sempre do usuário da sessão', async () => {
    const wb = (await call(t.app, b, 'GET', '/api/me/wallet')).json();
    expect(wb.balance).toBe('3000000');
    const pb = (await call(t.app, b, 'GET', '/api/me/properties')).json();
    expect(pb.properties).toEqual([]);
    const tb = (await call(t.app, b, 'GET', '/api/me/transactions')).json();
    expect(tb.items).toHaveLength(1);
    expect(tb.items[0].kind).toBe('signup_grant');
    // tentar passar userId na query não muda nada (e é rejeitado)
    expect((await call(t.app, b, 'GET', `/api/me/wallet?userId=${a.id}`)).json().balance).toBe('3000000');
    expect((await call(t.app, b, 'GET', `/api/me/transactions?userId=${a.id}`)).statusCode).toBe(400);
  });

  it('ranking e mercado não expõem e-mail, id ou saldo exato', async () => {
    const lb = (await call(t.app, null, 'GET', '/api/leaderboard')).json();
    const text = JSON.stringify(lb);
    expect(text).not.toContain(a.email);
    expect(text).not.toContain(a.id);
    for (const item of lb.items) expect(BigInt(item.netWorth) % 100_000n).toBe(0n);
    const ov = JSON.stringify((await call(t.app, null, 'GET', '/api/market/overview')).json());
    expect(ov).not.toContain(a.id);
    expect(ov).not.toContain(a.email);
  });

  it('rota de /api sem política de acesso declarada impede o boot (fail-closed)', async () => {
    const app = await buildApp(t.ctx);
    let failed = false;
    try {
      app.get('/api/esquecida', async () => ({ segredo: true }));
      await app.ready();
    } catch (e) {
      failed = /config\.auth/.test((e as Error).message);
    } finally {
      await app.close().catch(() => {});
    }
    expect(failed).toBe(true);
  });

  it('rotas privadas exigem sessão', async () => {
    for (const url of ['/api/me/wallet', '/api/me/properties', '/api/me/transactions', '/api/properties/ownership', '/api/starter-homes', '/api/market/listings', `/api/properties/${lotA}`]) {
      expect((await call(t.app, null, 'GET', url, { ip: nextIp() })).statusCode, url).toBe(401);
    }
  });
});
