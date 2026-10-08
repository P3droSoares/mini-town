/**
 * Dependências compartilhadas pelas rotas + tipagem das extensões do Fastify.
 */
import type pg from 'pg';
import type { AuthInfo } from './auth/session.js';
import type { AppConfig } from './config.js';
import type { SystemAccounts } from './economy/ledger.js';
import type { ServerPolicy } from './security/policy.js';
import type { RateLimiter, RateLimits } from './security/rateLimit.js';

export interface AppContext {
  cfg: AppConfig;
  /** pool do papel app (DML mínimo) */
  pool: pg.Pool;
  sys: SystemAccounts;
  limiter: RateLimiter;
  limits: RateLimits;
  /** limites persistentes de cadastro e cache das rotas públicas */
  policy: ServerPolicy;
  /** duração mínima de login/registro */
  authMinResponseMs: number;
  /** relógio do servidor (injetável em testes) */
  clock: () => Date;
}

/** Política de acesso da rota (obrigatória em toda rota de /api; ver app.ts). */
export type AuthMode = 'none' | 'required';
/** Limite extra da rota. */
export type LimitKind = 'auth' | 'register' | 'economy' | 'public';

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: AuthMode;
    limit?: LimitKind;
    /** false só em login/registro (ainda sem sessão; protegidos por Origin) */
    csrf?: boolean;
  }
  interface FastifyRequest {
    auth: AuthInfo | null;
    ipHmac: Buffer;
    /** HMAC da rede de origem (IPv4 exato / IPv6 /64) */
    netHmac: Buffer;
  }
}
