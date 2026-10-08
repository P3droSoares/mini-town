/**
 * Senhas: argon2id (m=19456 KiB, t=2, p=1), pepper versionado via HMAC e
 * checagem contra lista local de senhas comuns.
 *
 * Formato gravado: `p<versão>$<hash argon2>` (`p0$` = sem pepper). Hash antigo
 * sem prefixo = pepper atual (como era antes) e é regravado no próximo login.
 */
import { hash, verify } from '@node-rs/argon2';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hmac } from './crypto.js';

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

const ARGON_OPTS = {
  // Algorithm.Argon2id (const enum não pode ser importado com verbatimModuleSyntax)
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/** Peppers conhecidos (ver AppConfig). */
export interface Peppers {
  passwordPepper: Buffer | null;
  passwordPepperVersion: number;
  passwordPeppers: ReadonlyMap<number, Buffer>;
}

const COMMON = new Set(
  readFileSync(fileURLToPath(new URL('./common-passwords.txt', import.meta.url)), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith('#')),
);

const PREFIX_RE = /^p(\d{1,3})\$/;

/** Senha pré-processada: com pepper vira HMAC (base64), sem pepper fica igual. */
function prepare(password: string, pepper: Buffer | null): string {
  return pepper ? hmac(pepper, password.normalize('NFKC')).toString('base64') : password.normalize('NFKC');
}

/** Versão do pepper gravada no hash (0 = sem pepper; null = formato antigo sem prefixo). */
export function pepperVersionOf(stored: string): number | null {
  const m = PREFIX_RE.exec(stored);
  return m ? Number(m[1]) : null;
}

export async function hashPassword(password: string, p: Peppers): Promise<string> {
  const v = p.passwordPepper ? p.passwordPepperVersion : 0;
  return `p${v}$${await hash(prepare(password, p.passwordPepper), ARGON_OPTS)}`;
}

export async function verifyPassword(stored: string, password: string, p: Peppers): Promise<boolean> {
  const v = pepperVersionOf(stored);
  let pepper: Buffer | null;
  let argon = stored;
  if (v === null) {
    pepper = p.passwordPepper;
  } else {
    argon = stored.slice(stored.indexOf('$') + 1);
    pepper = v === 0 ? null : (p.passwordPeppers.get(v) ?? null);
    // pepper desconhecido: nunca confere (o boot já recusa esse estado)
    if (v !== 0 && !pepper) return false;
  }
  try {
    return await verify(argon, prepare(password, pepper));
  } catch {
    return false;
  }
}

/** O hash precisa ser regravado (formato antigo ou pepper que não é o atual)? */
export function needsRehash(stored: string, p: Peppers): boolean {
  const v = pepperVersionOf(stored);
  return v !== (p.passwordPepper ? p.passwordPepperVersion : 0);
}

// hash fictício: login de conta inexistente gasta o mesmo tempo de CPU
let dummyHash: Promise<string> | null = null;
export async function burnPasswordTime(password: string, p: Peppers): Promise<void> {
  dummyHash ??= hash('senha-ficticia-para-tempo-constante', ARGON_OPTS);
  await verifyPassword(await dummyHash, password, p);
}

/**
 * Regras de força. Retorna mensagem pt-BR do problema ou null se ok.
 * `context` = outros dados do usuário que não podem compor a senha.
 */
export function passwordProblem(password: string, context: string[] = []): string | null {
  // normaliza como em prepare()/verifyPassword: a força é medida na MESMA string que
  // será guardada/verificada (senão "ｐａｓｓｗｏｒｄ１２３" fura a lista de senhas comuns,
  // mas o hash gravado é o de "password123"). CWE-180: validar antes de canonizar.
  const normalized = password.normalize('NFKC');
  const len = [...normalized].length;
  if (len < PASSWORD_MIN) return `A senha precisa ter pelo menos ${PASSWORD_MIN} caracteres.`;
  if (len > PASSWORD_MAX) return `A senha pode ter no máximo ${PASSWORD_MAX} caracteres.`;
  const lower = normalized.toLowerCase();
  if (COMMON.has(lower)) return 'Essa senha é muito comum. Escolha outra.';
  if (new Set(lower).size < 4) return 'A senha tem pouca variedade de caracteres.';
  for (const c of context) {
    const v = c.toLowerCase().trim();
    if (v.length >= 3 && lower.includes(v)) return 'A senha não pode conter seu nome ou e-mail.';
  }
  return null;
}
