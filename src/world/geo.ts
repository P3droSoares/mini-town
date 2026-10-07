/**
 * Utilidades geométricas 2D puras (sem Three.js).
 * Compartilhadas entre o pré-processamento (Node) e o jogo (browser).
 */
import type { Ring, Vec2 } from '../data/types';

export const EARTH_M_PER_DEG_LAT = 110_574;
export const EARTH_M_PER_DEG_LON_EQ = 111_320;

/** Projeção equiretangular simples a partir de uma origem. */
export class LocalProjection {
  private readonly kx: number;
  private readonly kz: number;
  constructor(public readonly lat0: number, public readonly lon0: number) {
    this.kx = EARTH_M_PER_DEG_LON_EQ * Math.cos((lat0 * Math.PI) / 180);
    this.kz = EARTH_M_PER_DEG_LAT;
  }
  /** lat/lon -> [x leste, z sul] em metros */
  toLocal(lat: number, lon: number): Vec2 {
    return [(lon - this.lon0) * this.kx, -(lat - this.lat0) * this.kz];
  }
  toLatLon(x: number, z: number): { lat: number; lon: number } {
    return { lat: this.lat0 - z / this.kz, lon: this.lon0 + x / this.kx };
  }
}

/** Área com sinal (shoelace). Positiva = anti-horária no plano x/z. */
export function signedArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, z1] = ring[i];
    const [x2, z2] = ring[(i + 1) % n];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

export function polygonArea(ring: Ring): number {
  return Math.abs(signedArea(ring));
}

export function centroid(ring: Ring): Vec2 {
  let cx = 0;
  let cz = 0;
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, z1] = ring[i];
    const [x2, z2] = ring[(i + 1) % n];
    const f = x1 * z2 - x2 * z1;
    cx += (x1 + x2) * f;
    cz += (z1 + z2) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-9) {
    // polígono degenerado: média simples
    const m = ring.reduce((s, p) => [s[0] + p[0], s[1] + p[1]] as Vec2, [0, 0] as Vec2);
    return [m[0] / ring.length, m[1] / ring.length];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function pointInRing(x: number, z: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(x: number, z: number, outer: Ring, holes?: Ring[]): boolean {
  if (!pointInRing(x, z, outer)) return false;
  if (holes) for (const h of holes) if (pointInRing(x, z, h)) return false;
  return true;
}

export function ringBounds(ring: Ring) {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minZ, maxX, maxZ };
}

/** Distância ao quadrado de p ao segmento ab, e o parâmetro t do ponto mais próximo. */
export function distSqToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t;
  const cz = az + dz * t;
  const ex = px - cx;
  const ez = pz - cz;
  return { d2: ex * ex + ez * ez, t, cx, cz };
}

export function polylineLength(points: Vec2[]): number {
  let l = 0;
  for (let i = 1; i < points.length; i++) {
    l += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return l;
}

/** Gerador pseudo-aleatório determinístico (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash inteiro estável para seeds (funciona com ids OSM > 2^32). */
export function hashId(id: number): number {
  let h = 2166136261 >>> 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Remove acentos e baixa caixa — usado na busca de ruas. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Simplificação Douglas-Peucker para anéis/polilinhas. */
export function simplify(points: Vec2[], tolerance: number): Vec2[] {
  if (points.length <= 3) return points;
  const tol2 = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const { d2 } = distSqToSegment(points[i][0], points[i][1], points[s][0], points[s][1], points[e][0], points[e][1]);
      if (d2 > maxD) {
        maxD = d2;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tol2) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
