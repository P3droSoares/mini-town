/**
 * Utilitários dos testes: monta o app contra o banco de testes e simula
 * jogadores (cookie de sessão, CSRF, Origin, Idempotency-Key).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { createPool } from '../src/db/pool.js';
import { loadSystemAccounts } from '../src/economy/ledger.js';
import { SESSION_COOKIE, type ServerPolicy } from '../src/security/policy.js';
import { DEFAULT_LIMITS, RateLimiter, type RateLimits } from '../src/security/rateLimit.js';
import { APP_URL, OWNER_URL } from './db.js';
import { CITY_JSON } from './global-setup.js';

export const ORIGIN = 'https://localhost:8443';

const pepper = randomBytes(32);
const emailKey = randomBytes(32);

export const testConfig: AppConfig = {
  env: 'test',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  databaseUrl: APP_URL,
  migrationDatabaseUrl: OWNER_URL,
  pgCa: null,
  appOrigin: ORIGIN,
  sessionKey: randomBytes(32),
  csrfKey: randomBytes(32),
  emailEncKey: emailKey,
  emailEncKeys: new Map([[1, emailKey]]),
  emailHashKey: randomBytes(32),
  passwordPepper: pepper,
  passwordPepperVersion: 1,
  passwordPeppers: new Map([[1, pepper]]),
  emailKeyVersion: 1,
  cityDataPath: CITY_JSON,
  trustProxyHops: 1,
  // proxy de teste (Caddy simulado); os jogadores vêm de 10.x direto
  trustedProxies: ['172.30.99.2'],
};

const HIGH: RateLimits = {
  ip: { capacity: 100_000, perSeconds: 60 },
  user: { capacity: 100_000, perSeconds: 60 },
  authIp: { capacity: 100_000, perSeconds: 60 },
  registerIp: { capacity: 100_000, perSeconds: 60 },
  publicIp: { capacity: 100_000, perSeconds: 60 },
  economyUser: { capacity: 100_000, perSeconds: 60 },
  economyIp: { capacity: 100_000, perSeconds: 60 },
};

/** Política folgada nos testes: sem cache, sem atraso, limites de cadastro altos. */
export const TEST_POLICY: ServerPolicy = {
  signupPerNetPerDay: 100_000,
  signupGlobalPerHour: 100_000,
  publicCacheMs: 0,
  recentSalesDelayMs: 0,
};

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  /** pool do papel dono, para inspeção e "viagem no tempo" nos testes */
  owner: pg.Pool;
  close: () => Promise<void>;
}

export async function makeApp(
  opts: {
    limits?: Partial<RateLimits>;
    authMinResponseMs?: number;
    defaultLimits?: boolean;
    policy?: Partial<ServerPolicy>;
    clock?: () => Date;
  } = {},
): Promise<TestApp> {
  const pool = createPool(APP_URL, testConfig, 30);
  const owner = createPool(OWNER_URL, testConfig, 5);
  const limiter = new RateLimiter();
  const ctx: AppContext = {
    cfg: testConfig,
    pool,
    sys: await loadSystemAccounts(pool),
    limiter,
    limits: { ...(opts.defaultLimits ? DEFAULT_LIMITS : HIGH), ...opts.limits },
    policy: { ...TEST_POLICY, ...opts.policy },
    authMinResponseMs: opts.authMinResponseMs ?? 0,
    clock: opts.clock ?? (() => new Date()),
  };
  const app = await buildApp(ctx);
  await app.ready();
  return {
    app,
    ctx,
    owner,
    close: async () => {
      await app.close();
      limiter.close();
      await pool.end();
      await owner.end();
    },
  };
}

let seq = 0;
/** IP de teste único (cada jogador vem de um IP diferente). */
export const nextIp = () => {
  seq++;
  return `10.${(seq >> 16) & 255}.${(seq >> 8) & 255}.${seq & 255}`;
};

// alfabeto sem caracteres confundíveis (i/l/1, o/0, s/5, r+n, v+v): nomes nunca colidem no esqueleto
const SAFE = 'abcdefghjkpqtuxyz';
const safe = (n: number): string => {
  let out = '';
  do {
    out = SAFE[n % SAFE.length]! + out;
    n = Math.floor(n / SAFE.length);
  } while (n > 0);
  return out;
};
export const uniqueName = (prefix = 'Jog') => `${prefix}${safe(Date.now() % 1_000_000_007).slice(-6)}${safe(seq++)}`;

export interface Player {
  id: string;
  displayName: string;
  email: string;
  password: string;
  token: string;
  csrf: string;
  ip: string;
}

export interface CallOpts {
  body?: unknown;
  /** chave de idempotência: string fixa, true = nova aleatória, false = sem header */
  idem?: string | boolean;
  origin?: string | null;
  csrf?: string | null;
  headers?: Record<string, string>;
  ip?: string;
  rawBody?: string;
  contentType?: string;
}

export function call(
  app: FastifyInstance,
  who: Player | null,
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH',
  url: string,
  o: CallOpts = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...o.headers };
  const unsafe = method !== 'GET';
  const origin = o.origin === undefined ? (unsafe ? ORIGIN : null) : o.origin;
  if (origin) headers.origin = origin;
  const csrf = o.csrf === undefined ? who?.csrf : o.csrf;
  if (unsafe && csrf) headers['x-csrf-token'] = csrf;
  const idem = o.idem ?? (unsafe ? true : false);
  if (idem) headers['idempotency-key'] = idem === true ? randomUUID() : idem;
  let payload: string | undefined;
  if (o.rawBody !== undefined) {
    payload = o.rawBody;
    headers['content-type'] = o.contentType ?? 'application/json';
  } else if (o.body !== undefined) {
    payload = JSON.stringify(o.body);
    headers['content-type'] = o.contentType ?? 'application/json';
  }
  return app.inject({
    method,
    url,
    headers,
    payload,
    remoteAddress: o.ip ?? who?.ip ?? '10.255.255.254',
    cookies: who ? { [SESSION_COOKIE]: who.token } : {},
  });
}

