/**
 * Banco descartável dos testes. Por padrão usa o container
 *   docker run -d --name minitown-test-db -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17
 * (sobrescreva com TEST_ADMIN_URL). Cria um banco `minitown_test` do zero,
 * com os mesmos papéis/privilégios de produção (db-init/roles.psql).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:test@127.0.0.1:55432/postgres';
export const TEST_DB = 'minitown_test';
export const OWNER_PW = 'owner-test-pw';
export const APP_PW = 'app-test-pw';

function urlFor(user: string, password: string, db: string): string {
  const u = new URL(ADMIN_URL);
  u.username = user;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

export const OWNER_URL = urlFor('minitown_owner', OWNER_PW, TEST_DB);
export const APP_URL = urlFor('minitown_app', APP_PW, TEST_DB);
export const SUPER_TEST_URL = (() => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
})();

const ROLES_FILE = fileURLToPath(new URL('../db-init/roles.psql', import.meta.url));

/** Substitui variáveis psql (:'x' literal, :"x" identificador) e separa no \connect. */
function renderRoles(vars: Record<string, string>): { cluster: string; database: string } {
  const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const ident = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const text = readFileSync(ROLES_FILE, 'utf8')
    .replace(/:'(\w+)'/g, (_m, k: string) => lit(vars[k]!))
    .replace(/:"(\w+)"/g, (_m, k: string) => ident(vars[k]!));
  const [cluster, database] = text.split(/^\\connect .*$/m);
  return { cluster: cluster!, database: database ?? '' };
}

/** Recria banco e papéis do zero. */
export async function resetDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query('DROP ROLE IF EXISTS minitown_app');
    await admin.query('DROP ROLE IF EXISTS minitown_owner');
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    const sql = renderRoles({ owner_pw: OWNER_PW, app_pw: APP_PW, db: TEST_DB });
    await admin.query(sql.cluster);
    const db = new pg.Client({ connectionString: SUPER_TEST_URL });
    await db.connect();
    try {
      await db.query(sql.database);
    } finally {
      await db.end();
    }
  } finally {
    await admin.end();
  }
}
