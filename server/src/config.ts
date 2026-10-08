/**
 * Configuração do server a partir de variáveis de ambiente, validada com zod
 * no boot. Faltou segredo ou formato inválido = o processo não sobe.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseTrustedProxies } from './security/proxy.js';

/** Chave simétrica: base64 (ou base64url) de exatamente 32 bytes. */
const key32 = z
  .string()
  .trim()
  .min(1)
  .transform((s, ctx) => {
    if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(s) || Buffer.from(s, 'base64').length !== 32) {
      ctx.addIssue({ code: 'custom', message: 'precisa ser base64 de 32 bytes' });
      return z.NEVER;
    }
    return Buffer.from(s, 'base64');
  });

const pgUrl = z
  .string()
  .trim()
  .refine((s) => /^postgres(ql)?:\/\//.test(s), 'precisa ser uma URL postgres://');

const version = z.coerce.number().int().min(1).max(255);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // fora do Docker só escuta localmente (o compose define 0.0.0.0 na rede do proxy)
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: pgUrl,
  // opcional: sem ela o server não migra (serviço `migrate` separado) e só confere a versão do esquema
  MIGRATION_DATABASE_URL: pgUrl.optional(),
  PGSSLROOTCERT: z.string().trim().min(1).optional(),
  APP_ORIGIN: z
    .string()
    .trim()
    .url()
    .transform((s) => new URL(s).origin),
  SESSION_KEY: key32,
  CSRF_KEY: key32,
  EMAIL_ENC_KEY: key32,
  EMAIL_HASH_KEY: key32,
  PASSWORD_PEPPER: key32.optional(),
  PASSWORD_PEPPER_VERSION: version.default(1),
  EMAIL_KEY_VERSION: version.default(1),
  CITY_DATA_PATH: z.string().trim().min(1).default('../public/data/itabirito.json'),
  // 0 = X-Forwarded-For ignorado; > 0 exige TRUSTED_PROXIES (IP/CIDR do proxy)
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  TRUSTED_PROXIES: z.string().trim().default(''),
});

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  /** papel dono: só no boot (null = migração feita por outro processo) */
  migrationDatabaseUrl: string | null;
  /** CA do Postgres (PEM); presente = TLS verify-full */
  pgCa: string | null;
  appOrigin: string;
  sessionKey: Buffer;
  csrfKey: Buffer;
  /** chave atual do e-mail (versão emailKeyVersion) */
  emailEncKey: Buffer;
  /** todas as chaves de e-mail conhecidas (atual + antigas EMAIL_ENC_KEY_<n>) */
  emailEncKeys: ReadonlyMap<number, Buffer>;
  emailHashKey: Buffer;
  /** pepper atual (null = sem pepper) e sua versão (gravada no hash: `p<versão>$`) */
  passwordPepper: Buffer | null;
  passwordPepperVersion: number;
  /** peppers conhecidos (atual + antigos PASSWORD_PEPPER_<n>) */
  passwordPeppers: ReadonlyMap<number, Buffer>;
  emailKeyVersion: number;
  cityDataPath: string;
  trustProxyHops: number;
  /** endereços/CIDRs dos proxies que podem informar o IP do cliente */
  trustedProxies: readonly string[];
}

/** Lê chaves versionadas `PREFIX_<n>` do ambiente. */
function versionedKeys(env: Record<string, string>, prefix: string, issues: string[]): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  const re = new RegExp(`^${prefix}_(\\d{1,3})$`);
  for (const [k, v] of Object.entries(env)) {
    const m = re.exec(k);
    if (!m) continue;
    const n = Number(m[1]);
    const parsed = key32.safeParse(v);
    if (n < 1 || n > 255 || !parsed.success) issues.push(`  - ${k}: precisa ser base64 de 32 bytes (versão 1–255)`);
    else out.set(n, parsed.data);
  }
  return out;
}

