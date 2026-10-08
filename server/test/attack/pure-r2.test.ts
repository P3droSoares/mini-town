/**
 * RED TEAM, 2ª rodada — regressões PURAS (sem banco): IPTU sem evasão por
 * arredondamento, confiança em proxy só no Caddy e a infraestrutura do
 * compose (credencial do dono fora da API, install sem segredos).
 *
 * Roda offline (UNIT_ONLY=1). Cada bloco afirma o EFEITO; reverter a
 * correção deixa o teste vermelho.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ECONOMY } from '../../src/economy/config.js';
import { accrual, type IncomeInput } from '../../src/economy/pricing.js';
import { parseTrustedProxies, proxyTrust } from '../../src/security/proxy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Simula `n` coletas a cada `stepMs`, avançando o relógio só o que a coleta pagou (como o settle). */
function collectEvery(p: IncomeInput, taxAppraisal: bigint, t0: Date, stepMs: number, n: number) {
  let last = t0;
  let tax = 0n;
  let gross = 0n;
  for (let i = 1; i <= n; i++) {
    const now = new Date(t0.getTime() + i * stepMs);
    const a = accrual(p, last, now, taxAppraisal);
    tax += a.tax;
    gross += a.gross;
    // GREATEST: o relógio nunca volta
    const until = new Date(last.getTime() + a.consumedMs);
    if (until > last) last = until;
  }
  return { tax, gross, last };
}

// ------------------------------------------------- IPTU zerado por arredondamento (CWE-682)
describe('RED r2: coletas a cada 1,5 s não zeram o IPTU', () => {
  const t0 = new Date('2026-01-01T00:00:00Z');
  const step = 1_500;
  // terreno vago de I$ 100 mil: < 1 centavo de IPTU a cada 1,5 s
  const vacant: IncomeInput = { category: 'vacant', appraisal: 10_000_000n, isResidence: false, business: null };

  it('pré-condição: uma coleta de 1,5 s sozinha dá 0 de IPTU (o vetor existe)', () => {
    expect(accrual(vacant, t0, new Date(t0.getTime() + step)).tax).toBe(0n);
  });

  it('100 coletas de 1,5 s cobram o mesmo que 1 coleta de 150 s (±1 centavo)', () => {
    const once = accrual(vacant, t0, new Date(t0.getTime() + 100 * step)).tax;
    expect(once).toBeGreaterThan(50n);
    const spam = collectEvery(vacant, vacant.appraisal, t0, step, 100);
    const d = spam.tax - once;
    expect(d >= -1n && d <= 1n, `spam=${spam.tax} uma=${once}`).toBe(true);
  });

  it('o tempo não cobrado continua no relógio (resto < 1 centavo de imposto)', () => {
    const spam = collectEvery(vacant, vacant.appraisal, t0, step, 100);
    const left = accrual(vacant, spam.last, new Date(t0.getTime() + 100 * step));
    expect(left.tax).toBe(0n);
    // o resto fracionário existe e é menor que o tempo de 1 centavo
    const perCentMs = 86_400_000 / (Number(vacant.appraisal) * ECONOMY.iptuPerDay);
    expect(t0.getTime() + 100 * step - spam.last.getTime()).toBeLessThan(perCentMs + 1);
  });

  it('imóvel com renda: spam não zera o IPTU e não cria renda extra', () => {
    const shop: IncomeInput = { category: 'commercial', appraisal: 10_000_000n, isResidence: false, business: null };
    const once = accrual(shop, t0, new Date(t0.getTime() + 100 * step));
    const spam = collectEvery(shop, shop.appraisal, t0, step, 100);
    const d = spam.tax - once.tax;
    expect(d >= -1n && d <= 1n).toBe(true);
    expect(spam.gross <= once.gross + 1n).toBe(true);
  });

  it('no teto de 24 h a renda continua exata; acima de 30 dias o IPTU para no teto', () => {
    const res: IncomeInput = { category: 'residential', appraisal: 1_000_000n, isResidence: false, business: null };
    const t48 = new Date(t0.getTime() + 48 * 3_600_000);
    expect(accrual(res, t0, t48).gross).toBe(BigInt(Math.floor(1_000_000 * ECONOMY.incomeRatePerHour.residential * 24)));
    const t60d = new Date(t0.getTime() + 60 * 86_400_000);
    const a = accrual(vacant, t0, t60d);
    expect(a.consumedMs).toBe(60 * 86_400_000);
    expect(a.tax).toBe(BigInt(Math.floor(Number(vacant.appraisal) * ECONOMY.iptuPerDay * ECONOMY.maxTaxAccrualHours / 24)));
  });

  it('sem IPTU nem renda (residência isenta) o relógio avança tudo', () => {
    const home: IncomeInput = { category: 'residential', appraisal: 5_000_000n, isResidence: true, business: null };
    const a = accrual(home, t0, new Date(t0.getTime() + step), 0n);
    expect(a.consumedMs).toBe(step);
    expect(a.tax + a.gross).toBe(0n);
  });
});