export function sessionCookie(res: LightMyRequestResponse): string | undefined {
  return res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
}

export async function register(app: FastifyInstance, over: Partial<{ displayName: string; email: string; password: string; ip: string }> = {}): Promise<Player> {
  const displayName = over.displayName ?? uniqueName();
  const email = over.email ?? `${displayName.toLowerCase()}@exemplo.test`;
  const password = over.password ?? 'Cavalo-Bateria-Grampo-42';
  const ip = over.ip ?? nextIp();
  const res = await call(app, null, 'POST', '/api/auth/register', { body: { displayName, email, password }, ip, idem: false });
  if (res.statusCode !== 201) throw new Error(`registro falhou: ${res.statusCode} ${res.body}`);
  const body = res.json() as { user: { id: string }; csrfToken: string };
  return { id: body.user.id, displayName, email, password, token: sessionCookie(res)!, csrf: body.csrfToken, ip };
}

export async function login(app: FastifyInstance, p: Pick<Player, 'email' | 'password'>, ip = nextIp()) {
  return call(app, null, 'POST', '/api/auth/login', { body: { email: p.email, password: p.password }, ip, idem: false });
}

/** Saldo atual (centavos) via API. */
export async function balanceOf(app: FastifyInstance, p: Player): Promise<bigint> {
  const res = await call(app, p, 'GET', '/api/me/wallet');
  return BigInt((res.json() as { balance: string }).balance);
}

/** Dá saldo extra a um jogador via razão (ajuste manual do Tesouro), com o papel dono. */
export async function grant(owner: pg.Pool, userId: string, cents: bigint): Promise<void> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query<{ id: bigint }>(`SELECT id FROM accounts WHERE user_id = $1`, [userId]);
    const tes = await c.query<{ id: bigint }>(`SELECT id FROM accounts WHERE code = 'TESOURO'`);
    const tx = await c.query<{ id: bigint }>(
      `INSERT INTO ledger_transactions (kind, user_id, amount) VALUES ('adjustment', $1, $2) RETURNING id`,
      [userId, cents.toString()],
    );
    await c.query(`INSERT INTO ledger_entries (tx_id, account_id, amount) VALUES ($1, $2, $3), ($1, $4, $5)`, [
      tx.rows[0]!.id.toString(),
      rows[0]!.id.toString(),
      cents.toString(),
      tes.rows[0]!.id.toString(),
      (-cents).toString(),
    ]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** Escolhe imóveis sem dono e sem anúncio de uma categoria (evita colisão entre testes). */
let lotCursor = 0;
export async function freeLots(
  owner: pg.Pool,
  category: string,
  n: number,
  opts: { maxBase?: bigint; minBase?: bigint } = {},
): Promise<{ lotId: string; base: bigint }[]> {
  const { rows } = await owner.query<{ lot_id: string; base_price: bigint }>(
    `SELECT lot_id, base_price FROM properties
      WHERE category = $1 AND owner_id IS NULL AND sellable
        AND ($3::bigint IS NULL OR base_price <= $3) AND ($4::bigint IS NULL OR base_price >= $4)
      ORDER BY md5(lot_id || $2::text) LIMIT $5`,
    [category, String(lotCursor++), opts.maxBase?.toString() ?? null, opts.minBase?.toString() ?? null, n],
  );
  return rows.map((r) => ({ lotId: r.lot_id, base: r.base_price }));
}

/** Zera o saldo do jogador (ajuste manual de volta ao Tesouro, papel dono). */
export async function drain(owner: pg.Pool, userId: string): Promise<void> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query<{ id: bigint; balance: bigint }>(`SELECT id, balance FROM accounts WHERE user_id = $1 FOR UPDATE`, [userId]);
    const bal = rows[0]!.balance;
    if (bal > 0n) {
      const tes = await c.query<{ id: bigint }>(`SELECT id FROM accounts WHERE code = 'TESOURO'`);
      const tx = await c.query<{ id: bigint }>(
        `INSERT INTO ledger_transactions (kind, user_id, amount) VALUES ('adjustment', $1, 0) RETURNING id`,
        [userId],
      );
      await c.query(`INSERT INTO ledger_entries (tx_id, account_id, amount) VALUES ($1, $2, $3), ($1, $4, $5)`, [
        tx.rows[0]!.id.toString(),
        rows[0]!.id.toString(),
        (-bal).toString(),
        tes.rows[0]!.id.toString(),
        bal.toString(),
      ]);
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** Envelhece a conta (libera o mercado entre jogadores, que exige idade mínima). */
export async function ageAccount(owner: pg.Pool, userId: string, days = 8): Promise<void> {
  await owner.query(`UPDATE users SET created_at = created_at - make_interval(days => $2) WHERE id = $1`, [userId, days]);
}

/** Saldo de conta de sistema (soma dos lançamentos; não há cache). */
export async function systemBalance(owner: pg.Pool, code: string): Promise<bigint> {
  const { rows } = await owner.query<{ s: string }>(
    `SELECT coalesce(sum(e.amount), 0)::text AS s FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE a.code = $1`,
    [code],
  );
  return BigInt(rows[0]!.s);
}