/** Lê e valida o ambiente; lança erro com a lista de problemas (sem valores). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // variável vazia (ex.: `PGSSLROOTCERT=` no .env) = ausente
  const present = Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && e[1].trim() !== ''),
  );
  const parsed = EnvSchema.safeParse(present);
  const issues: string[] = parsed.success
    ? []
    : parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  const oldEmailKeys = versionedKeys(present, 'EMAIL_ENC_KEY', issues);
  const oldPeppers = versionedKeys(present, 'PASSWORD_PEPPER', issues);
  if (!parsed.success || issues.length) throw new Error(`Configuração inválida:\n${issues.join('\n')}`);
  const e = parsed.data;
  let trustedProxies: string[];
  try {
    trustedProxies = parseTrustedProxies(e.TRUSTED_PROXIES);
  } catch (err) {
    throw new Error(`Configuração inválida: TRUSTED_PROXIES: ${(err as Error).message}`);
  }
  // confiar em saltos sem dizer em quem = qualquer par forja o IP (X-Forwarded-For)
  if (e.TRUST_PROXY_HOPS > 0 && trustedProxies.length === 0) {
    throw new Error('Configuração inválida: TRUST_PROXY_HOPS > 0 exige TRUSTED_PROXIES (IP/CIDR do proxy)');
  }
  if (e.NODE_ENV === 'production') {
    if (!e.PGSSLROOTCERT) throw new Error('Configuração inválida: PGSSLROOTCERT é obrigatório em produção');
    if (!e.APP_ORIGIN.startsWith('https://')) throw new Error('Configuração inválida: APP_ORIGIN precisa ser https');
    if (!e.PASSWORD_PEPPER) throw new Error('Configuração inválida: PASSWORD_PEPPER é obrigatório em produção');
    // credencial do dono só no one-shot de migração (npm run migrate), nunca na API
    if (e.MIGRATION_DATABASE_URL) {
      throw new Error('Configuração inválida: MIGRATION_DATABASE_URL não pode estar no server em produção (use npm run migrate)');
    }
  }
  const keys = [e.SESSION_KEY, e.CSRF_KEY, e.EMAIL_ENC_KEY, e.EMAIL_HASH_KEY];
  if (new Set(keys.map((k) => k.toString('hex'))).size !== keys.length) {
    throw new Error('Configuração inválida: as chaves SESSION/CSRF/EMAIL_* precisam ser distintas');
  }
  const conflict = (m: Map<number, Buffer>, v: number, cur: Buffer | undefined) => {
    const old = m.get(v);
    return old !== undefined && cur !== undefined && !old.equals(cur);
  };
  if (conflict(oldEmailKeys, e.EMAIL_KEY_VERSION, e.EMAIL_ENC_KEY)) {
    throw new Error('Configuração inválida: EMAIL_ENC_KEY_<versão atual> difere de EMAIL_ENC_KEY');
  }
  if (conflict(oldPeppers, e.PASSWORD_PEPPER_VERSION, e.PASSWORD_PEPPER)) {
    throw new Error('Configuração inválida: PASSWORD_PEPPER_<versão atual> difere de PASSWORD_PEPPER');
  }
  const emailEncKeys = new Map(oldEmailKeys);
  emailEncKeys.set(e.EMAIL_KEY_VERSION, e.EMAIL_ENC_KEY);
  const passwordPeppers = new Map(oldPeppers);
  if (e.PASSWORD_PEPPER) passwordPeppers.set(e.PASSWORD_PEPPER_VERSION, e.PASSWORD_PEPPER);
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    migrationDatabaseUrl: e.MIGRATION_DATABASE_URL ?? null,
    pgCa: e.PGSSLROOTCERT ? readFileSync(e.PGSSLROOTCERT, 'utf8') : null,
    appOrigin: e.APP_ORIGIN,
    sessionKey: e.SESSION_KEY,
    csrfKey: e.CSRF_KEY,
    emailEncKey: e.EMAIL_ENC_KEY,
    emailEncKeys,
    emailHashKey: e.EMAIL_HASH_KEY,
    passwordPepper: e.PASSWORD_PEPPER ?? null,
    passwordPepperVersion: e.PASSWORD_PEPPER_VERSION,
    passwordPeppers,
    emailKeyVersion: e.EMAIL_KEY_VERSION,
    cityDataPath: path.resolve(e.CITY_DATA_PATH),
    trustProxyHops: e.TRUST_PROXY_HOPS,
    trustedProxies,
  };
}
