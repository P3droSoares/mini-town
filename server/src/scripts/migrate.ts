/**
 * `npm run migrate`: aplica as migrações pendentes e sincroniza o catálogo
 * com o papel dono (serviço one-shot; o server da API não precisa da
 * credencial do dono). Usa MIGRATION_DATABASE_URL, PGSSLROOTCERT (se houver
 * TLS) e CITY_DATA_PATH (padrão ../public/data/itabirito.json).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { prepareDatabase } from '../db/bootstrap.js';

const url = process.env.MIGRATION_DATABASE_URL?.trim();
if (!url) {
  console.error('defina MIGRATION_DATABASE_URL');
  process.exit(1);
}
const ca = process.env.PGSSLROOTCERT?.trim() ? readFileSync(process.env.PGSSLROOTCERT.trim(), 'utf8') : null;
const cityDataPath = path.resolve(process.env.CITY_DATA_PATH?.trim() || '../public/data/itabirito.json');
try {
  await prepareDatabase(url, { pgCa: ca, cityDataPath }, (m) => console.log(m));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
