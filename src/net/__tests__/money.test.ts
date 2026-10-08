import { describe, expect, it } from 'vitest';
import { cents, formatMoney, formatMoneyShort, moneyToInput, parseMoneyInput, sumCents } from '../money';

describe('parseMoneyInput', () => {
  it.each([
    ['1.234', 123400n], // ponto com 3 dígitos = milhar (nunca 1,234)
    ['1.234,56', 123456n],
    ['1234,5', 123450n],
    ['1234.56', 123456n],
    ['1234.5', 123450n],
    ['I$ 1.234', 123400n],
    ['i$1.234,00', 123400n],
    ['1.234.567', 123456700n],
    ['150.000,00', 15000000n],
    ['0,01', 1n],
    ['  42 ', 4200n],
  ])('%s => %s centavos', (raw, want) => {
    expect(parseMoneyInput(raw)).toBe(want);
  });

  it.each(['', 'abc', '12,345', '1,2,3', '-5', '1e5', '1.234.56', '9'.repeat(25)])('rejeita %s', (raw) => {
    expect(parseMoneyInput(raw)).toBeNull();
  });

  it('volta o que moneyToInput escreve', () => {
    for (const v of [0n, 1n, 99n, 100n, 123456n, 1500000000n]) expect(parseMoneyInput(moneyToInput(v))).toBe(v);
  });
});

describe('formatMoney', () => {
  it('formata pt-BR com centavos', () => {
    expect(formatMoney('123456')).toBe('I$ 1.234,56');
    expect(formatMoney(5n)).toBe('I$ 0,05');
    expect(formatMoney('-123456')).toBe('−I$ 1.234,56');
  });
  it('sinal e centavos compactos', () => {
    expect(formatMoney(100n, { sign: true })).toBe('+I$ 1,00');
    expect(formatMoney(0n, { sign: true })).toBe('I$ 0,00');
    expect(formatMoney(300000000n, { compactCents: true })).toBe('I$ 3.000.000');
  });
  it('valor malformado vira zero (nunca NaN)', () => {
    expect(formatMoney('1.5')).toBe('I$ 0,00');
    expect(formatMoney(undefined)).toBe('I$ 0,00');
    expect(cents('12a')).toBe(0n);
  });
  it('soma exata', () => {
    expect(sumCents(['9007199254740993', '1'])).toBe(9007199254740994n);
  });
});

describe('formatMoneyShort', () => {
  it('trunca para baixo (nunca mostra mais do que tem)', () => {
    expect(formatMoneyShort(99999n * 100n)).toBe('I$ 99,9 mil');
    expect(formatMoneyShort(1_250_000n * 100n)).toBe('I$ 1,2 mi');
    expect(formatMoneyShort(999n * 100n)).toBe('I$ 999');
    expect(formatMoneyShort(-30_000n * 100n)).toBe('−I$ 30 mil');
  });
});
