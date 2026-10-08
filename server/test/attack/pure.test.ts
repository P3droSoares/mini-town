/**
 * RED TEAM — ataques às superfícies PURAS (sem banco): validação de entrada,
 * nome de exibição (XSS/homóglifo/zero-width), chave de idempotência,
 * constantes criptográficas e aritmética de dinheiro.
 *
 * Roda offline (UNIT_ONLY=1). Cada bloco envia o vetor pelo caminho real da
 * função pública e afirma o EFEITO (rejeição / ausência de ganho), não a
 * mensagem. São as travas que impedem os ataques do escopo do red team;
 * servem de regressão: revertê-las deixa o teste vermelho.
 */
import { describe, expect, it } from 'vitest';
import { ECONOMY } from '../../src/economy/config.js';
import { askRange, marketFee, mulFrac, sellToCityPrice } from '../../src/economy/pricing.js';
import { idempotencyKey } from '../../src/economy/runner.js';
import { csrfMatches, csrfTokenFor, deviceIdFor, newDeviceToken, safeEqual } from '../../src/security/crypto.js';
import { displayNameKey, normalizeDisplayName } from '../../src/security/displayName.js';
import { passwordProblem } from '../../src/security/password.js';
import { centsSchema, emptyBody, lotIdSchema, parse } from '../../src/http/validate.js';

// ------------------------------------------------------------- dinheiro do nada (validação)
describe('RED: valor em centavos recusa números extremos e tipos errados', () => {
  const cents = centsSchema(ECONOMY.market.maxAskPrice);
  const reject = (v: unknown) => expect(cents.safeParse(v).success, `deveria recusar ${String(v)}`).toBe(false);

  it('number: NaN, ±Infinity, -0, 0, fração, acima do seguro, acima do teto', () => {
    for (const v of [NaN, Infinity, -Infinity, -0, 0, -1, 1.5, 100.0001, 1e308, 2 ** 53, Number.MAX_VALUE]) reject(v);
    reject(Number(ECONOMY.market.maxAskPrice) + 1); // acima do teto do mercado
  });
  it('string: "1e3", decimal, negativo, zero à esquerda, espaços, hex, vazio', () => {
    for (const v of ['1e3', '1.5', '-5', '0', '05', ' 5', '5 ', '0x10', '', '1,5', '+5', '٥']) reject(v);
  });
  it('outros tipos: array, objeto, bool, null, undefined, bigint', () => {
    for (const v of [[5], ['5'], { valueOf: () => 5 }, true, null, undefined, 5n]) reject(v);
  });
  it('valor legítimo continua passando e vira bigint exato', () => {
    const r = cents.safeParse('100');
    expect(r.success && r.data).toBe(100n);
    expect(cents.safeParse(100).success).toBe(true);
    // 18 dígitos passam o regex mas o teto do mercado barra (refine)
    expect(cents.safeParse('999999999999999999').success).toBe(false);
  });
});

describe('RED: corpo "vazio" recusa campos extras, arrays e injeção de chave', () => {
  const ok = (v: unknown) => expect(() => parse(emptyBody, v)).not.toThrow();
  const no = (v: unknown) => expect(() => parse(emptyBody, v)).toThrow();
  it('aceita só ausência de corpo ou objeto vazio', () => {
    ok(undefined);
    ok(null);
    ok({});
  });
  it('recusa campos extras, arrays e strings', () => {
    no({ lotId: 'ITB-X' });
    no({ amount: 1 });
    no([]);
    no(['x']);
    no('oi');
    no(123);
  });
  it('lotId só no formato ITB-...; sem traversal nem injeção', () => {
    expect(lotIdSchema.safeParse('ITB-ABC-123').success).toBe(true);
    for (const v of ['../etc', "ITB-' OR 1=1--", 'ITB-x;DROP', 'itb-abc', 'ITB-' + 'A'.repeat(50), 'ITB-abc']) {
      expect(lotIdSchema.safeParse(v).success, v).toBe(false);
    }
  });
});

// ------------------------------------------------------------- XSS / impersonação por nome
describe('RED: displayName bloqueia XSS, zero-width, bidi e homóglifos de outro alfabeto', () => {
  const blocked = (v: string) => expect(normalizeDisplayName(v), v).toBeNull();
  it('markup e aspas são recusados (sem HTML chegando ao front)', () => {
    for (const v of [
      '<script>alert(1)</script>',
      '"><img src=x onerror=alert(1)>',
      "'><svg/onload=alert(1)>",
      'a<b>c',
      'João&amp;',
      'a`b`c',
      'a{{7*7}}b',
    ]) blocked(v);
  });
  it('zero-width, joiners, soft-hyphen e controles bidi são recusados', () => {
    for (const v of ['Pedro​X', 'Pe‌dro', 'Pe‍dro', 'Pedro­', 'Pedro‮', '‭Pedro', 'Pe﻿dro']) {
      blocked(v);
    }
  });
  it('alfabetos confusáveis (cirílico, grego) são recusados', () => {
    blocked('Pаypal'); // "а" cirílico
    blocked('Αdmin'); // alfa grego
    blocked('аdmin'); // "а" cirílico
  });
  it('nome legítimo (latino com acento) é aceito', () => {
    expect(normalizeDisplayName('José da Silva')).toBe('José da Silva');
    expect(normalizeDisplayName('Ｐｅｄｒｏ')).toBe('Pedro'); // largura cheia dobra via NFKC
  });
  it('esqueleto unifica confusáveis: a segunda conta parecida colide (índice único recusa)', () => {
    expect(displayNameKey('rnaria')).toBe(displayNameKey('maria')); // rn→m
    expect(displayNameKey('Wil1iam')).toBe(displayNameKey('William')); // 1→l
    expect(displayNameKey('Pedr0')).toBe(displayNameKey('Pedro')); // 0→o
    expect(displayNameKey('vvilson')).toBe(displayNameKey('wilson')); // vv→w
    expect(displayNameKey('A_d.m-i n')).toBe(displayNameKey('admin')); // separadores somem
  });
});

