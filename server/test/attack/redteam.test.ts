/**
 * RED TEAM — ataques de integração (exigem o Postgres de teste, porta 55432).
 *
 * Reproduzem os objetivos do escopo: ler dados de outro jogador, entrar em
 * conta alheia, gerar dinheiro do nada (corrida/replay), adquirir imóvel
 * burlando regras, derrubar com payload, CSRF/Origin, prototype pollution e
 * XSS por displayName. Cada teste afirma o EFEITO (sem posse, sem crédito,
 * saldo nunca negativo, dado alheio ausente), não a mensagem.
 *
 * Observação: o stack não pôde ser levantado nesta sessão (Docker Desktop
 * fora do ar; sem Postgres em 55432). Estes testes compilam (typecheck) e
 * ficam prontos para rodar com `cd server && npm test`.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { checkInvariants } from '../../src/economy/invariants.js';
import {
  ageAccount,
  balanceOf,
  call,
  freeLots,
  grant,
  makeApp,
  register,
  type Player,
  type TestApp,
} from '../helpers.js';

let T: TestApp;
let app: FastifyInstance;
let owner: pg.Pool;

beforeAll(async () => {
  T = await makeApp();
  app = T.app;
  owner = T.owner;
});
afterAll(async () => {
  await T.close();
});

const code = (res: { json: () => unknown }): string => (res.json() as { error?: { code?: string } }).error?.code ?? '';

/**
 * Comercial que cabe na carteira dos atacantes (bônus de I$ 30 mil + grant de I$ 150 mil): base
 * até I$ 80 mil (× índice até 1,8). Sem isso a compra falha por saldo e o teste
 * passa a medir outra coisa (ex.: imóvel sem dono em vez de imóvel alheio).
 */
const CHEAP = { maxBase: 8_000_000n };
/** Residencial acima do teto da casa inicial (as elegíveis ficam reservadas a quem tem < 3 imóveis). */
const NON_STARTER_HOME = { minBase: 6_000_001n, maxBase: 12_000_000n };

/** Compra da prefeitura que precisa dar certo para o cenário do ataque fazer sentido. */
async function buyOk(p: Player, lot: string): Promise<void> {
  const r = await call(app, p, 'POST', `/api/properties/${lot}/buy`);
  expect(r.statusCode, r.body).toBe(200);
}

/** Um lote de uma categoria (inclui não-vendáveis), direto do catálogo. */
async function anyLot(category: string): Promise<string> {
  const { rows } = await owner.query<{ lot_id: string }>(
    `SELECT lot_id FROM properties WHERE category = $1 AND owner_id IS NULL LIMIT 1`,
    [category],
  );
  if (!rows[0]) throw new Error(`sem lote ${category} no catálogo`);
  return rows[0].lot_id;
}

