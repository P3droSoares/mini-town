/**
 * Tarefas periódicas: invariantes contábeis, reversão dos índices de
 * mercado, expiração de anúncios, partições da auditoria, recifragem de
 * e-mails e limpeza de sessões/chaves/contadores vencidos.
 */
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { AppConfig } from './config.js';
import { withTx } from './db/pool.js';
import { CATEGORIES, ECONOMY } from './economy/config.js';
import { bumpIndex } from './economy/indices.js';
import { runInvariantJob, setEconomyLock } from './economy/invariants.js';
import { decryptEmail, encryptEmail } from './security/crypto.js';
import { SESSION } from './security/policy.js';

/** Falhas seguidas da verificação de invariantes antes de travar a economia (fail-closed). */
export const MAX_INVARIANT_FAILURES = 3;

export async function housekeeping(pool: pg.Pool, now: Date): Promise<void> {
  // sessão morta por inatividade some 1 dia depois; revogada/expirada também
  await pool.query(
    `DELETE FROM sessions
      WHERE expires_at < now() - interval '1 day'
         OR revoked_at < now() - interval '1 day'
         OR last_seen_at < now() - make_interval(secs => $1)`,
    [SESSION.idleMs / 1000 + 86_400],
  );
  await pool.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`);
  await pool.query(
    `DELETE FROM login_attempts WHERE last_failure_at < now() - interval '1 day' AND (locked_until IS NULL OR locked_until < now())`,
  );
  // redes de acesso guardadas por 90 dias (contas ligadas, origem conhecida)
  await pool.query(`DELETE FROM user_ips WHERE last_seen_at < now() - interval '90 days'`);
  await pool.query(
    `UPDATE listings SET status = 'expired', closed_at = $1
      WHERE status = 'active' AND created_at < $1::timestamptz - make_interval(days => $2)`,
    [now, ECONOMY.market.listingTtlDays],
  );
  await pool.query('SELECT audit_log_ensure_partitions()');
  // reversão à média aplicada mesmo sem negociações
  for (const cat of CATEGORIES) await withTx(pool, (c) => bumpIndex(c, cat, 0, now));
}

/** Recifra e-mails de versões antigas de chave com a chave atual (em lotes). */
export async function reencryptEmails(pool: pg.Pool, cfg: Pick<AppConfig, 'emailEncKeys' | 'emailKeyVersion'>, batch = 500): Promise<number> {
  const key = cfg.emailEncKeys.get(cfg.emailKeyVersion);
  if (!key) return 0;
  const { rows } = await pool.query<{ id: string; email_enc: Buffer }>(
    `SELECT id, email_enc FROM users WHERE email_key_version <> $1 LIMIT $2`,
    [cfg.emailKeyVersion, batch],
  );
  let n = 0;
  for (const r of rows) {
    let email: string;
    try {
      email = decryptEmail(cfg.emailEncKeys, r.email_enc);
    } catch {
      continue; // chave antiga indisponível: fica para quando ela for configurada
    }
    await pool.query('UPDATE users SET email_enc = $2, email_key_version = $3 WHERE id = $1 AND email_key_version <> $3', [
      r.id,
      encryptEmail(key, cfg.emailKeyVersion, email),
      cfg.emailKeyVersion,
    ]);
    n++;
  }
  return n;
}

export interface Jobs {
  /** para o agendamento e espera a execução em andamento */
  stop: () => Promise<void>;
}

export function startJobs(
  pool: pg.Pool,
  log: FastifyBaseLogger,
  clock: () => Date,
  cfg: Pick<AppConfig, 'emailEncKeys' | 'emailKeyVersion'>,
  everyMs = 5 * 60_000,
): Jobs {
  let current: Promise<void> | null = null;
  let stopped = false;
  let failures = 0;
  const tick = async () => {
    // invariantes: falhas seguidas (timeout, banco fora) travam a economia
    try {
      const r = await runInvariantJob(pool, log);
      failures = 0;
      if (r.ok) log.debug({ mode: r.mode, supply: r.moneySupply }, 'invariantes ok');
    } catch (err) {
      failures++;
      log.error({ err, failures }, 'falha na verificação de invariantes');
      if (failures >= MAX_INVARIANT_FAILURES) {
        await setEconomyLock(pool, true, `verificação de invariantes falhou ${failures}x seguidas`).catch((e: unknown) =>
          log.error({ err: e }, 'não foi possível travar a economia'),
        );
      }
    }
    // limpeza independe do resultado acima
    try {
      await housekeeping(pool, clock());
    } catch (err) {
      log.error({ err }, 'falha na limpeza periódica');
    }
    try {
      const n = await reencryptEmails(pool, cfg);
      if (n) log.info({ n }, 'e-mails recifrados com a chave atual');
    } catch (err) {
      log.error({ err }, 'falha ao recifrar e-mails');
    }
  };
  const run = () => {
    if (stopped || current) return;
    current = tick().finally(() => {
      current = null;
    });
  };
  run();
  const t = setInterval(run, everyMs);
  t.unref();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(t);
      if (current) await current;
    },
  };
}