// ------------------------------------------------------------- entrar na conta de outro
describe('RED: idempotência exige UUID v4 válido (sem replay forjado)', () => {
  const req = (h: Record<string, unknown>) => ({ headers: h }) as never;
  it('sem header, header duplicado (array) ou não-UUID = recusa', () => {
    expect(() => idempotencyKey(req({}))).toThrow();
    expect(() => idempotencyKey(req({ 'idempotency-key': ['a', 'b'] }))).toThrow();
    expect(() => idempotencyKey(req({ 'idempotency-key': 'nao-uuid' }))).toThrow();
    expect(() => idempotencyKey(req({ 'idempotency-key': '00000000-0000-0000-0000-000000000000' }))).toThrow(); // v0
  });
  it('UUID v4 é aceito e normalizado para minúsculas', () => {
    expect(idempotencyKey(req({ 'idempotency-key': '9B2E4C7A-1234-4F6A-8B1C-0123456789AB' }))).toBe(
      '9b2e4c7a-1234-4f6a-8b1c-0123456789ab',
    );
  });
});

describe('RED: comparações de segredo são em tempo constante e não forjáveis', () => {
  const csrfKey = Buffer.alloc(32, 42);
  it('token CSRF só confere para a própria sessão', () => {
    const good = csrfTokenFor(csrfKey, 'sess-1');
    expect(csrfMatches(csrfKey, 'sess-1', good)).toBe(true);
    expect(csrfMatches(csrfKey, 'sess-2', good)).toBe(false); // token de outra sessão
    expect(csrfMatches(csrfKey, 'sess-1', 'x'.repeat(43))).toBe(false); // adivinhado
    expect(csrfMatches(csrfKey, 'sess-1', good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A'))).toBe(false);
    expect(csrfMatches(csrfKey, 'sess-1', good + 'x')).toBe(false); // tamanho errado
  });
  it('cookie de dispositivo não vale para outra conta (sem rebaixar a força bruta da vítima)', () => {
    const key = Buffer.alloc(32, 5);
    const victim = Buffer.alloc(32, 1);
    const attacker = Buffer.alloc(32, 2);
    const tok = newDeviceToken(key, victim);
    expect(deviceIdFor(key, victim, tok)).toBeTruthy();
    expect(deviceIdFor(key, attacker, tok)).toBeNull(); // cookie da vítima em outra conta
    expect(deviceIdFor(key, victim, tok.slice(0, -2) + 'AA')).toBeNull();
  });
  it('safeEqual recusa tamanhos diferentes sem lançar', () => {
    expect(safeEqual(Buffer.from('aaa'), Buffer.from('aaaa'))).toBe(false);
    expect(safeEqual(Buffer.from('abc'), Buffer.from('abd'))).toBe(false);
    expect(safeEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
  });
});

// ------------------------------------------------------------- senha fraca (controle §2.5)
describe('RED: força de senha é medida na MESMA string que será guardada (NFKC)', () => {
  it('senha comum "disfarçada" em largura cheia é recusada (antes furava a lista)', () => {
    // "ｐａｓｓｗｏｒｄ１２３" normaliza (NFKC) para "password123", uma senha comum.
    expect(passwordProblem('ｐａｓｓｗｏｒｄ１２３')).not.toBeNull();
    expect(passwordProblem('password123')).not.toBeNull(); // controle direto
  });
  it('variedade e comprimento também contam a forma normalizada', () => {
    expect(passwordProblem('ａａａａａａａａａａ')).not.toBeNull(); // pouca variedade após NFKC
    expect(passwordProblem('Cavalo-Bateria-Grampo-42')).toBeNull(); // senha forte continua aceita
  });
  it('senha não pode conter nome/e-mail', () => {
    expect(passwordProblem('pedro-super-forte-1', ['pedro'])).not.toBeNull();
  });
});

// ------------------------------------------------------------- dinheiro do nada (aritmética)
describe('RED: aritmética de dinheiro nunca cria crédito do nada', () => {
  it('taxa de mercado nunca é negativa (comprador não "paga" negativo ao vendedor)', () => {
    for (let appr = 1000n; appr <= 10_000_000n; appr *= 10n) {
      const r = askRange(appr);
      for (const ask of [r.min, (r.min + r.max) / 2n, r.max]) {
        const fee = marketFee(ask, appr);
        expect(fee >= 0n).toBe(true);
        expect(ask - fee >= 0n).toBe(true); // líquido do vendedor ≥ 0
      }
    }
  });
  it('venda ao governo nunca excede o teto nem vira lucro com índice bombeado', () => {
    // avaliação inflada mas preço pago baixo: recebe 70% do MENOR (sem arbitragem)
    expect(sellToCityPrice(10_000_000n, 1_000_000n)).toBe(mulFrac(1_000_000n, ECONOMY.sellToCityRate));
    expect(sellToCityPrice(1_000_000n, 10_000_000n)).toBe(mulFrac(1_000_000n, ECONOMY.sellToCityRate));
    expect(sellToCityPrice(1_000_000n, null) < 1_000_000n).toBe(true);
  });
  it('faixa do anúncio fica dentro de 80–130% (sem anúncio fora da faixa)', () => {
    const r = askRange(1_000_000n);
    expect(r.min).toBe(mulFrac(1_000_000n, ECONOMY.market.minAskRatio));
    expect(r.max).toBe(mulFrac(1_000_000n, ECONOMY.market.maxAskRatio));
    expect(r.min < r.max).toBe(true);
  });
});
