/**
 * Pools de conexão. O server usa o papel `minitown_app` (DML mínimo); só o
 * migrador usa o papel dono. TLS verify-full quando há CA configurada.
 */
import pg from 'pg';
import type { AppConfig } from '../config.js';

// BIGINT (int8) chega como string: convertemos para bigint nativo, nunca Number
pg.types.setTypeParser(20, (v) => BigInt(v));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface PoolOptions {
  max?: number;
  /** timeout de comando (ms); 0 = sem limite (migrador) */
  statementTimeoutMs?: number;
  /** onde registrar erros de conexão ociosa */
  onError?: (err: Error) => void;
}

export function createPool(url: string, cfg: Pick<AppConfig, 'pgCa'>, opts: PoolOptions | number = {}): pg.Pool {
  const o: PoolOptions = typeof opts === 'number' ? { max: opts } : opts;
  const pool = new pg.Pool({
    connectionString: url,
    max: o.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // checkServerIdentity padrão do Node = verificação de hostname (verify-full)
    ssl: cfg.pgCa ? { ca: cfg.pgCa, rejectUnauthorized: true } : undefined,
    application_name: 'minitown-server',
    // trava consultas presas (defesa contra locks esquecidos)
    statement_timeout: o.statementTimeoutMs ?? 15_000,
    idle_in_transaction_session_timeout: 30_000,
  });
  // erro em conexão ociosa não pode derrubar o processo, mas precisa aparecer no log
  pool.on('error', (err) => (o.onError ?? ((e: Error) => console.error('erro no pool do Postgres:', e.message)))(err));
  return pool;
}

/** Erros do Postgres que justificam repetir a transação inteira. */
function isRetryable(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === '40001' /* serialization_failure */ || code === '40P01' /* deadlock_detected */;
}

/**
 * Executa `fn` numa transação READ COMMITTED; COMMIT no sucesso, ROLLBACK no
 * erro. Repete em deadlock/serialização (raros, pois os locks são ordenados).
 * Conexão que não consegue nem fazer ROLLBACK é descartada (não volta ao pool).
 */
export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch((e: unknown) => {
        broken = e instanceof Error ? e : new Error(String(e));
      });
      if (!broken && attempt < 3 && isRetryable(err)) continue;
      throw err;
    } finally {
      client.release(broken);
    }
  }
}
