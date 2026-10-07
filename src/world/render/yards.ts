import * as THREE from 'three';
import type { Building, Lot, Vec2 } from '../../data/types';
import type { HeightField } from '../HeightField';
import { hashId, mulberry32 } from '../geo';
import type { GeometryWriter } from './GeometryWriter';
import { writeDrapedPolygon } from './areaGeometry';
import { Layer } from './textures';

/**
 * Quintal do lote (padrão brasileiro): muro alto nas divisas e fundos,
 * mureta + portão na frente, chão de grama ou piso cerâmico e, em parte
 * dos lotes, piscina nos fundos.
 */
export interface YardWriters {
  /** chão gramado (material de chão) */
  grass: GeometryWriter;
  /** muros e piso (material de prédios, com atlas) */
  detail: GeometryWriter;
  /** água das piscinas */
  pool: GeometryWriter;
}

const MURO = ['#efe9df', '#e4ddd0', '#d9d6cf', '#f1e7d0', '#e9d7c3', '#d7dccf', '#c9c4ba'].map((h) => new THREE.Color(h));
const GATE = new THREE.Color('#2f3338');
const GRASS = new THREE.Color('#6f8f4e');
const PATIO = new THREE.Color('#d9cbb5');
const BORDER = new THREE.Color('#ece6da');
const WATER = new THREE.Color('#ffffff');
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** índice da aresta do lote voltada para a rua (menor distância) */
export function frontEdgeOf(ring: Vec2[], distanceToStreet: (x: number, z: number) => number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const d = distanceToStreet((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** muro entre a e b (duas faces + topo), seguindo o relevo */
function wall(w: GeometryWriter, hf: HeightField, a: Vec2, b: Vec2, h: number, c: THREE.Color, gapFrom = -1, gapTo = -1) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 0.3) return;
  const dx = (b[0] - a[0]) / len;
  const dz = (b[1] - a[1]) / len;
  const t = 0.14;
  const ox = dz * t * 0.5;
  const oz = -dx * t * 0.5;
  const segs = Math.max(1, Math.ceil(len / 4));
  for (let i = 0; i < segs; i++) {
    const s0 = (i / segs) * len;
    const s1 = ((i + 1) / segs) * len;
    if (gapFrom >= 0 && s1 > gapFrom && s0 < gapTo) continue;
    const P = (s: number, side: number, up: number) => {
      const x = a[0] + dx * s + ox * side;
      const z = a[1] + dz * s + oz * side;
      return V(x, hf.sample(x, z) - 0.3 + up, z);
    };
    const yTop = (s: number) => hf.sample(a[0] + dx * s, a[1] + dz * s) + h;
    const top = (s: number, side: number) => P(s, side, 0).setY(yTop(s));
    w.quad(P(s0, 1, 0), P(s1, 1, 0), top(s1, 1), top(s0, 1), c, V(dz, 0, -dx), [s0, 0, s1, 0, s1, h, s0, h]);
    w.quad(P(s0, -1, 0), P(s1, -1, 0), top(s1, -1), top(s0, -1), c, V(-dz, 0, dx), [s0, 0, s1, 0, s1, h, s0, h]);
    w.quad(top(s0, 1), top(s1, 1), top(s1, -1).setY(yTop(s1) + 0.001), top(s0, -1), BORDER, V(0, 1, 0));
  }
}

export function writeYard(ws: YardWriters, lot: Lot, building: Building | undefined, hf: HeightField, distanceToStreet: (x: number, z: number) => number) {
  const ring = lot.outer!;
  if (ring.length !== 4) return;
  const rng = mulberry32(hashId(lot.lotId.length * 131 + lot.area * 7));
  const fi = frontEdgeOf(ring, distanceToStreet);
  const fa = ring[fi];
  const fb = ring[(fi + 1) % 4];
  const back0 = ring[(fi + 2) % 4];
  const back1 = ring[(fi + 3) % 4];

  // chão do quintal
  const patio = rng() < 0.4;
  if (patio) {
    ws.detail.layer = Layer.patio;
    writeDrapedPolygon(ws.detail, ring, undefined, hf, PATIO, 0.07);
    ws.detail.layer = -1;
  } else writeDrapedPolygon(ws.grass, ring, undefined, hf, GRASS, 0.07);

  // muros: divisas e fundos altos; frente com mureta e portão
  const muro = MURO[Math.floor(rng() * MURO.length)];
  ws.detail.layer = Layer.plaster;
  const flen = Math.hypot(fb[0] - fa[0], fb[1] - fa[1]);
  const gateAt = flen * (0.2 + rng() * 0.5);
  wall(ws.detail, hf, fa, fb, 1.0, muro, gateAt, gateAt + 2.8);
  wall(ws.detail, hf, fb, back0, 1.9, muro);
  wall(ws.detail, hf, back0, back1, 1.9, muro);
  wall(ws.detail, hf, back1, fa, 1.9, muro);
  ws.detail.layer = -1;
  // portão (grade escura)
  {
    const dx = (fb[0] - fa[0]) / flen;
    const dz = (fb[1] - fa[1]) / flen;
    const gx = fa[0] + dx * (gateAt + 1.4);
    const gz = fa[1] + dz * (gateAt + 1.4);
    const gy = hf.sample(gx, gz);
    ws.detail.box(gx, gz, gy - 0.2, gy + 1.7, dx, dz, 1.4, 0.04, GATE);
  }

  // piscina nos fundos (lotes com quintal grande)
  if (!building || rng() > 0.28) return;
  const ux = (fb[0] - fa[0]) / flen;
  const uz = (fb[1] - fa[1]) / flen;
  // eixo de profundidade (da frente para os fundos)
  let nx = -uz;
  let nz = ux;
  const mid = [(back0[0] + back1[0]) / 2, (back0[1] + back1[1]) / 2];
  if ((mid[0] - fa[0]) * nx + (mid[1] - fa[1]) * nz < 0) {
    nx = -nx;
    nz = -nz;
  }
  const lotDepth = (mid[0] - fa[0]) * nx + (mid[1] - fa[1]) * nz;
  const houseBack = Math.max(...building.outer.map(([x, z]) => (x - fa[0]) * nx + (z - fa[1]) * nz));
  const yard = lotDepth - houseBack;
  if (yard < 5.5) return;
  const pl = Math.min(yard - 2.2, 7);
  const pw = Math.min(flen - 2.4, 4);
  if (pl < 2.5 || pw < 2) return;
  const cd = houseBack + 1.1 + pl / 2 + (yard - pl - 2.2) / 2;
  const cu = flen / 2;
  const cx = fa[0] + ux * cu + nx * cd;
  const cz = fa[1] + uz * cu + nz * cd;
  const y = hf.sample(cx, cz) + 0.12;
  // borda + água (ligeiramente abaixo)
  ws.detail.box(cx, cz, y - 0.3, y, nx, nz, pl / 2 + 0.6, pw / 2 + 0.6, BORDER);
  const P = (a: number, b: number) => V(cx + nx * a + ux * b, y + 0.012, cz + nz * a + uz * b);
  ws.pool.quad(P(-pl / 2, -pw / 2), P(pl / 2, -pw / 2), P(pl / 2, pw / 2), P(-pl / 2, pw / 2), WATER, V(0, 1, 0));
}
