/**
 * Parâmetros de segurança de sessão, de proteção contra força bruta e de
 * criação de contas.
 */

export const SESSION_COOKIE = '__Host-sid';
/** cookie de "dispositivo conhecido" (ver bruteForce.ts) */
export const DEVICE_COOKIE = '__Host-dev';
export const DEVICE_MAX_AGE_SEC = 180 * 86_400;

export const SESSION = {
  /** expiração por inatividade */
  idleMs: 30 * 60_000,
  /** expiração absoluta */
  absoluteMs: 7 * 24 * 3_600_000,
  /** só regrava last_seen_at se mais velho que isso (menos escrita) */
  touchEveryMs: 60_000,
} as const;

export interface LockoutRule {
  /** falhas toleradas antes do bloqueio */
  freeFailures: number;
  /** bloqueio = base · 2^(falhas - livres), limitado a max */
  baseLockSec: number;
  maxLockSec: number;
}

const accountRule: LockoutRule = { freeFailures: 5, baseLockSec: 15, maxLockSec: 15 * 60 };

export const BRUTE_FORCE = {
  /** origem desconhecida (contador único da conta) */
  account: accountRule,
  /** origem conhecida da conta (dispositivo ou IP de login anterior): contador próprio */
  device: accountRule,
  ip: { freeFailures: 20, baseLockSec: 15, maxLockSec: 60 * 60 } satisfies LockoutRule,
  /** contadores zeram após esse tempo sem falhas */
  windowSec: 60 * 60,
  /** IP de login com sucesso nesta janela conta como origem conhecida (dias) */
  knownIpDays: 30,
} as const;

/** Duração mínima de login/registro (mascara diferença entre caminhos). */
export const AUTH_MIN_RESPONSE_MS = 350;

export function lockSeconds(rule: LockoutRule, failures: number): number {
  if (failures <= rule.freeFailures) return 0;
  return Math.min(rule.maxLockSec, rule.baseLockSec * 2 ** Math.min(20, failures - rule.freeFailures - 1));
}

/** Políticas ajustáveis por instância (testes usam valores folgados). */
export interface ServerPolicy {
  /** contas por rede (IPv4 exato / IPv6 /64) em 24 h, persistido no Postgres */
  signupPerNetPerDay: number;
  /** contas novas por hora no servidor inteiro */
  signupGlobalPerHour: number;
  /** cache das rotas públicas pesadas (ranking, panorama) */
  publicCacheMs: number;
  /** vendas recentes só aparecem no panorama público depois deste atraso */
  recentSalesDelayMs: number;
}

export const DEFAULT_POLICY: ServerPolicy = {
  signupPerNetPerDay: 5,
  signupGlobalPerHour: 300,
  publicCacheMs: 30_000,
  recentSalesDelayMs: 15 * 60_000,
};
