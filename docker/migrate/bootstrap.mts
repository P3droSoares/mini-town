/**
 * Serviço one-shot `migrate` do compose: aplica as migrações e sincroniza o
 * catálogo de imóveis com o papel dono (minitown_owner) e termina. Só este
 * container recebe MIGRATION_DATABASE_URL; a API sobe depois, só com o papel
 * app. Reaproveita o código do server (montado em /app/server).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createPool } from '../server/src/db/pool.js';
import { migrate } from '../server/src/db/migrate.js';
import { buildCatalog, syncCatalog } from '../server/src/economy/catalog.js';

const url = process.env.MIGRATION_DATABASE_URL?.trim();
if (!url || !/^postgres(ql)?:\/\//.test(url)) {
  console.error('[migrate] defina MIGRATION_DATABASE_URL (postgres://)');
  process.exit(1);
}
const caPath = process.env.PGSSLROOTCERT?.trim();
const pgCa = caPath ? readFileSync(caPath, 'utf8') : null;
const cityPath = path.resolve(process.env.CITY_DATA_PATH?.trim() || '../public/data/itabirito.json');

const pool = createPool(url, { pgCa }, 2);
try {
  // o db pode estar terminando o init: tenta por ~1 min
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(`[migrate] aguardando o banco (${attempt}/30): ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const applied = await migrate(pool, (m) => console.log(`[migrate] ${m}`));
  console.log(`[migrate] ${applied.length ? `${applied.length} migração(ões) aplicada(s)` : 'nada a aplicar'}`);
  const { rows } = await buildCatalog(cityPath);
  const changed = await syncCatalog(pool, rows);
  console.log(`[migrate] catálogo: ${rows.length} imóveis (${changed} atualizados)`);
} catch (err) {
  // só a mensagem: a URL (com senha) nunca vai para o log
  console.error(`[migrate] falhou: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
