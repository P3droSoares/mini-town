// Smoke test do stack Docker (rodar no host, com `docker compose up -d`):
//   node docker/smoke.mjs        (ou npm run docker:smoke)
// HTTP pelo Caddy com TLS verificado (CA local do Caddy), fluxo de conta e
// economia (cookie __Host-sid + CSRF + Idempotency-Key), cabeçalhos, nada de
// arquivo sensível servido pelo Vite, e o isolamento no Docker: TLS 1.3 até o
// Postgres, conexão sem TLS e superusuário pela rede recusados, web sem .env
// e sem rota para o banco, server sem credencial do dono, backup funcionando.
// Cria uma conta descartável "smoke…" a cada execução (limite: 5/h por IP).
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const origin = new URL(process.env.APP_ORIGIN ?? 'https://localhost:8443');
const expectedHsts = process.env.CADDY_HSTS || 'max-age=0';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'ok  ' : 'FALHA'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** `docker compose exec -T <svc> sh -c <cmd>` (sem shell no host). */
function dc(service, cmd) {
  const r = spawnSync('docker', ['compose', 'exec', '-T', service, 'sh', '-c', cmd], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

const caRes = dc('caddy', 'cat /data/caddy/pki/authorities/local/root.crt');
if (caRes.code !== 0 || !caRes.out.includes('BEGIN CERTIFICATE')) {
  console.error('não consegui ler a CA do Caddy (o stack está de pé?)', caRes.err);
  process.exit(1);
}
const ca = caRes.out;

let cookie = '';
let csrf = '';

/** Requisição HTTPS ao Caddy, verificando o certificado pela CA local. */
function req(method, path, { body, headers = {}, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const h = { accept: 'application/json', ...headers };
    if (cookie) h.cookie = cookie;
    if (payload !== undefined) {
      h['content-type'] = 'application/json';
      h['content-length'] = Buffer.byteLength(payload);
    }
    if (method !== 'GET') h.origin = origin.origin;
    const r = https.request(
      { host: origin.hostname, port: origin.port || 443, path, method, headers: h, ca, servername: origin.hostname },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const sid = [].concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('__Host-sid='));
          if (sid) cookie = sid.split(';')[0];
          let json = null;
          if (!raw && /json/.test(res.headers['content-type'] ?? '')) {
            try {
              json = JSON.parse(buf.toString('utf8'));
            } catch {
              json = null;
            }
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: raw ? '' : buf.toString('utf8'), json, setCookie: sid ?? '' });
        });
      },
    );
    r.on('error', reject);
    r.setTimeout(30_000, () => r.destroy(new Error('timeout')));
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

const eco = (key = randomUUID()) => ({ 'x-csrf-token': csrf, 'idempotency-key': key });

// ---------- HTTP ----------
const health = await req('GET', '/api/health');
check('GET /api/health = 200 { ok: true }', health.status === 200 && health.json?.ok === true, `status ${health.status}`);
check(`HSTS "${expectedHsts}" (sobrescreve o do server)`, health.headers['strict-transport-security'] === expectedHsts,
  String(health.headers['strict-transport-security']));

const home = await req('GET', '/', { headers: { accept: 'text/html' } });
const csp = String(home.headers['content-security-policy'] ?? '');
check('GET / = 200 com CSP do front', home.status === 200 && csp.includes("frame-ancestors 'none'") && csp.includes("script-src 'self'"));
check('front sem HSTS longo', home.headers['strict-transport-security'] === expectedHsts);

const city = await req('GET', '/data/itabirito.json', { headers: { 'accept-encoding': 'zstd, gzip' }, raw: true });
check('JSON da cidade comprimido pelo Caddy', city.status === 200 && /zstd|gzip/.test(String(city.headers['content-encoding'])),
  `content-encoding ${city.headers['content-encoding']}`);

// nada sensível pode sair pelo Vite (o web nem tem esses arquivos montados)
const sentinels = ['SESSION_KEY', 'MINITOWN_OWNER_PASSWORD', 'POSTGRES_PASSWORD', 'hostssl', 'loadConfig', 'BEGIN '];
for (const path of ['/.env', '/.env.example', '/server/src/config.ts', '/docker-compose.yml', '/docker/db/pg_hba.conf',
  '/@fs/app/.env', '/.env?raw', '/src/../.env', '/server/.env']) {
  const r = await req('GET', path, { headers: { accept: '*/*' } });
  const leaked = sentinels.filter((s) => r.text.includes(s));
  check(`não vaza ${path}`, leaked.length === 0, `status ${r.status}${leaked.length ? `, contém ${leaked.join(',')}` : ''}`);
}

