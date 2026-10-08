/**
 * Primitivas criptográficas: tokens de sessão, CSRF, HMAC de IP/e-mail e
 * cifragem do e-mail em repouso (AES-256-GCM com versão de chave).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256 = (data: Buffer | string): Buffer => createHash('sha256').update(data).digest();

export const hmac = (key: Buffer, data: Buffer | string): Buffer => createHmac('sha256', key).update(data).digest();

/** Comparação em tempo constante (tamanhos diferentes = falso, sem curto-circuito por conteúdo). */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Token de sessão: 32 bytes aleatórios em base64url (vai só no cookie). */
export function newSessionToken(): { token: string; hash: Buffer } {
  const raw = randomBytes(32);
  const token = raw.toString('base64url');
  return { token, hash: sha256(token) };
}

/** Formato aceito para o token vindo do cookie (43 chars base64url). */
export const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Token CSRF = HMAC(CSRF_KEY, id da sessão). */
export function csrfTokenFor(csrfKey: Buffer, sessionId: string): string {
  return hmac(csrfKey, `csrf:v1:${sessionId}`).toString('base64url');
}

export function csrfMatches(csrfKey: Buffer, sessionId: string, presented: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(presented)) return false;
  return safeEqual(Buffer.from(csrfTokenFor(csrfKey, sessionId)), Buffer.from(presented));
}

/** Normalização do e-mail antes de hash/cifra. */
export const normalizeEmail = (email: string): string => email.normalize('NFKC').trim().toLowerCase();

export const emailHash = (key: Buffer, email: string): Buffer => hmac(key, `email:v1:${normalizeEmail(email)}`);

/** IP pseudonimizado para logs/auditoria/limites (nunca em claro no banco). */
export const ipHmac = (key: Buffer, ip: string): Buffer => hmac(key, `ip:v1:${canonicalIp(ip)}`);

/** IPv4 mapeado em IPv6 (::ffff:a.b.c.d) vira IPv4; IPv6 em minúsculas. */
function canonicalIp(ip: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m ? m[1]! : ip.toLowerCase();
}

/** Expande um IPv6 em 8 grupos de 16 bits (null se não for IPv6 válido). */
function ipv6Groups(ip: string): number[] | null {
  const s = ip.split('%')[0]!.toLowerCase();
  if (!s.includes(':')) return null;
  let head = s;
  // sufixo IPv4 embutido (ex.: 64:ff9b::1.2.3.4)
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const b = v4.slice(1).map(Number);
    head = s.slice(0, s.length - v4[0].length) + `${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const parts = head.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const missing = 8 - left.length - tail.length;
  if (parts.length === 1 ? left.length !== 8 : missing < 1) return null;
  const all = [...left, ...Array<string>(parts.length === 2 ? missing : 0).fill('0'), ...tail];
  const nums = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

/**
 * Rede de origem: IPv4 exato; IPv6 agrupado no /64 (um cliente controla o
 * /64 inteiro — limitar por endereço seria inútil).
 */
export function ipNetwork(ip: string): string {
  const c = canonicalIp(ip);
  const g = ipv6Groups(c);
  if (!g) return c;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

export const netHmac = (key: Buffer, ip: string): Buffer => hmac(key, `net:v1:${ipNetwork(ip)}`);

/**
 * Cookie de "dispositivo conhecido": id aleatório + HMAC(id, conta). Emitido
 * após login com sucesso; com ele, o bloqueio por força bruta da conta usa um
 * contador próprio (o atacante não consegue travar o login da vítima).
 */
export function newDeviceToken(key: Buffer, accountKey: Buffer): string {
  const id = randomBytes(16).toString('base64url');
  return `${id}.${hmac(key, `dev:v1:${id}:${accountKey.toString('hex')}`).toString('base64url')}`;
}

/** Id do dispositivo se o cookie for válido para esta conta; senão null. */
export function deviceIdFor(key: Buffer, accountKey: Buffer, token: string | undefined): string | null {
  if (!token || !/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [id, mac] = token.split('.') as [string, string];
  const want = hmac(key, `dev:v1:${id}:${accountKey.toString('hex')}`).toString('base64url');
  return safeEqual(Buffer.from(want), Buffer.from(mac)) ? id : null;
}

const IV_LEN = 12;
const TAG_LEN = 16;

/** versão(1) || iv(12) || tag(16) || cifrado; a versão vai também no AAD. */
export function encryptEmail(key: Buffer, version: number, email: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const header = Buffer.from([version]);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  cipher.setAAD(header);
  const ct = Buffer.concat([cipher.update(normalizeEmail(email), 'utf8'), cipher.final()]);
  return Buffer.concat([header, iv, cipher.getAuthTag(), ct]);
}

export function decryptEmail(keys: ReadonlyMap<number, Buffer>, blob: Buffer): string {
  const version = blob[0];
  const key = version === undefined ? undefined : keys.get(version);
  if (!key) throw new Error('versão de chave de e-mail desconhecida');
  const iv = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ct = blob.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  decipher.setAAD(blob.subarray(0, 1));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
