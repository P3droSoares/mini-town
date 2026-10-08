/**
 * Nome de exibição público: NFKC, só alfabeto latino (com acentos), dígitos
 * ASCII e separadores simples. A unicidade usa um "esqueleto" que unifica
 * caracteres parecidos (acentos, 0/o, 1/l/i, rn/m, vv/w, 5/s), contra
 * falsificação no ranking e no mercado (UTS #39 simplificado).
 */

/** Letra latina, dígito ASCII, espaço, ponto, sublinhado ou hífen; começa e termina com letra/dígito. */
const NAME_RE = /^(?:(?=\p{L})\p{Script=Latin}|[0-9])(?:(?:(?=\p{L})\p{Script=Latin}|[0-9 ._-])*(?:(?=\p{L})\p{Script=Latin}|[0-9]))?$/u;

/** Normaliza (NFKC, espaços nas pontas); devolve null se o nome não for aceito. */
export function normalizeDisplayName(raw: string): string | null {
  const s = raw.normalize('NFKC').trim();
  const len = [...s].length;
  if (len < 3 || len > 24) return null;
  if (!NAME_RE.test(s) || /\s{2,}/.test(s)) return null;
  return s;
}

/**
 * Esqueleto para unicidade. Mesmo algoritmo do backfill em
 * migrations/002_hardening.sql — mudar os dois juntos.
 */
export function displayNameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[ ._-]/g, '')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/0/g, 'o')
    .replace(/[1i]/g, 'l')
    .replace(/5/g, 's');
}
