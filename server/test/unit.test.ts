import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ECONOMY } from '../src/economy/config.js';
import { nextIndex } from '../src/economy/indices.js';
import {
  accrual,
  appraisal,
  askRange,
  basePrice,
  businessOpenCost,
  businessUpgradeCost,
  cityPrice,
  competitionFactor,
  demandWeight,
  incomePerHour,
  iptuMultiplier,
  locationFactor,
  marketFee,
  mulFrac,
  roundSignificant,
  sellToCityPrice,
} from '../src/economy/pricing.js';
import { cached } from '../src/http/cache.js';
import { decryptEmail, deviceIdFor, emailHash, encryptEmail, ipNetwork, newDeviceToken } from '../src/security/crypto.js';
import { displayNameKey, normalizeDisplayName } from '../src/security/displayName.js';
import { hashPassword, needsRehash, pepperVersionOf, verifyPassword } from '../src/security/password.js';
import { lockSeconds } from '../src/security/policy.js';

describe('configuração', () => {
  const base = {
    DATABASE_URL: 'postgres://a:b@db/x',
    MIGRATION_DATABASE_URL: 'postgres://o:p@db/x',
    APP_ORIGIN: 'https://localhost:8443',
    SESSION_KEY: Buffer.alloc(32, 1).toString('base64'),
    CSRF_KEY: Buffer.alloc(32, 2).toString('base64'),
    EMAIL_ENC_KEY: Buffer.alloc(32, 3).toString('base64'),
    EMAIL_HASH_KEY: Buffer.alloc(32, 4).toString('base64'),
  };
  it('aceita ambiente completo; vazio = ausente', () => {
    expect(loadConfig(base).appOrigin).toBe('https://localhost:8443');
    const c = loadConfig({ ...base, PGSSLROOTCERT: '', PASSWORD_PEPPER: '', MIGRATION_DATABASE_URL: '' });
    expect(c.pgCa).toBeNull();
    expect(c.passwordPepper).toBeNull();
    expect(c.migrationDatabaseUrl).toBeNull();
    expect(() => loadConfig({ ...base, SESSION_KEY: '' })).toThrow(/SESSION_KEY/);
  });
  it('falha sem segredo, com chave curta ou repetida', () => {
    const { SESSION_KEY: _drop, ...noSession } = base;
    expect(() => loadConfig(noSession)).toThrow(/SESSION_KEY/);
    expect(() => loadConfig({ ...base, CSRF_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/CSRF_KEY/);
    expect(() => loadConfig({ ...base, CSRF_KEY: base.SESSION_KEY })).toThrow(/distintas/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/PGSSLROOTCERT/);
  });
  it('chaves de e-mail e peppers versionados (rotação)', () => {
    const old = Buffer.alloc(32, 9).toString('base64');
    const c = loadConfig({ ...base, EMAIL_KEY_VERSION: '2', EMAIL_ENC_KEY_1: old, PASSWORD_PEPPER: old, PASSWORD_PEPPER_VERSION: '3' });
    expect([...c.emailEncKeys.keys()].sort()).toEqual([1, 2]);
    expect(c.passwordPepperVersion).toBe(3);
    expect(c.passwordPeppers.get(3)?.equals(Buffer.alloc(32, 9))).toBe(true);
    expect(() => loadConfig({ ...base, EMAIL_ENC_KEY_7: 'curta' })).toThrow(/EMAIL_ENC_KEY_7/);
    expect(() => loadConfig({ ...base, EMAIL_ENC_KEY_1: old })).toThrow(/difere/);
  });
  it('mensagem de erro não vaza valores', () => {
    try {
      loadConfig({ ...base, EMAIL_ENC_KEY: 'segredo-invalido-123' });
    } catch (e) {
      expect((e as Error).message).not.toContain('segredo-invalido-123');
    }
  });
});

describe('preço', () => {
  it('localização cai com a distância e tamanho tem ganho de escala', () => {
    expect(locationFactor(0)).toBeCloseTo(ECONOMY.location.max);
    expect(locationFactor(500)).toBeLessThan(locationFactor(100));
    expect(locationFactor(100_000)).toBeCloseTo(ECONOMY.location.min);
    const small = basePrice('residential', 50, 1, 300);
    const big = basePrice('residential', 500, 1, 300);
    expect(Number(big) / 500).toBeLessThan(Number(small) / 50);
  });
  it('andares multiplicam a projeção do prédio; terreno entra à parte', () => {
    expect(basePrice('residential', 100, 2, 0)).toBeGreaterThan(basePrice('residential', 100, 1, 0));
    expect(basePrice('vacant', 200, 0, 0)).toBe(BigInt(200 * ECONOMY.valorM2Terreno * 100));
    expect(basePrice('vacant', 1, 0, 0)).toBe(ECONOMY.minAppraisal);
    // quintal não é multiplicado pelos andares: lote grande com casa pequena vale menos que casa do tamanho do lote
    const yard = basePrice('residential', 57, 2, 300, 162);
    const whole = basePrice('residential', 162, 2, 300, 162);
    expect(yard).toBeLessThan(whole);
    expect(yard - basePrice('residential', 57, 2, 300)).toBe(BigInt(162 * ECONOMY.valorM2Terreno * 100));
  });
  it('avaliação = base × índice com piso inteiro; faixa 80–130%; taxa progressiva acima de 110%', () => {
    expect(appraisal(1_000_001n, 10_000)).toBe(1_000_001n);
    expect(appraisal(1_000_001n, 15_000)).toBe(1_500_001n);
    expect(askRange(1000n)).toEqual({ min: 800n, max: 1300n });
    expect(mulFrac(999n, 0.7)).toBe(699n);
    expect(marketFee(1000n, 1000n)).toBe(50n);
    // 5% de 1300 + 20% de (1300 - 1100)
    expect(marketFee(1300n, 1000n)).toBe(65n + 40n);
  });
  it('venda ao governo: 70% do menor entre avaliação e preço pago', () => {
    expect(sellToCityPrice(1000n, null)).toBe(700n);
    expect(sellToCityPrice(1800n, 1000n)).toBe(700n);
    expect(sellToCityPrice(800n, 1000n)).toBe(560n);
  });
  it('preço da prefeitura progressivo e peso da demanda pelo valor', () => {
    expect(cityPrice(1000n, 0)).toBe(1000n);
    expect(cityPrice(1000n, ECONOMY.city.progressiveFrom - 1)).toBe(1000n);
    expect(cityPrice(1000n, ECONOMY.city.progressiveFrom)).toBe(1050n);
    expect(cityPrice(1000n, 10_000)).toBe(2000n);
    expect(demandWeight(10n, 1000n)).toBe(ECONOMY.index.minWeight);
    expect(demandWeight(500n, 1000n)).toBeCloseTo(0.5);
    expect(demandWeight(5000n, 1000n)).toBe(1);
  });
  it('renda: residência e casa sob gravame zero; negócio nunca abaixo de sem negócio', () => {
    const base = { category: 'commercial' as const, appraisal: 1_000_000n, isResidence: false, business: null };
    const plain = incomePerHour(base);
    const biz = incomePerHour({ ...base, business: { type: 'mercado', level: 1, competitors: 0 } });
    const crowded = incomePerHour({ ...base, business: { type: 'mercado', level: 1, competitors: 4 } });
    const swamped = incomePerHour({ ...base, business: { type: 'loja', level: 1, competitors: 100 } });
    const lvl5 = incomePerHour({ ...base, business: { type: 'mercado', level: 5, competitors: 0 } });
    expect(biz).toBeGreaterThan(plain);
    expect(crowded).toBeLessThan(biz);
    expect(swamped).toBe(plain);
    expect(lvl5).toBeCloseTo(biz * (1 + 4 * ECONOMY.business.levelBonus));
    expect(competitionFactor(1000)).toBe(ECONOMY.business.competitionMin);
    expect(incomePerHour({ ...base, category: 'residential', isResidence: true })).toBe(0);
    expect(incomePerHour({ ...base, category: 'residential', encumbered: true })).toBe(0);
  });
  it('IPTU por tempo real (teto alto), renda com teto de 24 h, progressivo pela carteira', () => {
    const p = { category: 'residential' as const, appraisal: 1_000_000n, isResidence: false, business: null };
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t48 = new Date(t0.getTime() + 48 * 3_600_000);
    const a = accrual(p, t0, t48);
    expect(a.gross).toBe(BigInt(Math.floor(1_000_000 * ECONOMY.incomeRatePerHour.residential * 24)));
    expect(a.tax).toBe(BigInt(Math.floor(1_000_000 * ECONOMY.iptuPerDay * 2)));
    expect(iptuMultiplier(ECONOMY.iptuProgressive.free)).toBe(1);
    expect(iptuMultiplier(10_000)).toBe(ECONOMY.iptuProgressive.maxMultiplier);
    expect(accrual(p, t0, t48, 1_000_000n, 2).tax).toBe(a.tax * 2n);
  });
  it('custo do negócio proporcional à avaliação (com piso)', () => {
    expect(businessOpenCost(100_000_000n)).toBe(mulFrac(100_000_000n, ECONOMY.business.openCostRate));
    expect(businessOpenCost(1_000n)).toBe(ECONOMY.business.minOpenCost);
    expect(businessUpgradeCost(100_000_000n, 5)).toBeNull();
    expect(businessUpgradeCost(100_000_000n, 1)).toBe(businessOpenCost(100_000_000n));
    expect(businessUpgradeCost(100_000_000n, 4)).toBe(mulFrac(businessOpenCost(100_000_000n), 5));
  });
  it('arredondamento relativo do patrimônio público', () => {
    expect(roundSignificant(123_456_789n, 2, 100_000n)).toBe(120_000_000n);
    expect(roundSignificant(149_999n, 2, 100_000n)).toBe(100_000n);
    expect(roundSignificant(3_000_000n, 2, 100_000n)).toBe(3_000_000n);
    expect(roundSignificant(-123_456_789n, 2, 100_000n)).toBe(-120_000_000n);
  });
});

describe('índice de mercado', () => {
  const t0 = new Date('2026-01-01T00:00:00Z');
  const s = { indexBp: 10_000, anchorBp: 10_000, anchorAt: t0, updatedAt: t0, emaBp: 10_000 };
  it('respeita a variação máxima por hora', () => {
    let st = s;
    for (let i = 0; i < 100; i++) st = nextIndex(st, 100, new Date(t0.getTime() + i * 1000));
    expect(st.indexBp).toBe(10_000 + ECONOMY.index.maxHourlyChangeBp);
  });
  it('respeita a faixa [0,6; 1,8] e reverte à média', () => {
    let st = s;
    for (let h = 0; h < 200; h++) st = nextIndex(st, -10_000, new Date(t0.getTime() + h * 3_600_000));
    expect(st.indexBp).toBe(ECONOMY.index.minBp);
    const later = nextIndex(st, 0, new Date(t0.getTime() + 400 * 3_600_000));
    expect(later.indexBp).toBeGreaterThan(st.indexBp);
  });
  it('média móvel acompanha devagar: pico curto quase não muda a EMA', () => {
    let st = s;
    for (let i = 0; i < 60; i++) st = nextIndex(st, 100, new Date(t0.getTime() + i * 60_000));
    expect(st.indexBp).toBe(10_500);
    expect(st.emaBp).toBeLessThan(10_050);
  });
});

describe('cripto e identidade', () => {
  it('e-mail: cifra com IV aleatório, decifra, detecta adulteração; hash normalizado', () => {
    const key = Buffer.alloc(32, 7);
    const a = encryptEmail(key, 1, 'Ana@Exemplo.test');
    const b = encryptEmail(key, 1, 'ana@exemplo.test');
    expect(a.equals(b)).toBe(false);
    expect(decryptEmail(new Map([[1, key]]), a)).toBe('ana@exemplo.test');
    const tampered = Buffer.from(a);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => decryptEmail(new Map([[1, key]]), tampered)).toThrow();
    expect(emailHash(key, ' ANA@exemplo.test ').equals(emailHash(key, 'ana@exemplo.test'))).toBe(true);
    // rotação: chave antiga continua decifrando
    const k2 = Buffer.alloc(32, 8);
    expect(decryptEmail(new Map([[1, key], [2, k2]]), a)).toBe('ana@exemplo.test');
  });
  it('backoff exponencial limitado', () => {
    const r = { freeFailures: 5, baseLockSec: 15, maxLockSec: 900 };
    expect(lockSeconds(r, 5)).toBe(0);
    expect(lockSeconds(r, 6)).toBe(15);
    expect(lockSeconds(r, 7)).toBe(30);
    expect(lockSeconds(r, 50)).toBe(900);
  });
  it('rede de origem: IPv4 exato, IPv6 agrupado em /64', () => {
    expect(ipNetwork('10.1.2.3')).toBe('10.1.2.3');
    expect(ipNetwork('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(ipNetwork('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(ipNetwork('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(ipNetwork('2001:0db8:0001:0002::7'));
    expect(ipNetwork('2001:db8:1:3::1')).not.toBe(ipNetwork('2001:db8:1:2::1'));
  });
  it('cookie de dispositivo vale só para a conta que o recebeu', () => {
    const key = Buffer.alloc(32, 5);
    const acc = Buffer.alloc(32, 1);
    const tok = newDeviceToken(key, acc);
    expect(deviceIdFor(key, acc, tok)).toBeTruthy();
    expect(deviceIdFor(key, Buffer.alloc(32, 2), tok)).toBeNull();
    expect(deviceIdFor(key, acc, tok.slice(0, -2) + 'AA')).toBeNull();
    expect(deviceIdFor(key, acc, undefined)).toBeNull();
  });
  it('nome de exibição: NFKC, só latino, esqueleto contra homóglifos', () => {
    expect(normalizeDisplayName('Pedro')).toBe('Pedro');
    expect(normalizeDisplayName('Ｐｅｄｒｏ')).toBe('Pedro'); // largura cheia → NFKC
    expect(normalizeDisplayName('Pеdro')).toBeNull(); // "е" cirílico
    expect(normalizeDisplayName('Πedro')).toBeNull();
    expect(normalizeDisplayName('José da Silva')).toBe('José da Silva');
    expect(normalizeDisplayName('a  b')).toBeNull();
    expect(normalizeDisplayName('<script>')).toBeNull();
    expect(displayNameKey('Pedro')).toBe(displayNameKey('PEDRO'));
    expect(displayNameKey('Joao')).toBe(displayNameKey('João'));
    expect(displayNameKey('Pedr0')).toBe(displayNameKey('Pedro'));
    expect(displayNameKey('Wil1iam')).toBe(displayNameKey('William'));
    expect(displayNameKey('rnaria')).toBe(displayNameKey('maria'));
    expect(displayNameKey('Ana_Lu')).toBe(displayNameKey('ana lu'));
  });
  it('senha: pepper versionado no hash; formato antigo é regravado', async () => {
    const p1 = Buffer.alloc(32, 1);
    const p2 = Buffer.alloc(32, 2);
    const v1 = { passwordPepper: p1, passwordPepperVersion: 1, passwordPeppers: new Map([[1, p1]]) };
    const h = await hashPassword('Cavalo-Bateria-42', v1);
    expect(pepperVersionOf(h)).toBe(1);
    expect(await verifyPassword(h, 'Cavalo-Bateria-42', v1)).toBe(true);
    // pepper trocado para a versão 2, mantendo o 1 como antigo: confere e pede regravação
    const v2 = { passwordPepper: p2, passwordPepperVersion: 2, passwordPeppers: new Map([[1, p1], [2, p2]]) };
    expect(await verifyPassword(h, 'Cavalo-Bateria-42', v2)).toBe(true);
    expect(needsRehash(h, v2)).toBe(true);
    // pepper removido do ambiente: não confere (e o boot recusa esse estado)
    const none = { passwordPepper: null, passwordPepperVersion: 1, passwordPeppers: new Map<number, Buffer>() };
    expect(await verifyPassword(h, 'Cavalo-Bateria-42', none)).toBe(false);
    const h0 = await hashPassword('Cavalo-Bateria-42', none);
    expect(pepperVersionOf(h0)).toBe(0);
    expect(await verifyPassword(h0, 'Cavalo-Bateria-42', v2)).toBe(true);
    // hash antigo sem prefixo = pepper atual
    const legacy = h.slice(h.indexOf('$') + 1);
    expect(await verifyPassword(legacy, 'Cavalo-Bateria-42', v1)).toBe(true);
    expect(needsRehash(legacy, v1)).toBe(true);
  });
  it('cache single-flight: chamadas simultâneas recalculam uma vez', async () => {
    let n = 0;
    let t = 0;
    const get = cached(1000, async () => ++n, () => t);
    expect(await Promise.all([get(), get(), get()])).toEqual([1, 1, 1]);
    t = 500;
    expect(await get()).toBe(1);
    t = 1500;
    expect(await get()).toBe(2);
  });
});
