/**
 * Prepara o banco de testes uma vez: papéis, migrações (papel dono) e
 * catálogo real de Itabirito.
 */
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildCatalog, syncCatalog } from '../src/economy/catalog.js';
import { OWNER_URL, resetDatabase } from './db.js';

export const CITY_JSON = fileURLToPath(new URL('../../public/data/itabirito.json', import.meta.url));

export default async function setup(): Promise<void> {
  await resetDatabase();
  const owner = createPool(OWNER_URL, { pgCa: null }, 2);
  try {
    await migrate(owner);
    // segunda execução não pode aplicar nada (idempotente)
    const again = await migrate(owner);
    if (again.length) throw new Error('migrador não é idempotente');
    const { rows } = await buildCatalog(CITY_JSON);
    await syncCatalog(owner, rows);
    await syncCatalog(owner, rows);
  } finally {
    await owner.end();
  }
}