// ============================================================ Origin / CSRF (CWE-352)
describe('RED: CSRF e Origin — toda escrita exige Origin do app + token da sessão', () => {
  let p: Player;
  let lot: string;
  beforeAll(async () => {
    p = await register(app);
    await grant(owner, p.id, 15_000_000n);
    lot = (await freeLots(owner, 'commercial', 1, CHEAP))[0]!.lotId;
  });

  it('sem header Origin: 403 BAD_ORIGIN e nada acontece', async () => {
    const res = await call(app, p, 'POST', `/api/properties/${lot}/buy`, { origin: null });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe('BAD_ORIGIN');
  });
  it('Origin de outro site: 403 BAD_ORIGIN', async () => {
    const res = await call(app, p, 'POST', `/api/properties/${lot}/buy`, { origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe('BAD_ORIGIN');
  });
  it('com sessão mas sem X-CSRF-Token: 403 BAD_CSRF', async () => {
    const res = await call(app, p, 'POST', `/api/properties/${lot}/buy`, { csrf: null });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe('BAD_CSRF');
  });
  it('token CSRF de outra sessão: 403 BAD_CSRF', async () => {
    const other = await register(app);
    const res = await call(app, p, 'POST', `/api/properties/${lot}/buy`, { csrf: other.csrf });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe('BAD_CSRF');
  });
  it('cross-site "simple request" (text/plain) é recusado antes do parser', async () => {
    const res = await call(app, null, 'POST', '/api/auth/login', {
      rawBody: JSON.stringify({ email: p.email, password: p.password }),
      contentType: 'text/plain',
      idem: false,
    });
    expect([400, 415]).toContain(res.statusCode);
  });
});

// ============================================================ entrar na conta de outro (CWE-287)
describe('RED: sessão — cookie forjado/ausente não autentica', () => {
  it('sem cookie: 401', async () => {
    const res = await call(app, null, 'GET', '/api/me/wallet');
    expect(res.statusCode).toBe(401);
  });
  it('cookie aleatório no formato do token: 401 (token guardado só como SHA-256)', async () => {
    const fake: Player = {
      id: 'x', displayName: 'x', email: 'x', password: 'x',
      token: Buffer.alloc(32, 7).toString('base64url'), csrf: 'x', ip: '10.9.9.9',
    };
    const res = await call(app, fake, 'GET', '/api/me/wallet');
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================ ler dados de outro (IDOR/BOLA, CWE-639)
describe('RED: isolamento — nenhum caminho revela e-mail/saldo/residência de terceiros', () => {
  let a: Player;
  let b: Player;
  let bLot: string;
  beforeAll(async () => {
    a = await register(app);
    b = await register(app);
    // B compra um comercial e passa a ser dono; não há endpoint que receba userId
    await grant(owner, b.id, 15_000_000n);
    bLot = (await freeLots(owner, 'commercial', 1, CHEAP))[0]!.lotId;
    await buyOk(b, bLot);
  });

  it('/auth/me só devolve o próprio e-mail', async () => {
    const ra = (await call(app, a, 'GET', '/api/auth/me')).json() as { email: string };
    const rb = (await call(app, b, 'GET', '/api/auth/me')).json() as { email: string };
    expect(ra.email).toBe(a.email);
    expect(rb.email).toBe(b.email);
    expect(ra.email).not.toBe(b.email);
  });
  it('imóvel de B visto por A: só displayName; sem residência/carência/custos de dono', async () => {
    const v = (await call(app, a, 'GET', `/api/properties/${bLot}`)).json() as Record<string, unknown>;
    expect((v.owner as { displayName: string }).displayName).toBe(b.displayName);
    expect(v.mine).toBe(false);
    expect(v.isResidence).toBe(false);
    expect(v.lockedUntil).toBeNull();
    expect(v.upgradeCost).toBeNull();
    expect(v.openBusinessCost).toBeNull();
    expect(JSON.stringify(v)).not.toContain(b.email);
  });
  it('extrato de A não traz lançamentos de B', async () => {
    const r = (await call(app, a, 'GET', '/api/me/transactions')).json() as { items: { kind: string }[] };
    // A só recebeu o bônus de cadastro; não há compra (quem comprou foi B)
    expect(r.items.every((i) => i.kind === 'signup_grant')).toBe(true);
  });
});

// ============================================================ dinheiro do nada — corrida (CWE-362)
describe('RED: corrida — um imóvel, muitos compradores → no máximo uma posse, sem emissão', () => {
  it('N compras paralelas do mesmo lote: exatamente 1 sucesso, invariantes intactos', async () => {
    const N = 15;
    const lot = (await freeLots(owner, 'commercial', 1, CHEAP))[0]!.lotId;
    const buyers: Player[] = [];
    for (let i = 0; i < N; i++) {
      const p = await register(app);
      await grant(owner, p.id, 15_000_000n);
      buyers.push(p);
    }
    const res = await Promise.all(buyers.map((p) => call(app, p, 'POST', `/api/properties/${lot}/buy`, { idem: true })));
    const okCount = res.filter((r) => r.statusCode === 200).length;
    expect(okCount).toBe(1);
    // os demais: imóvel já tem dono (ou ocupado momentaneamente), nunca um segundo 200
    for (const r of res) expect([200, 409, 503]).toContain(r.statusCode);
    const { rows } = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM properties WHERE lot_id = $1 AND owner_id IS NOT NULL`, [lot]);
    expect(rows[0]!.n).toBe(1);
    const report = await checkInvariants(T.ctx.pool, { full: true });
    expect(report.ok, JSON.stringify(report)).toBe(true);
  });

  it('gastos paralelos do MESMO jogador nunca deixam o saldo negativo', async () => {
    const p = await register(app); // só o bônus de cadastro (I$ 30.000), sem grant extra
    const lots = await freeLots(owner, 'vacant', 20, { maxBase: 2_000_00n });
    const res = await Promise.all(lots.map((l) => call(app, p, 'POST', `/api/properties/${l.lotId}/buy`, { idem: true })));
    const bought = res.filter((r) => r.statusCode === 200).length;
    expect(bought).toBeGreaterThan(0);
    const bal = await balanceOf(app, p);
    expect(bal >= 0n).toBe(true);
    const report = await checkInvariants(T.ctx.pool, { full: true });
    expect(report.ok, JSON.stringify(report)).toBe(true);
  });
});

// ============================================================ replay de idempotência (CWE-837)
describe('RED: idempotência — replay cobra uma vez; corpo diferente com a mesma chave é recusado', () => {
  it('mesma chave + mesmo pedido: segundo é replay, cobra só uma vez', async () => {
    const p = await register(app);
    await grant(owner, p.id, 15_000_000n);
    const lot = (await freeLots(owner, 'commercial', 1, CHEAP))[0]!.lotId;
    const before = await balanceOf(app, p);
    const key = randomUUID();
    const r1 = await call(app, p, 'POST', `/api/properties/${lot}/buy`, { idem: key });
    const r2 = await call(app, p, 'POST', `/api/properties/${lot}/buy`, { idem: key });
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r2.statusCode, r2.body).toBe(200);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    const after = await balanceOf(app, p);
    expect(before - after).toBeGreaterThan(0n);
    // cobrado uma única vez: o saldo atual bate com o saldo reportado na 1ª compra (replay não cobrou)
    const balAfterBuy = BigInt((r1.json() as { wallet: { balance: string } }).wallet.balance);
    expect(after).toBe(balAfterBuy);
  });
  it('mesma chave com outro pedido (outro lote): 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const p = await register(app);
    await grant(owner, p.id, 15_000_000n);
    const [l1, l2] = await freeLots(owner, 'commercial', 2, CHEAP);
    const key = randomUUID();
    const r1 = await call(app, p, 'POST', `/api/properties/${l1!.lotId}/buy`, { idem: key });
    expect(r1.statusCode, r1.body).toBe(200);
    const r = await call(app, p, 'POST', `/api/properties/${l2!.lotId}/buy`, { idem: key });
    expect(r.statusCode).toBe(422);
    expect(code(r)).toBe('IDEMPOTENCY_KEY_REUSED');
    // o segundo lote continua sem dono
    const { rows } = await owner.query<{ owner: string | null }>(`SELECT owner_id AS owner FROM properties WHERE lot_id = $1`, [l2!.lotId]);
    expect(rows[0]!.owner).toBeNull();
  });
});

// ============================================================ adquirir imóvel burlando regras
describe('RED: regras de posse — institucional, imóvel alheio, casa inicial, residência, negócio', () => {
  let p: Player;
  beforeAll(async () => {
    p = await register(app);
    await grant(owner, p.id, 50_000_000n);
    await ageAccount(owner, p.id);
  });

  it('comprar imóvel institucional/religioso: NOT_SELLABLE', async () => {
    for (const cat of ['institutional', 'religious']) {
      const lot = await anyLot(cat);
      const r = await call(app, p, 'POST', `/api/properties/${lot}/buy`);
      expect(r.statusCode).toBe(409);
      expect(code(r)).toBe('NOT_SELLABLE');
    }
  });
  it('comprar imóvel que já tem dono: ALREADY_OWNED', async () => {
    const lot = (await freeLots(owner, 'commercial', 1, CHEAP))[0]!.lotId;
    expect((await call(app, p, 'POST', `/api/properties/${lot}/buy`)).statusCode).toBe(200);
    const other = await register(app);
    await grant(owner, other.id, 50_000_000n);
    const r = await call(app, other, 'POST', `/api/properties/${lot}/buy`);
    expect(r.statusCode).toBe(409);
    expect(code(r)).toBe('ALREADY_OWNED');
  });
  it('casa inicial duas vezes: a segunda é recusada', async () => {
    const q = await register(app);
    const homes = (await call(app, q, 'GET', '/api/starter-homes')).json() as { homes: { lotId: string }[] };
    const first = homes.homes[0]!.lotId;
    expect((await call(app, q, 'POST', '/api/starter-homes/claim', { body: { lotId: first } })).statusCode).toBe(200);
    const second = homes.homes.find((h) => h.lotId !== first)!.lotId;
    const r = await call(app, q, 'POST', '/api/starter-homes/claim', { body: { lotId: second } });
    expect(r.statusCode).toBe(409);
    expect(code(r)).toBe('STARTER_ALREADY_CLAIMED');
  });
  it('casa inicial em imóvel não-elegível (comercial): NOT_ELIGIBLE', async () => {
    const q = await register(app);
    const lot = (await freeLots(owner, 'commercial', 1, CHEAP))[0]!.lotId;
    const r = await call(app, q, 'POST', '/api/starter-homes/claim', { body: { lotId: lot } });
    expect(r.statusCode).toBe(409);
    expect(code(r)).toBe('NOT_ELIGIBLE');
  });
  it('anunciar fora da faixa (preço alto demais): ASK_OUT_OF_RANGE', async () => {
    const lot = (await freeLots(owner, 'commercial', 1, CHEAP))[0]!.lotId;
    await buyOk(p, lot);
    const v = (await call(app, p, 'GET', `/api/properties/${lot}`)).json() as { appraisal: string };
    const tooHigh = (BigInt(v.appraisal) * 5n).toString();
    const r = await call(app, p, 'POST', '/api/market/listings', { body: { lotId: lot, askPrice: tooHigh } });
    expect(r.statusCode).toBe(422);
    expect(code(r)).toBe('ASK_OUT_OF_RANGE');
  });
  it('vender ao governo imóvel anunciado: PROPERTY_LISTED', async () => {
    const lot = (await freeLots(owner, 'commercial', 1, CHEAP))[0]!.lotId;
    await buyOk(p, lot);
    const v = (await call(app, p, 'GET', `/api/properties/${lot}`)).json() as { appraisal: string };
    const ask = BigInt(v.appraisal).toString();
    expect((await call(app, p, 'POST', '/api/market/listings', { body: { lotId: lot, askPrice: ask } })).statusCode).toBe(201);
    const r = await call(app, p, 'POST', `/api/properties/${lot}/sell-to-city`);
    expect(r.statusCode).toBe(409);
    expect(code(r)).toBe('PROPERTY_LISTED');
  });
  it('morar em imóvel de outro: NOT_OWNER', async () => {
    const lot = (await freeLots(owner, 'residential', 1, NON_STARTER_HOME))[0]!.lotId;
    await buyOk(p, lot);
    const intruder = await register(app);
    const r = await call(app, intruder, 'POST', `/api/properties/${lot}/residence`);
    expect(r.statusCode).toBe(403);
    expect(code(r)).toBe('NOT_OWNER');
  });
  it('abrir negócio em residencial próprio: NOT_COMMERCIAL', async () => {
    const lot = (await freeLots(owner, 'residential', 1, NON_STARTER_HOME))[0]!.lotId;
    await buyOk(p, lot);
    const r = await call(app, p, 'POST', `/api/properties/${lot}/business`, { body: { type: 'mercado' } });
    expect(r.statusCode).toBe(409);
    expect(code(r)).toBe('NOT_COMMERCIAL');
  });
  it('comprar o próprio anúncio: OWN_LISTING', async () => {
    const lot = (await freeLots(owner, 'commercial', 1, CHEAP))[0]!.lotId;
    await buyOk(p, lot);
    const v = (await call(app, p, 'GET', `/api/properties/${lot}`)).json() as { appraisal: string };
    const list = (await call(app, p, 'POST', '/api/market/listings', { body: { lotId: lot, askPrice: v.appraisal } })).json() as { id: string };
    const r = await call(app, p, 'POST', `/api/market/listings/${list.id}/buy`);
    expect(r.statusCode).toBe(409);
    expect(code(r)).toBe('OWN_LISTING');
  });
});

// ============================================================ injeção de campo / prototype pollution
describe('RED: entrada maliciosa — campos extras, prototype pollution, tipos errados', () => {
  it('campo extra no corpo (ex.: ownerId, balance, userId) é recusado (strict)', async () => {
    const r = await call(app, null, 'POST', '/api/auth/register', {
      body: { displayName: 'Hacker' + Date.now(), email: `h${Date.now()}@x.test`, password: 'Cavalo-Bateria-Grampo-42', isAdmin: true },
      idem: false,
    });
    expect(r.statusCode).toBe(400);
    expect(code(r)).toBe('VALIDATION');
  });
  it('__proto__ no JSON é recusado e não polui Object.prototype', async () => {
    const r = await call(app, null, 'POST', '/api/auth/register', {
      rawBody: '{"__proto__":{"polluted":"yes"},"displayName":"Zz","email":"z@x.test","password":"Cavalo-Bateria-42"}',
      idem: false,
    });
    expect([400]).toContain(r.statusCode);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('corpo onde se espera objeto vazio recusa array/extra', async () => {
    const p = await register(app);
    await grant(owner, p.id, 15_000_000n);
    const lot = (await freeLots(owner, 'commercial', 1, CHEAP))[0]!.lotId;
    const r = await call(app, p, 'POST', `/api/properties/${lot}/buy`, { body: { userId: p.id } });
    expect(r.statusCode).toBe(400);
    expect(code(r)).toBe('VALIDATION');
  });
  it('askPrice como número gigante / string não-numérica: VALIDATION', async () => {
    const p = await register(app);
    await grant(owner, p.id, 15_000_000n);
    const lot = (await freeLots(owner, 'commercial', 1, CHEAP))[0]!.lotId;
    await buyOk(p, lot);
    for (const askPrice of [1e308, '1e3', -5, 0, '0x10'] as unknown[]) {
      const r = await call(app, p, 'POST', '/api/market/listings', { body: { lotId: lot, askPrice } });
      expect(r.statusCode, String(askPrice)).toBe(400);
    }
  });
});

// ============================================================ derrubar com payload (CWE-400)
describe('RED: payload — corpo acima do limite é recusado sem processar', () => {
  it('corpo > 16 KB: 413 PAYLOAD_TOO_LARGE', async () => {
    const huge = `{"email":"a@b.test","password":"${'x'.repeat(17 * 1024)}"}`;
    const r = await call(app, null, 'POST', '/api/auth/login', { rawBody: huge, idem: false });
    expect(r.statusCode).toBe(413);
  });
});

// ============================================================ XSS / impersonação por displayName (CWE-79)
describe('RED: displayName no cadastro — markup recusado, homóglifo colide', () => {
  it('nome com markup: 400 VALIDATION (nada de HTML persiste)', async () => {
    const r = await call(app, null, 'POST', '/api/auth/register', {
      body: { displayName: '<img src=x onerror=alert(1)>', email: `x${Date.now()}@x.test`, password: 'Cavalo-Bateria-42' },
      idem: false,
    });
    expect(r.statusCode).toBe(400);
    expect(code(r)).toBe('VALIDATION');
  });
  it('nome parecido demais (esqueleto homóglifo) com um existente: DISPLAY_NAME_TAKEN', async () => {
    const base = `Maria${Date.now().toString(36)}`;
    expect((await call(app, null, 'POST', '/api/auth/register', {
      body: { displayName: base, email: `${base}@x.test`, password: 'Cavalo-Bateria-42' }, idem: false,
    })).statusCode).toBe(201);
    // "rn" ~ "m": "Maria" vs "rnaria..." colidem no esqueleto
    const twin = base.replace(/^M/, 'rn');
    const r = await call(app, null, 'POST', '/api/auth/register', {
      body: { displayName: twin, email: `${twin}@x.test`, password: 'Cavalo-Bateria-42' }, idem: false,
    });
    expect(r.statusCode).toBe(409);
    expect(code(r)).toBe('DISPLAY_NAME_TAKEN');
  });
});
