/**
 * Confiança em proxy reverso para o IP do cliente (X-Forwarded-For).
 *
 * Só um par imediato da lista (endereço exato ou CIDR, ex.: o IP fixo do
 * Caddy) pode informar o IP de origem. Quem conecta direto no server (outro
 * container, máquina da LAN) fica com o próprio endereço do socket: o
 * X-Forwarded-For dele é ignorado, e os limites por IP/rede valem.
 */
import { BlockList, isIP } from 'node:net';

/** Valida e normaliza uma lista "ip, ip/prefixo, ..." (vazia = ninguém). */
export function parseTrustedProxies(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const s = part.trim();
    if (!s) continue;
    const [addr = '', prefix, extra] = s.split('/');
    const fam = isIP(addr);
    if (!fam || extra !== undefined) throw new Error(`endereço de proxy inválido: ${s}`);
    if (prefix !== undefined) {
      const n = Number(prefix);
      if (!/^\d{1,3}$/.test(prefix) || n > (fam === 4 ? 32 : 128)) throw new Error(`prefixo inválido: ${s}`);
    }
    out.push(s);
  }
  return out;
}

/** "::ffff:10.0.0.2" (socket IPv6 dual-stack) = "10.0.0.2". */
function plainAddr(addr: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  return m ? m[1]! : addr;
}

/**
 * Função `trustProxy` do Fastify (proxy-addr): `hop` 0 é o socket, 1.. são os
 * X-Forwarded-For da direita para a esquerda. Confia no salto só se estiver
 * dentro de `hops` E o endereço for de um proxy da lista; o primeiro salto
 * não confiável é o IP do cliente.
 */
export function proxyTrust(hops: number, trusted: readonly string[]): (addr: string, hop: number) => boolean {
  if (hops <= 0 || trusted.length === 0) return () => false;
  const list = new BlockList();
  for (const t of trusted) {
    const [addr = '', prefix] = t.split('/');
    const type = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(addr, type);
    else list.addSubnet(addr, Number(prefix), type);
  }
  return (addr, hop) => {
    if (hop >= hops) return false;
    const a = plainAddr(addr);
    const fam = isIP(a);
    return fam !== 0 && list.check(a, fam === 6 ? 'ipv6' : 'ipv4');
  };
}
