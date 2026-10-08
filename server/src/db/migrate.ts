/**
 * Migrador SQL próprio: aplica `migrations/NNN_nome.sql` em ordem, cada uma
 * numa transação, registrando versão + checksum em `schema_migrations`.
 * Migração já aplicada com conteúdo alterado = erro (nunca reescrever história).
 *
 * - Sem timeout de comando (índices/reescritas longas), `lock_timeout` de 5 s
 *   (não fica preso atrás do app).
 * - Arquivo com a linha `-- no-transaction` roda fora de transação (ex.:
 *   `CREATE INDEX CONCURRENTLY`); precisa ser idempotente.
 * - Banco com versão mais nova que o código (rollback de deploy) = erro.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
  transactional: boolean;
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const seen = new Set<number>();
  return files.map((file) => {
    const version = Number(file.slice(0, 3));
    if (seen.has(version)) throw new Error(`Migração duplicada: ${version}`);
    seen.add(version);
    const sql = readFileSync(`${dir}/${file}`, 'utf8');
    const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
    const transactional = !/^--\s*no-transaction\s*$/m.test(sql);
    return { version, name: file.replace(/\.sql$/, ''), sql, checksum, transactional };
  });
}

/** Última versão disponível no disco. */
export const latestMigrationVersion = (dir = MIGRATIONS_DIR): number =>
  loadMigrations(dir).reduce((m, x) => Math.max(m, x.version), 0);

// chave arbitrária fixa para o advisory lock do migrador
const LOCK_KEY = 7_420_311;

/** Aplica as migrações pendentes. Retorna os nomes aplicados nesta execução. */
export async function migrate(pool: pg.Pool, log: (msg: string) => void = () => {}, dir = MIGRATIONS_DIR): Promise<string[]> {
  const migrations = loadMigrations(dir);
  const client = await pool.connect();
  const applied: string[] = [];
  let broken = false;
  try {
    await client.query(`SET statement_timeout = 0`);
    await client.query(`SET lock_timeout = '5s'`);
    await client.query(`SET idle_in_transaction_session_timeout = 0`);
    // um migrador por vez (vários servers subindo juntos)
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: number; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    const latest = migrations.reduce((m, x) => Math.max(m, x.version), 0);
    const ahead = rows.filter((r) => r.version > latest || !migrations.some((m) => m.version === r.version));
    if (ahead.length) {
      throw new Error(
        `Banco tem migrações que não existem no código (${ahead.map((r) => r.version).join(', ')}): código antigo?`,
      );
    }
    for (const m of migrations) {
      const prev = done.get(m.version);
      if (prev !== undefined) {
        if (prev !== m.checksum) throw new Error(`Checksum divergente na migração ${m.name}`);
        continue;
      }
      try {
        if (m.transactional) await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          m.version,
          m.name,
          m.checksum,
        ]);
        if (m.transactional) await client.query('COMMIT');
      } catch (err) {
        if (m.transactional) {
          await client.query('ROLLBACK').catch(() => {
            broken = true;
          });
        }
        throw new Error(`Falha na migração ${m.name}: ${(err as Error).message}`);
      }
      applied.push(m.name);
      log(`migração aplicada: ${m.name}`);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {
      broken = true;
    });
    client.release(broken);
  }
}
