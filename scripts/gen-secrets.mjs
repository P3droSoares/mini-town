// Gera o .env de desenvolvimento com segredos aleatórios (senhas do Postgres
// e chaves de 32 bytes em base64). Com um .env existente, só acrescenta as
// variáveis que faltam (ex.: MINITOWN_BACKUP_PASSWORD de versões novas) e não
// toca nas demais; --force recria tudo (atenção: o volume do banco guarda as
// senhas antigas — recriar exige `docker compose down -v`).
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, '.env');
const force = process.argv.includes('--force');

// senha: hex (seguro dentro de URL postgres:// sem escape)
const password = () => randomBytes(32).toString('hex');
const key32 = () => randomBytes(32).toString('base64');

/** Seções do .env: [comentário, [[variável, gerador]]]. */
const sections = [
  [null, [['APP_ORIGIN', () => 'https://localhost:8443'], ['LOG_LEVEL', () => 'info']]],
  [
    '# Postgres: superusuário (só init/admin pelo socket local), dono das migrações,\n# app (API) e backup (só leitura)',
    [
      ['POSTGRES_DB', () => 'minitown'],
      ['POSTGRES_PASSWORD', password],
      ['MINITOWN_OWNER_PASSWORD', password],
      ['MINITOWN_APP_PASSWORD', password],
      ['MINITOWN_BACKUP_PASSWORD', password],
    ],
  ],
  [
    '# chaves simétricas (base64 de 32 bytes, todas distintas)',
    [
      ['SESSION_KEY', key32],
      ['CSRF_KEY', key32],
      ['EMAIL_ENC_KEY', key32],
      ['EMAIL_HASH_KEY', key32],
      ['PASSWORD_PEPPER', key32],
      ['EMAIL_KEY_VERSION', () => '1'],
    ],
  ],
];

if (existsSync(target) && !force) {
  const current = readFileSync(target, 'utf8');
  // variável presente (mesmo vazia, ex.: PASSWORD_PEPPER opcional) = mantida:
  // trocar pepper/chaves de um banco existente invalidaria senhas e e-mails
  const have = new Set(
    current
      .split(/\r?\n/)
      .map((l) => /^\s*([A-Z0-9_]+)\s*=/.exec(l)?.[1])
      .filter(Boolean),
  );
  const missing = sections.flatMap(([, vars]) => vars).filter(([name]) => !have.has(name));
  if (missing.length === 0) {
    console.log('.env completo — nada a fazer (use --force para recriar).');
    process.exit(0);
  }
  const block = [
    '',
    `# acrescentado por scripts/gen-secrets.mjs em ${new Date().toISOString()}`,
    ...missing.map(([name, gen]) => `${name}=${gen()}`),
    '',
  ].join('\n');
  writeFileSync(target, current.replace(/\s*$/, '\n') + block, { encoding: 'utf8', mode: 0o600 });
  console.log(`.env completado: ${missing.map(([n]) => n).join(', ')}`);
  console.log('Volume do banco já existente? Crie o papel de backup:');
  console.log('  docker compose up -d db && docker compose exec db bash /docker-entrypoint-initdb.d/20-backup-role.sh');
  process.exit(0);
}

const lines = ['# Gerado por scripts/gen-secrets.mjs — NUNCA versione este arquivo.', `# ${new Date().toISOString()}`];
for (const [comment, vars] of sections) {
  if (comment) lines.push('', comment);
  for (const [name, gen] of vars) lines.push(`${name}=${gen()}`);
}
lines.push('');

writeFileSync(target, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
console.log(`.env criado em ${target}`);
