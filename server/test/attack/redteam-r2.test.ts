/**
 * RED TEAM, 2ª rodada — ataques de integração (Postgres de teste, porta 55432).
 *
 * - IPTU zerado por arredondamento: coletas a cada 1,5 s num terreno vago
 *   (relógio da operação controlado pelo teste) cobram o mesmo IPTU que uma
 *   coleta única do período inteiro.
 * - X-Forwarded-For forjado: quem conecta direto no server (não é o Caddy)
 *   não escolhe o próprio IP — os limites por IP e por rede continuam valendo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accrual, appraisal } from '../../src/economy/pricing.js';
import { call, freeLots, grant, makeApp, register, uniqueName, type Player, type TestApp } from '../helpers.js';

const CADDY = '172.30.99.2'; // = testConfig.trustedProxies

// ============================================================ IPTU (CWE-682)
describe('RED r2: coleta a cada 1,5 s não zera o IPTU de terreno vago', () => {
  let T: TestApp;
  const base = Date.now();
  let offset = 0;
  beforeAll(async () => {
    // relógio parado: só o teste o avança (sem deriva do tempo real entre requisições)
    T = await makeApp({ clock: () => new Date(base + offset) });
  });
  afterAll(async () => {
    await T.close();
  });

  it('400 coletas de 1,5 s = 1 coleta de 600 s (±1 centavo)', async () => {
    const p: Player = await register(T.app);
    await grant(T.owner, p.id, 50_000_000n);
    // terrenos vagos do catálogo valem até ~I$ 5,4 mil (25/m²): bem menos de 1 centavo de
    // IPTU a cada 1,5 s. Janela de 600 s para o total ainda ser > 10 centavos.
    const STEPS = 400;
    const WINDOW_MS = STEPS * 1_500;
    const [lot] = await freeLots(T.owner, 'vacant', 1, { minBase: 400_000n });
    expect(lot, 'catálogo sem terreno vago na faixa').toBeTruthy();
    const buy = await call(T.app, p, 'POST', `/api/properties/${lot!.lotId}/buy`);
    expect(buy.statusCode, buy.body).toBe(200);

    const ix = (await T.owner.query<{ index_bp: number; ema_bp: number }>(
      `SELECT index_bp, ema_bp FROM market_indices WHERE category = 'vacant'`,
    )).rows[0] ?? { index_bp: 10_000, ema_bp: 10_000 };
    const taxAppraisal = appraisal(lot!.base, Math.max(ix.index_bp, ix.ema_bp));
    const t0 = new Date(base);
    const rec = { category: 'vacant' as const, appraisal: taxAppraisal, isResidence: false, business: null };
    const expected = accrual(rec, t0, new Date(base + WINDOW_MS), taxAppraisal).tax;
    // pré-condição do ataque: cada coleta isolada daria 0
    expect(accrual(rec, t0, new Date(base + 1_500), taxAppraisal).tax).toBe(0n);
    expect(expected).toBeGreaterThan(10n);

    let spam = 0n;
    for (let i = 0; i < STEPS; i++) {
      offset += 1_500;
      const res = await call(T.app, p, 'POST', '/api/income/collect');
      expect(res.statusCode, res.body).toBe(200);
      spam += BigInt((res.json() as { tax: string }).tax);
    }
    const d = spam - expected;
    expect(d >= -1n && d <= 1n, `${STEPS}×1,5 s cobrou ${spam}, ${WINDOW_MS / 1000} s cobra ${expected}`).toBe(true);

    // o resto fracionário fica no relógio: a próxima coleta da janela inteira também bate
    offset += WINDOW_MS;
    const once = BigInt(((await call(T.app, p, 'POST', '/api/income/collect')).json() as { tax: string }).tax);
    expect(once >= expected - 1n && once <= expected + 1n, `${WINDOW_MS / 1000} s cobrou ${once}`).toBe(true);
  });
});

// ============================================================ X-Forwarded-For (CWE-348)
describe('RED r2: X-Forwarded-For só vale vindo do Caddy', () => {
  let T: TestApp;
  beforeAll(async () => {
    T = await makeApp({
      limits: {
        publicIp: { capacity: 3, perSeconds: 3600 },
        registerIp: { capacity: 2, perSeconds: 3600 },
      },
    });
  });
  afterAll(async () => {
    await T.close();
  });

  let n = 0;
  const fakeIp = () => `198.51.100.${++n % 250}`;
  const leaderboard = (ip: string, xff: string) =>
    call(T.app, null, 'GET', '/api/leaderboard', { ip, headers: { 'x-forwarded-for': xff } });

  it('par direto (web/LAN) trocando o X-F-F a cada requisição continua limitado pelo IP real', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await leaderboard('10.77.0.5', fakeIp())).statusCode);
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });

  it('pelo Caddy o X-F-F é o cliente: clientes distintos têm limites distintos', async () => {
    for (let i = 0; i < 5; i++) expect((await leaderboard(CADDY, fakeIp())).statusCode).toBe(200);
  });

  it('pelo Caddy, entradas forjadas à esquerda do X-F-F não mudam o IP (só o salto mais à direita)', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await leaderboard(CADDY, `${fakeIp()}, 203.0.113.77`)).statusCode);
    expect(codes.slice(3)).toEqual([429, 429]);
  });

  it('farm de contas: X-F-F forjado não contorna o limite de cadastro por rede', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const displayName = uniqueName('Syb');
      const res = await call(T.app, null, 'POST', '/api/auth/register', {
        body: { displayName, email: `${displayName.toLowerCase()}@exemplo.test`, password: 'Cavalo-Bateria-Grampo-42' },
        ip: '10.77.1.9',
        headers: { 'x-forwarded-for': fakeIp() },
        idem: false,
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 2)).toEqual([201, 201]);
    expect(codes.slice(2).every((c) => c === 429)).toBe(true);
  });
});
