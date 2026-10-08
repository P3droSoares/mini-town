/**
 * Executor de operações econômicas: transação única com idempotência
 * (`Idempotency-Key`), trava de manutenção e travas de linha ordenadas.
 *
 * Ordem global de travas (evita deadlock):
 *   advisory(usuário+chave) → advisory(usuário) → imóveis (lot_id ↑) → anúncio
 *   → contas de jogador (id ↑) → usuários → índice de mercado.
 */
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withTx } from '../db/pool.js';
import { AppError } from '../http/errors.js';
import { sha256 } from '../security/crypto.js';

export interface EconResult {
  status: number;
  body: unknown;
}

const keySchema = z.uuidv4();

/** Espera máxima por travas de linha depois das travas do usuário (ms). */
export const LOCK_TIMEOUT_MS = 5_000;

/** Lê e valida o header Idempotency-Key (UUID v4). */
export function idempotencyKey(req: FastifyRequest): string {
  const raw = req.headers['idempotency-key'];
  const parsed = keySchema.safeParse(Array.isArray(raw) ? undefined : raw?.toLowerCase());
  if (!parsed.success) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Envie o header Idempotency-Key (UUID v4).');
  }
  return parsed.data;
}

function requestHash(req: FastifyRequest): Buffer {
  const route = req.routeOptions.url ?? req.url;
  return sha256(`${req.method} ${route} ${JSON.stringify(req.params ?? {})} ${JSON.stringify(req.body ?? null)}`);
}

// erros de unicidade que significam regra de negócio (corrida perdida)
const UNIQUE_TO_ERROR: Record<string, [number, string, string]> = {
  starter_claims_pkey: [409, 'STARTER_ALREADY_CLAIMED', 'Você já recebeu sua casa inicial.'],
  starter_claims_active_lot: [409, 'NOT_AVAILABLE', 'Este imóvel não está mais disponível.'],
  listings_one_active: [409, 'ALREADY_LISTED', 'Este imóvel já está anunciado.'],
};

const BUSY = () =>
  new AppError(503, 'BUSY', 'Servidor ocupado. Tente novamente em instantes.', { 'retry-after': '2' });

export async function runEconomic(
  pool: pg.Pool,
  req: FastifyRequest,
  userId: string,
  clock: () => Date,
  fn: (c: pg.PoolClient, now: Date) => Promise<EconResult>,
): Promise<EconResult & { replayed: boolean }> {
  const key = idempotencyKey(req);
  const hash = requestHash(req);
  try {
    return await withTx(pool, async (c) => {
      // pedidos com a mesma chave são serializados; o segundo vê o resultado do primeiro
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7))', [`${userId}:${key}`]);
      const prev = await c.query<{ request_hash: Buffer; status_code: number; response: unknown }>(
        'SELECT request_hash, status_code, response FROM idempotency_keys WHERE user_id = $1 AND key = $2',
        [userId, key],
      );
      const p = prev.rows[0];
      if (p) {
        if (!p.request_hash.equals(hash)) {
          throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Esta chave de idempotência já foi usada em outro pedido.');
        }
        return { status: p.status_code, body: p.response, replayed: true };
      }
      // todas as operações do mesmo usuário em fila: leituras do próprio estado são estáveis
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 11))', [`user:${userId}`]);
      // espera por travas de outros jogadores é limitada (vira 503, não 500)
      await c.query(`SELECT set_config('lock_timeout', $1, true)`, [`${LOCK_TIMEOUT_MS}ms`]);
      const flag = await c.query<{ locked: boolean }>(
        `SELECT coalesce((value->>'locked')::boolean, false) AS locked FROM system_flags WHERE key = 'economy_lock'`,
      );
      if (flag.rows[0]?.locked) {
        throw new AppError(503, 'MAINTENANCE', 'Economia em manutenção. Tente novamente mais tarde.');
      }
      // relógio lido só depois das travas: nunca anterior ao da operação anterior do usuário
      const out = await fn(c, clock());
      await c.query(
        `INSERT INTO idempotency_keys (user_id, key, request_hash, status_code, response) VALUES ($1, $2, $3, $4, $5)`,
        [userId, key, hash, out.status, JSON.stringify(out.body ?? null)],
      );
      return { ...out, replayed: false };
    });
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505' && pgErr.constraint && UNIQUE_TO_ERROR[pgErr.constraint]) {
      const [status, code, message] = UNIQUE_TO_ERROR[pgErr.constraint]!;
      throw new AppError(status, code, message);
    }
    // lock_timeout / statement_timeout: sobrecarga momentânea, não erro interno
    if (pgErr.code === '55P03' || pgErr.code === '57014') throw BUSY();
    throw err;
  }
}