// ------------------------------------------------- X-Forwarded-For forjado (CWE-348)
describe('RED r2: X-Forwarded-For só vale vindo do proxy configurado', () => {
  const caddy = '10.203.47.2';
  const trust = proxyTrust(1, [caddy]);

  it('par direto qualquer (web, LAN) não é confiável: o IP é o do socket', () => {
    expect(trust('10.203.47.9', 0)).toBe(false);
    expect(trust('192.168.0.50', 0)).toBe(false);
    expect(trust('172.18.0.4', 0)).toBe(false);
  });
  it('o Caddy é confiável só no 1º salto (o X-F-F mais à direita é o cliente)', () => {
    expect(trust(caddy, 0)).toBe(true);
    expect(trust(`::ffff:${caddy}`, 0)).toBe(true);
    expect(trust(caddy, 1)).toBe(false);
  });
  it('HOPS 0 ou lista vazia = ninguém', () => {
    expect(proxyTrust(0, [caddy])(caddy, 0)).toBe(false);
    expect(proxyTrust(1, [])(caddy, 0)).toBe(false);
  });
  it('CIDR e IPv6', () => {
    const t = proxyTrust(2, ['10.203.47.0/29', 'fd00::/64']);
    expect(t('10.203.47.6', 0)).toBe(true);
    expect(t('10.203.47.9', 0)).toBe(false);
    expect(t('fd00::1', 1)).toBe(true);
    expect(t('fd01::1', 0)).toBe(false);
    expect(t('não-é-ip', 0)).toBe(false);
  });
  it('lista inválida é recusada', () => {
    for (const bad of ['caddy', '10.0.0.1/33', '10.0.0.1/8/1', 'fd00::/129', '10.0.0.1/x']) {
      expect(() => parseTrustedProxies(bad), bad).toThrow();
    }
    expect(parseTrustedProxies(' 10.0.0.1 , fd00::/64 ,')).toEqual(['10.0.0.1', 'fd00::/64']);
  });

  const env = {
    DATABASE_URL: 'postgres://a:b@db/x',
    APP_ORIGIN: 'https://localhost:8443',
    SESSION_KEY: Buffer.alloc(32, 1).toString('base64'),
    CSRF_KEY: Buffer.alloc(32, 2).toString('base64'),
    EMAIL_ENC_KEY: Buffer.alloc(32, 3).toString('base64'),
    EMAIL_HASH_KEY: Buffer.alloc(32, 4).toString('base64'),
  };
  it('padrões fora do Docker: escuta local e X-Forwarded-For ignorado', () => {
    const c = loadConfig(env);
    expect(c.host).toBe('127.0.0.1');
    expect(c.trustProxyHops).toBe(0);
    expect(c.trustedProxies).toEqual([]);
  });
  it('TRUST_PROXY_HOPS sem TRUSTED_PROXIES não sobe', () => {
    expect(() => loadConfig({ ...env, TRUST_PROXY_HOPS: '1' })).toThrow(/TRUSTED_PROXIES/);
    expect(() => loadConfig({ ...env, TRUST_PROXY_HOPS: '1', TRUSTED_PROXIES: 'caddy' })).toThrow(/TRUSTED_PROXIES/);
    expect(loadConfig({ ...env, TRUST_PROXY_HOPS: '1', TRUSTED_PROXIES: '10.203.47.2' }).trustedProxies).toEqual(['10.203.47.2']);
  });
  it('produção recusa a credencial do dono no server', () => {
    const prod = {
      ...env,
      NODE_ENV: 'production',
      PGSSLROOTCERT: path.join(ROOT, 'package.json'), // qualquer arquivo legível
      PASSWORD_PEPPER: Buffer.alloc(32, 5).toString('base64'),
    };
    expect(() => loadConfig(prod)).not.toThrow();
    expect(() => loadConfig({ ...prod, MIGRATION_DATABASE_URL: 'postgres://o:p@db/x' })).toThrow(/MIGRATION_DATABASE_URL/);
  });
});

