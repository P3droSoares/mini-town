import type { Cents } from './api';

/**
 * Dinheiro no cliente: sempre centavos inteiros em `bigint` (nunca float).
 * Exibição "I$ 1.234,56" com Intl pt-BR.
 */

const INT_RE = /^-?\d{1,30}$/;
const groupFmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0, useGrouping: true });

/** string de centavos -> bigint (valor malformado vira 0n) */
export function cents(v: Cents | bigint | null | undefined): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v !== 'string' || !INT_RE.test(v)) return 0n;
  return BigInt(v);
}

/** soma de valores em centavos (exata) */
export function sumCents(list: Iterable<Cents | bigint | null | undefined>): bigint {
  let s = 0n;
  for (const v of list) s += cents(v);
  return s;
}

export interface MoneyOptions {
  /** mostra "+" em valores positivos (extrato) */
  sign?: boolean;
  /** omite os centavos quando zerados (ranking, valores redondos) */
  compactCents?: boolean;
}

/** "I$ 1.234,56" */
export function formatMoney(v: Cents | bigint | null | undefined, opts: MoneyOptions = {}): string {
  const c = cents(v);
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const int = groupFmt.format(abs / 100n);
  const frac = (abs % 100n).toString().padStart(2, '0');
  const sign = neg ? '−' : opts.sign && c > 0n ? '+' : '';
  const tail = opts.compactCents && frac === '00' ? '' : `,${frac}`;
  return `${sign}I$ ${int}${tail}`;
}

/** "I$ 1,2 mi" / "I$ 30 mil" — para espaços apertados (HUD no celular) */
export function formatMoneyShort(v: Cents | bigint | null | undefined): string {
  const c = cents(v);
  const reais = Number(c / 100n);
  const abs = Math.abs(reais);
  const sign = reais < 0 ? '−' : '';
  if (abs < 1000) return `${sign}I$ ${abs}`;
  const [n, suf] = abs >= 1e9 ? [abs / 1e9, 'bi'] : abs >= 1e6 ? [abs / 1e6, 'mi'] : [abs / 1e3, 'mil'];
  // trunca (não arredonda para cima: o jogador nunca vê mais do que tem)
  const t = Math.floor(n * 10) / 10;
  return `${sign}I$ ${t.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${suf}`;
}

/** pt-BR: "1.234,56", "1234,5", "1.234" (ponto só como milhar, grupos de 3) */
const BR_RE = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/;
/** ponto decimal com até 2 casas: "1234.56" */
const DOT_RE = /^(\d+)\.(\d{1,2})$/;

/**
 * Entrada do usuário -> centavos. Aceita "1.234,56", "1234,5", "1234.56",
 * "1.234" (milhar), "1234" e "I$ 1.234". Ambíguo/malformado ("1.234.56",
 * "12,345") = `null`: nunca adivinha um valor 100× maior ou menor.
 */
export function parseMoneyInput(raw: string): bigint | null {
  const s = raw.replace(/I\$|\s/gi, '');
  if (!s || s.length > 24) return null;
  const m = BR_RE.exec(s) ?? DOT_RE.exec(s);
  if (!m) return null;
  const int = m[1].replace(/\./g, '');
  if (int.length > 15) return null;
  return BigInt(int) * 100n + BigInt((m[2] ?? '0').padEnd(2, '0'));
}

/** centavos -> texto editável "1.234,56" (sem prefixo; aceito por parseMoneyInput) */
export function moneyToInput(v: Cents | bigint): string {
  const c = cents(v);
  const abs = c < 0n ? -c : c;
  return `${c < 0n ? '-' : ''}${groupFmt.format(abs / 100n)},${(abs % 100n).toString().padStart(2, '0')}`;
}

/** v * num / den com arredondamento para baixo (estimativas exibidas) */
export function scaleCents(v: Cents | bigint, num: bigint, den: bigint): bigint {
  return (cents(v) * num) / den;
}
