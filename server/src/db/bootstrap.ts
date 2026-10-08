/**
 * Preparação do banco com o papel dono: migrações + sincronização do
 * catálogo. Usada pelo `npm run migrate` (serviço one-shot) e, se o server
 * receber MIGRATION_DATABASE_URL, no próprio boot.
 */
import type pg from 'pg';
import type { AppConfig } from '../config.js';
import { buildCatalog, syncCatalog } from '../economy/catalog.js';
import { latestMigrationVersion, migrate } from './migrate.js';
import { createPool } from './pool.js';

/** Espera o Postgres aceitar conexões (compose: ele pode ainda estar subindo). */
export async function waitForDb(pool: pg.Pool, log: (m: string) => void, attempts = 30): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      log(`aguardando o banco (${attempt}/${attempts}): ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export async function prepareDatabase(
  ownerUrl: string,
  cfg: Pick<AppConfig, 'pgCa' | 'cityDataPath'>,
  log: (m: string) => void,
): Promise<void> {
  // sem timeout de comando: migração/sincronização longas não podem ser canceladas no meio
  const owner = createPool(ownerUrl, cfg, { max: 2, statementTimeoutMs: 0 });
  try {
    await waitForDb(owner, log);
    await migrate(owner, log);
    const { rows, center } = await buildCatalog(cfg.cityDataPath);
    const r = await syncCatalog(owner, rows);
    log(
      r.skipped
        ? `catálogo: ${rows.length} imóveis, versão ${r.checksum.slice(0, 12)} já aplicada`
        : `catálogo: ${rows.length} imóveis (${r.changed} atualizados, ${r.frozen} com dono congelados, ` +
            `${r.retired} aposentados), centro em [${center.map((v) => v.toFixed(0)).join(', ')}]`,
    );
  } finally {
    await owner.end();
  }
}

/** Confere (com o papel app) se o esquema está na versão do código. */
export async function assertSchemaCurrent(pool: pg.Pool): Promise<void> {
  const want = latestMigrationVersion();
  let have = 0;
  try {
    have = (await pool.query<{ v: number }>('SELECT schema_version() AS v')).rows[0]?.v ?? 0;
  } catch (err) {
    // função ausente = esquema anterior à 002
    if ((err as { code?: string }).code !== '42883') throw err;
  }
  if (have < want) {
    throw new Error(`Esquema do banco na versão ${have}, o código espera ${want}: rode \`npm run migrate\` (papel dono).`);
  }
}

/** Recusa subir se houver senhas com pepper de versão desconhecida (todas falhariam em silêncio). */
export async function assertPeppersAvailable(pool: pg.Pool, cfg: Pick<AppConfig, 'passwordPeppers'>): Promise<void> {
  const { rows } = await pool.query<{ v: string | null }>(
    `SELECT DISTINCT substring(password_hash from '^p([0-9]{1,3})[$]') AS v FROM users`,
  );
  const missing = rows
    .map((r) => r.v)
    .filter((v): v is string => v !== null && v !== '0' && !cfg.passwordPeppers.has(Number(v)));
  if (missing.length) {
    throw new Error(`Há senhas com pepper versão ${missing.join(', ')} sem PASSWORD_PEPPER(_<n>) configurado.`);
  }
}