// ---------- conta + economia ----------
const tag = randomBytes(3).toString('hex');
const password = `Smk-${randomBytes(18).toString('base64url')}`;
const reg = await req('POST', '/api/auth/register', {
  body: { displayName: `smoke${tag}`, email: `smoke-${tag}@example.test`, password },
});
csrf = reg.json?.csrfToken ?? '';
check('registro = 201 com csrfToken', reg.status === 201 && csrf.length > 0, `status ${reg.status} ${reg.json?.error?.code ?? ''}`);
check('cookie __Host-sid HttpOnly; Secure; SameSite=Strict; Path=/',
  /HttpOnly/i.test(reg.setCookie) && /Secure/i.test(reg.setCookie) && /SameSite=Strict/i.test(reg.setCookie) && /Path=\//.test(reg.setCookie));

const me = await req('GET', '/api/auth/me');
check('GET /api/auth/me = 200', me.status === 200 && me.json?.user?.displayName === `smoke${tag}`);

const noCsrf = await req('POST', '/api/income/collect', { headers: { 'idempotency-key': randomUUID() } });
check('POST sem X-CSRF-Token = 403', noCsrf.status === 403, `status ${noCsrf.status}`);

const badOrigin = await req('POST', '/api/income/collect', { headers: { ...eco(), origin: 'https://evil.example' } });
check('POST com Origin alheio = 403', badOrigin.status === 403, `status ${badOrigin.status}`);

const starters = await req('GET', '/api/starter-homes');
const lotId = starters.json?.homes?.[0]?.lotId;
check('casas iniciais listadas', starters.status === 200 && typeof lotId === 'string', `status ${starters.status}`);
if (lotId) {
  const key = randomUUID();
  const claim = await req('POST', '/api/starter-homes/claim', { body: { lotId }, headers: eco(key) });
  check('compra da casa inicial = 200', claim.status === 200 && claim.json?.property?.mine === true,
    `status ${claim.status} ${claim.json?.error?.code ?? ''}`);
  const replay = await req('POST', '/api/starter-homes/claim', { body: { lotId }, headers: eco(key) });
  check('replay idempotente (sem cobrança dupla)', replay.status === claim.status && replay.headers['idempotent-replayed'] === 'true');
}

const wallet = await req('GET', '/api/me/wallet');
check('carteira com saldo em centavos (string)', wallet.status === 200 && /^\d+$/.test(String(wallet.json?.balance)));

const collect = await req('POST', '/api/income/collect', { headers: eco() });
check('coletar renda = 200', collect.status === 200, `status ${collect.status} ${collect.json?.error?.code ?? ''}`);

const out = await req('POST', '/api/auth/logout', { headers: { 'x-csrf-token': csrf } });
check('logout = 204', out.status === 204, `status ${out.status}`);
const after = await req('GET', '/api/auth/me');
check('sessão invalidada no servidor (401)', after.status === 401, `status ${after.status}`);

// ---------- isolamento no Docker ----------
const ssl = dc('db', `PGPASSWORD="$POSTGRES_PASSWORD" psql -U postgres -d "$POSTGRES_DB" -Atc "select a.usename, s.ssl, s.version from pg_stat_ssl s join pg_stat_activity a using (pid) where a.usename like 'minitown%'"`);
const conns = ssl.out.split('\n').filter(Boolean);
check('conexões do app ao Postgres com TLSv1.3', ssl.code === 0 && conns.length > 0 && conns.every((l) => l.endsWith('|t|TLSv1.3')),
  conns.join(' ; ') || ssl.err);

const noTls = dc('db', `PGPASSWORD="$MINITOWN_APP_PASSWORD" psql "host=db dbname=$POSTGRES_DB user=minitown_app sslmode=disable connect_timeout=5" -Atc "select 1"`);
check('conexão sem TLS recusada', noTls.code !== 0 && /pg_hba|reject|no encryption/i.test(noTls.err), noTls.err.split('\n')[0]);

const superNet = dc('db', `PGPASSWORD="$POSTGRES_PASSWORD" psql "host=db dbname=$POSTGRES_DB user=postgres sslmode=require connect_timeout=5" -Atc "select 1"`);
check('superusuário pela rede recusado (mesmo com TLS)', superNet.code !== 0 && /pg_hba|reject/i.test(superNet.err), superNet.err.split('\n')[0]);

const roles = dc('db', `PGPASSWORD="$POSTGRES_PASSWORD" psql -U postgres -d "$POSTGRES_DB" -Atc "select string_agg(rolname || ':' || rolsuper, ',' order by rolname) from pg_roles where rolname like 'minitown%'"`);
check('papéis owner/app/backup sem superuser', roles.out === 'minitown_app:false,minitown_backup:false,minitown_owner:false', roles.out || roles.err);

const web = dc('web', 'test ! -e /app/.env && test ! -e /app/server && test ! -e /app/docker && ! getent hosts db >/dev/null && ! getent hosts server >/dev/null && env | grep -c -E "PASSWORD|_KEY=" || true');
check('web sem .env/server/docker montados, sem rota para o db nem para a API, sem segredos no ambiente', web.out === '0', web.out || web.err);

// ambiente do exec E o inicial de cada processo (/proc/*/environ não muda com unsetenv)
const srv = dc('server', 'test -z "${MIGRATION_DATABASE_URL:-}" && test -z "${MINITOWN_OWNER_PASSWORD:-}" && test -z "${POSTGRES_PASSWORD:-}" && ! cat /proc/[0-9]*/environ 2>/dev/null | tr "\\0" "\\n" | grep -q -E "^(MIGRATION_DATABASE_URL|MINITOWN_OWNER_PASSWORD|POSTGRES_PASSWORD)=" && echo limpo');
check('server sem credencial do dono nem do superusuário (nem no environ dos processos)', srv.out === 'limpo', srv.out || 'credencial do dono presente');

// X-Forwarded-For só do Caddy: o server não é alcançável fora da rede proxy
const xff = dc('server', 'getent hosts web >/dev/null && echo web-visivel || echo isolado');
check('server fora da rede do web (só o Caddy fala com a API)', xff.out === 'isolado', xff.out || xff.err);

const bkp = dc('backup', 'pg-backup.sh once');
check('backup sob demanda (pg_dump via TLS, papel só-leitura)', bkp.code === 0, bkp.out.split('\n').at(-1) || bkp.err);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações ok`);
process.exit(failed.length ? 1 : 0);