// ------------------------------------------------- infraestrutura (compose)
/** Bloco de um serviço do docker-compose.yml (até o próximo serviço de mesmo nível). */
function service(name: string): string {
  const yml = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8').replace(/\r\n/g, '\n');
  const start = yml.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`serviço ${name} não encontrado`);
  const rest = yml.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n|\n\S/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}
/** Linhas efetivas (sem comentários). */
const code = (block: string) =>
  block
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

describe('RED r2: credencial do dono e install de dependências no compose', () => {
  it('o server não recebe MIGRATION_DATABASE_URL nem a senha do dono (CWE-250)', () => {
    const s = code(service('server'));
    expect(s).toContain('DATABASE_URL: postgres://minitown_app:');
    expect(s).not.toMatch(/MIGRATION_DATABASE_URL|MINITOWN_OWNER_PASSWORD|minitown_owner/);
  });
  it('o migrate (dono) não tem saída para a internet e não instala nada (CWE-829)', () => {
    const m = code(service('migrate'));
    expect(m).toMatch(/networks: \[data\]/);
    expect(m).not.toMatch(/egress|edge|NODE_DEPS_INSTALL/);
    expect(m).toMatch(/server-deps:\s*\n\s*condition: service_completed_successfully/);
  });
  it('quem instala (server-deps) não tem segredo nem rede data', () => {
    const d = code(service('server-deps'));
    expect(d).toMatch(/networks: \[egress\]/);
    expect(d).not.toMatch(/data|DATABASE_URL|PASSWORD|_KEY/);
  });
  it('server só na rede do proxy + data, confiando só no IP fixo do Caddy (CWE-348)', () => {
    const s = code(service('server'));
    expect(s).toMatch(/networks: \[proxy, data\]/);
    const ip = /TRUSTED_PROXIES: (\S+)/.exec(s)?.[1];
    expect(ip).toBeTruthy();
    expect(code(service('caddy'))).toContain(`ipv4_address: ${ip}`);
    expect(code(service('web'))).toMatch(/networks: \[edge\]/);
  });
  it('o entrypoint instala sem scripts e só com NODE_DEPS_INSTALL=1', () => {
    const sh = readFileSync(path.join(ROOT, 'docker/node-entrypoint.sh'), 'utf8');
    const installs = sh.split('\n').filter((l) => /^\s*npm (ci|install)\b/.test(l));
    expect(installs.length).toBeGreaterThan(0);
    for (const l of installs) expect(l).toContain('--ignore-scripts');
    expect(sh).toMatch(/NODE_DEPS_INSTALL:-}" != "1"/);
  });
});
