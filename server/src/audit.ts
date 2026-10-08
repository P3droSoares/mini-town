/**
 * Auditoria append-only (login, falhas, compras, vendas, troca de senha...).
 * Nunca recebe e-mail, senha ou IP em claro.
 */
import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export type AuditAction =
  | 'register'
  | 'login'
  | 'login_failed'
  | 'login_locked'
  | 'logout'
  | 'logout_all'
  | 'password_changed'
  | 'password_change_failed'
  | 'starter_claimed'
  | 'city_purchase'
  | 'city_sale'
  | 'listing_created'
  | 'listing_cancelled'
  | 'market_sale'
  | 'residence_set'
  | 'business_opened'
  | 'business_upgraded'
  | 'business_closed'
  | 'income_collected'
  | 'invariant_violation'
  | 'economy_alert';

export async function audit(
  db: Queryable,
  action: AuditAction,
  userId: string | null,
  ipHmac: Buffer | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db.query('INSERT INTO audit_log (user_id, action, ip_hmac, detail) VALUES ($1, $2, $3, $4)', [
    userId,
    action,
    ipHmac,
    JSON.stringify(detail, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  ]);
}
