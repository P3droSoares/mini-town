/**
 * Proteção contra força bruta no login: contadores por IP e por conta (chave
 * = HMAC do e-mail, exista a conta ou não — não revela cadastro), com
 * backoff exponencial e bloqueio temporário.
 *
 * A tentativa é contada ANTES da verificação da senha, numa transação com
 * trava de linha: rajadas paralelas não passam do limite. No sucesso o
 * contador da conta zera e o do IP devolve a tentativa.
 *
 * Origem conhecida (cookie de dispositivo ou IP de login anterior da conta)
 * usa o escopo `device`, separado do contador da conta: quem só sabe o
 * e-mail da vítima não consegue bloquear o login dela.
 */
import type pg from 'pg';
import { withTx } from '../db/pool.js';
import { BRUTE_FORCE, lockSeconds, type LockoutRule } from '../security/policy.js';

export interface AttemptKey {
  scope: 'ip' | 'account' | 'device';
  key: Buffer;
}

const order = (a: AttemptKey, b: AttemptKey) =>
  a.scope === b.scope ? Buffer.compare(a.key, b.key) : a.scope < b.scope ? -1 : 1;

/**
 * Reserva uma tentativa. Retorna os segundos de bloqueio restantes (0 =
 * pode verificar a senha; a tentativa já foi contada como falha).
 */
export async function beginAttempt(db: pg.Pool, keys: AttemptKey[]): Promise<number> {
  const sorted = [...keys].sort(order);
  return withTx(db, async (c) => {
    const rows: { k: AttemptKey; failures: number; last: Date; lockedUntil: Date | null; now: Date }[] = [];
    // ordem fixa das chaves: tentativas paralelas não entram em deadlock
    for (const k of sorted) {
      await c.query(
        `INSERT INTO login_attempts (scope, key_hash, failures, last_failure_at) VALUES ($1, $2, 0, now())
         ON CONFLICT (scope, key_hash) DO NOTHING`,
        [k.scope, k.key],
      );
      const { rows: r } = await c.query<{ failures: number; last_failure_at: Date; locked_until: Date | null; now: Date }>(
        `SELECT failures, last_failure_at, locked_until, now() AS now FROM login_attempts
          WHERE scope = $1 AND key_hash = $2 FOR UPDATE`,
        [k.scope, k.key],
      );
      const x = r[0]!;
      rows.push({ k, failures: x.failures, last: x.last_failure_at, lockedUntil: x.locked_until, now: x.now });
    }
    // bloqueado em qualquer escopo: recusa sem contar
    let remaining = 0;
    for (const r of rows) {
      if (r.lockedUntil && r.lockedUntil > r.now) {
        remaining = Math.max(remaining, (r.lockedUntil.getTime() - r.now.getTime()) / 1000);
      }
    }
    if (remaining > 0) return remaining;
    for (const r of rows) {
      const rule: LockoutRule = BRUTE_FORCE[r.k.scope];
      const expired = r.now.getTime() - r.last.getTime() > BRUTE_FORCE.windowSec * 1000;
      const failures = expired ? 1 : r.failures + 1;
      const lock = lockSeconds(rule, failures);
      await c.query(
        `UPDATE login_attempts SET failures = $3, last_failure_at = now(),
                locked_until = CASE WHEN $4::float8 > 0 THEN now() + make_interval(secs => $4::float8) ELSE locked_until END
          WHERE scope = $1 AND key_hash = $2`,
        [r.k.scope, r.k.key, failures, lock],
      );
    }
    return 0;
  });
}

/** Sucesso: zera conta/dispositivo; o IP devolve a tentativa reservada. */
export async function attemptSucceeded(db: pg.Pool, keys: AttemptKey[]): Promise<void> {
  for (const k of keys) {
    if (k.scope === 'ip') {
      await db.query(
        `UPDATE login_attempts SET failures = greatest(failures - 1, 0),
                locked_until = CASE WHEN failures - 1 <= $2 THEN NULL ELSE locked_until END
          WHERE scope = 'ip' AND key_hash = $1`,
        [k.key, BRUTE_FORCE.ip.freeFailures],
      );
    } else {
      await db.query(`DELETE FROM login_attempts WHERE scope = $1 AND key_hash = $2`, [k.scope, k.key]);
    }
  }
}
