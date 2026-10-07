import * as THREE from 'three';
import type { Building, BuildingCategory, Ring, Vec2 } from '../../data/types';
import type { HeightField } from '../HeightField';
import { hashId, mulberry32, polygonArea } from '../geo';
import { GeometryWriter, UP } from './GeometryWriter';
import type { SignAtlas } from './signAtlas';
import { Layer } from './textures';

/**
 * Kit de prédios realistas por ARQUÉTIPO. Cada categoria (residencial,
 * comercial, industrial...) tem vários tipos, e cada tipo varia material
 * (atlas PBR), cor, telhado, número de vãos e peças (toldos, sacadas,
 * letreiros, outdoors, platibandas, casas de máquinas, chaminés...).
 *
 * As janelas são desenhadas no shader com o MESMO layout de vãos usado aqui
 * para posicionar as peças. Tudo determinístico pela seed do lote.
 */

export type Detail = 'high' | 'low';

/** paredes (com fachada), peças e letreiros */
export interface BuildingWriters {
  walls: GeometryWriter;
  detail: GeometryWriter;
  signs: GeometryWriter;
  /** molduras de janela (instanciadas por chunk, só perto da câmera) */
  windows: WindowInstance[];
}

/** moldura de janela: centro na parede, orientação, tamanho e cor */
export interface WindowInstance {
  x: number;
  y: number;
  z: number;
  /** ângulo (rad) da normal externa no plano xz */
  yaw: number;
  w: number;
  h: number;
  color: THREE.Color;
}
export const WRITER_KEYS = ['walls', 'detail', 'signs'] as const;
export type WriterKey = (typeof WRITER_KEYS)[number];

export function createWriters(): BuildingWriters {
  return { walls: new GeometryWriter(), detail: new GeometryWriter(), signs: new GeometryWriter(), windows: [] };
}

/** Teste "esta parede dá para a rua?" (ponto médio + normal externa) */
export type FrontTest = (mx: number, mz: number, ox: number, oz: number) => boolean;

/** estilos de fachada (iguais no shader) */
export const FacadeStyle = {
  house: 0,
  commercial: 1,
  apartment: 2,
  industrial: 3,
  plain: 4,
  institutional: 5,
  office: 6,
  modern: 7,
  brick: 8,
  slab: 9,
} as const;
/** largura do vão por estilo (iguais no shader) */
export const BAY: Record<number, number> = { 0: 2.6, 1: 2.6, 2: 3.0, 3: 4.0, 4: 3.0, 5: 3.2, 6: 1.6, 7: 4.0, 8: 2.4, 9: 3.0 };
export const FLOOR_H = 3.0;

/** arquétipos (exibidos no painel) */
export type Archetype =
  | 'colonial'
  | 'casa-moderna'
  | 'sobrado-tijolo'
  | 'casa-simples'
  | 'predio-baixo'
  | 'bloco-bnh'
  | 'torre-tijolo'
  | 'torre-moderna'
  | 'loja-tijolo'
  | 'loja-reboco'
  | 'supermercado'
  | 'escritorios'
  | 'galpao-metalico'
  | 'fabrica-tijolo'
  | 'institucional'
  | 'igreja';

export const ARCHETYPE_LABEL: Record<Archetype, string> = {
  colonial: 'Casa colonial mineira',
  'casa-moderna': 'Casa moderna',
  'sobrado-tijolo': 'Sobrado de tijolo',
  'casa-simples': 'Casa térrea',
  'predio-baixo': 'Prédio residencial baixo',
  'bloco-bnh': 'Bloco de apartamentos',
  'torre-tijolo': 'Edifício de tijolo',
  'torre-moderna': 'Edifício moderno',
  'loja-tijolo': 'Sobrado comercial de tijolo',
  'loja-reboco': 'Loja de rua',
  supermercado: 'Supermercado / loja grande',
  escritorios: 'Edifício de escritórios',
  'galpao-metalico': 'Galpão metálico',
  'fabrica-tijolo': 'Fábrica de tijolo',
  institucional: 'Prédio público',
  igreja: 'Igreja',
};

// ------------------------------------------------------------------ paletas

const C = (h: string) => new THREE.Color(h);
const PAL = {
  colonial: ['#e6dccb', '#dccb9e', '#d2c08e', '#cfd3cf', '#bfc9c9', '#dbc4b6', '#ebe4d6', '#d6bd8c', '#c9b28f', '#cbd0bd', '#b9a58a', '#d8d2c2'].map(C),
  modern: ['#f5f5f2', '#e6e6e3', '#d5d6d6', '#efe9df', '#c9cbcc', '#3d4045'].map(C),
  plasterShop: ['#e3ddd2', '#d4d0c8', '#ddd0b0', '#c9d1d4', '#d8c4b4', '#cbd3c4', '#e0c4ae', '#bfb7a8'].map(C),
  slab: ['#efebe3', '#e6e2d8', '#ddd9cf', '#f2efe8', '#e9e2d0'].map(C),
  towerGrey: ['#c9ccd0', '#b7bcc2', '#d6d3cc', '#a9afb5', '#e1ddd5'].map(C),
  institutional: ['#f4efe6', '#eef2f6', '#f6eadf', '#e8e4dc'].map(C),
  industrial: ['#d9dde1', '#c4ccd3', '#e1e4e6', '#b8c2ca', '#d6d0c4', '#9fb0bd'].map(C),
  trims: ['#2f5d8a', '#2e6b4f', '#c9961e', '#6b3f24', '#8e2f2a', '#3c4f6b', '#f4f1ea', '#1f4a5e'].map(C),
  awnings: ['#c62828', '#1565c0', '#2e7d32', '#ef6c00', '#263238', '#6a1b9a', '#00838f'].map(C),
  natural: ['#ffffff', '#f2eee8', '#e8e4de', '#fff8ef', '#e9edf0'].map(C),
  white: C('#f4f2ec'),
  glassRail: C('#a7c4d4'),
  dark: C('#33373c'),
  metal: C('#8f979e'),
  steel: C('#b9c0c6'),
  tank: C('#3f78a8'),
  church: C('#fbfaf5'),
  churchTrim: C('#3f6d8f'),
  chimneyRed: C('#b5432f'),
  hedge: C('#4f7a3a'),
};
const pick = <T>(arr: T[], r: number) => arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];

// ---------------------------------------------------------------- geometria

interface OrientedRect {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  hl: number;
  hw: number;
}

function convexHull(points: Vec2[]): Vec2[] {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Retângulo de área mínima (rotating calipers simplificado). */
export function minAreaRect(ring: Ring): OrientedRect {
  const hull = convexHull(ring);
  let best: OrientedRect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const ux = (b[0] - a[0]) / len;
    const uz = (b[1] - a[1]) / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uz;
      const v = -p[0] * uz + p[1] * ux;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      let r: OrientedRect = { cx: cu * ux - cv * uz, cz: cu * uz + cv * ux, ux, uz, hl: (maxU - minU) / 2, hw: (maxV - minV) / 2 };
      if (r.hw > r.hl) r = { ...r, ux: -uz, uz: ux, hl: r.hw, hw: r.hl };
      best = r;
    }
  }
  return best!;
}

/** Altura do solo sob o prédio (mín e máx nos vértices). */
export function groundRange(b: Building, hf: HeightField) {
  let gMin = Infinity;
  let gMax = -Infinity;
  for (const [x, z] of b.outer) {
    const h = hf.sample(x, z);
    if (h < gMin) gMin = h;
    if (h > gMax) gMax = h;
  }
  const hc = hf.sample(b.centroid[0], b.centroid[1]);
  return { gMin: Math.min(gMin, hc), gMax: Math.max(gMax, hc) };
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** categoria (dados antigos sem `category` caem no tipo) */
export function categoryOf(b: Building): BuildingCategory {
  if (b.category) return b.category;
  if (['church', 'cathedral', 'chapel'].includes(b.type)) return 'religious';
  if (['industrial', 'warehouse'].includes(b.type)) return 'industrial';
  if (b.type === 'commercial' || b.type === 'retail' || b.pois?.length) return 'commercial';
  return 'residential';
}

interface Ctx {
  w: BuildingWriters;
  rng: () => number;
  gMax: number;
  topV: number;
  seed: number;
  trim: THREE.Color;
  style: number;
}

interface WallLayout {
  a: Vec2;
  b: Vec2;
  len: number;
  bays: number;
  margin: number;
  ox: number;
  oz: number;
  front: boolean;
}

function orientCCW(ring: Vec2[]): Vec2[] {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a > 0 ? ring : ring.slice().reverse();
}

/** retângulo orientado (opcionalmente chanfrado) como anel CCW */
function boxRing(r: OrientedRect, c = 0, hl = r.hl, hw = r.hw, offU = 0, offV = 0): Vec2[] {
  const vx = -r.uz;
  const vz = r.ux;
  const pts: [number, number][] = c
    ? [
        [-hl + c, -hw],
        [hl - c, -hw],
        [hl, -hw + c],
        [hl, hw - c],
        [hl - c, hw],
        [-hl + c, hw],
        [-hl, hw - c],
        [-hl, -hw + c],
      ]
    : [
        [-hl, -hw],
        [hl, -hw],
        [hl, hw],
        [-hl, hw],
      ];
  return orientCCW(pts.map(([su, sv]) => [r.cx + r.ux * (su + offU) + vx * (sv + offV), r.cz + r.uz * (su + offU) + vz * (sv + offV)] as Vec2));
}

/** paredes de um anel com fachada; `front(i, l)` decide a parede da frente */
function writeWalls(ctx: Ctx, ring: Vec2[], y0: number, y1: number, color: THREE.Color, layer: number, front: (l: WallLayout) => boolean, windows = true): WallLayout[] {
  const out: WallLayout[] = [];
  const w = ctx.w.walls;
  const bay = BAY[ctx.style];
  w.layer = layer;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    const ox = (b[1] - a[1]) / len;
    const oz = -(b[0] - a[0]) / len;
    const bays = windows && len >= bay * 0.85 ? Math.max(1, Math.floor(len / bay)) : 0;
    const margin = (len - bays * bay) / 2;
    const l: WallLayout = { a, b, len, bays, margin, ox, oz, front: false };
    l.front = front(l);
    w.style = [ctx.trim.r, ctx.trim.g, ctx.trim.b, ctx.style * 2 + (l.front ? 1 : 0)];
    w.wall = [len, margin, bays, 0];
    const s = bays > 0 ? ctx.seed : 0;
    const vb = y0 - ctx.gMax;
    w.quad(
      V(a[0], y0, a[1]),
      V(b[0], y0, b[1]),
      V(b[0], y1, b[1]),
      V(a[0], y1, a[1]),
      color,
      V(ox, 0, oz),
      [0, y0, len, y0, len, y1, 0, y1],
      [0, vb, ctx.topV, s, len, vb, ctx.topV, s, len, y1 - ctx.gMax, ctx.topV, s, 0, y1 - ctx.gMax, ctx.topV, s],
    );
    out.push(l);
  }
  w.wall = [0, 0, 0, 0];
  w.layer = -1;
  return out;
}

function cap(w: GeometryWriter, ring: Vec2[], y: number, c: THREE.Color, layer: number, holes?: Ring[]) {
  w.layer = layer;
  const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
  const hs = (holes ?? []).map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
  const tris = THREE.ShapeUtils.triangulateShape(contour, hs);
  const all = contour.concat(...hs);
  for (const [i0, i1, i2] of tris) {
    const p0 = all[i0];
    const p1 = all[i1];
    const p2 = all[i2];
    w.tri(V(p0.x, y, p0.y), V(p1.x, y, p1.y), V(p2.x, y, p2.y), c, UP);
  }
  w.layer = -1;
}

function norm2(x: number, z: number): [number, number] {
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
}

/** faixa saliente (laje/cornija) */
function band(w: GeometryWriter, ring: Vec2[], y0: number, y1: number, out: number, c: THREE.Color, layer = -1) {
  const n = ring.length;
  w.layer = layer;
  const off: Vec2[] = ring.map((p, i) => {
    const prev = ring[(i - 1 + n) % n];
    const next = ring[(i + 1) % n];
    const e1 = norm2(p[0] - prev[0], p[1] - prev[1]);
    const e2 = norm2(next[0] - p[0], next[1] - p[1]);
    let nx = e1[1] + e2[1];
    let nz = -e1[0] - e2[0];
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    const k = 1 / Math.max(0.4, nx * e2[1] - nz * e2[0]);
    return [p[0] + nx * out * k, p[1] + nz * out * k];
  });
  for (let i = 0; i < n; i++) {
    const a = off[i];
    const b = off[(i + 1) % n];
    const ra = ring[i];
    const rb = ring[(i + 1) % n];
    const o = V(b[1] - a[1], 0, -(b[0] - a[0]));
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    w.quad(V(a[0], y0, a[1]), V(b[0], y0, b[1]), V(b[0], y1, b[1]), V(a[0], y1, a[1]), c, o, [0, y0, len, y0, len, y1, 0, y1]);
    w.quad(V(ra[0], y0, ra[1]), V(rb[0], y0, rb[1]), V(b[0], y0, b[1]), V(a[0], y0, a[1]), c, V(0, -1, 0));
    w.quad(V(ra[0], y1, ra[1]), V(rb[0], y1, rb[1]), V(b[0], y1, b[1]), V(a[0], y1, a[1]), c, UP);
  }
  w.layer = -1;
}

/** platibanda (parapeito) em volta da laje */
function parapet(w: GeometryWriter, ring: Vec2[], y: number, h: number, c: THREE.Color, layer: number) {
  const n = ring.length;
  const t = 0.2;
  w.layer = layer;
  let u = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    const ox = (b[1] - a[1]) / len;
    const oz = -(b[0] - a[0]) / len;
    const uv = [u, y, u + len, y, u + len, y + h, u, y + h];
    w.quad(V(a[0], y, a[1]), V(b[0], y, b[1]), V(b[0], y + h, b[1]), V(a[0], y + h, a[1]), c, V(ox, 0, oz), uv);
    const ai = [a[0] - ox * t, a[1] - oz * t];
    const bi = [b[0] - ox * t, b[1] - oz * t];
    w.quad(V(ai[0], y, ai[1]), V(bi[0], y, bi[1]), V(bi[0], y + h, bi[1]), V(ai[0], y + h, ai[1]), c, V(-ox, 0, -oz), uv);
    w.quad(V(a[0], y + h, a[1]), V(b[0], y + h, b[1]), V(bi[0], y + h, bi[1]), V(ai[0], y + h, ai[1]), PAL.white, UP);
    u += len;
  }
  w.layer = -1;
}

function cylinder(w: GeometryWriter, x: number, z: number, y0: number, y1: number, r: number, c: THREE.Color, seg = 10, topC?: THREE.Color) {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const p0 = V(x + Math.cos(a0) * r, y0, z + Math.sin(a0) * r);
    const p1 = V(x + Math.cos(a1) * r, y0, z + Math.sin(a1) * r);
    const out = V(Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2));
    w.quad(p0, p1, p1.clone().setY(y1), p0.clone().setY(y1), c, out);
    w.tri(V(x, y1, z), p1.clone().setY(y1), p0.clone().setY(y1), topC ?? c, UP);
  }
}

/** triângulo de telhado com UV alinhado à inclinação (fiadas horizontais) */
function roofTri(w: GeometryWriter, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, col: THREE.Color, facing: THREE.Vector3) {
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
  if (n.dot(facing) < 0) n.negate();
  const e = new THREE.Vector3(0, 1, 0).cross(n);
  if (e.lengthSq() < 1e-6) e.set(1, 0, 0);
  e.normalize();
  const s = n.clone().cross(e).normalize();
  const uv = (p: THREE.Vector3) => [p.dot(e), -p.dot(s)];
  w.tri(a, b, c, col, facing, [...uv(a), ...uv(b), ...uv(c)]);
}

// ----------------------------------------------------------------- telhados

function pitchedRoof(w: GeometryWriter, r: OrientedRect, top: number, roofC: THREE.Color, wallC: THREE.Color, wallLayer: number, roofLayer: number, hip: boolean, pitch = 0.5, eaves = true) {
  const o = eaves ? 0.5 : 0.1;
  const { cx, cz, ux, uz } = r;
  const vxx = -uz;
  const vzz = ux;
  const L = r.hl;
  const W = r.hw;
  const h = Math.min(W * pitch, 6);
  const P = (su: number, sv: number, y: number) => V(cx + ux * su + vxx * sv, y, cz + uz * su + vzz * sv);
  const yb = top - o * (h / W);
  const A = P(-(L + o), -(W + o), yb);
  const B = P(L + o, -(W + o), yb);
  const Cc = P(L + o, W + o, yb);
  const D = P(-(L + o), W + o, yb);
  const center = V(cx, top, cz);
  const facing = (pts: THREE.Vector3[]) => {
    const m = V(0, 0, 0);
    pts.forEach((p) => m.add(p));
    return m.divideScalar(pts.length).sub(center).normalize().add(V(0, 0.3, 0));
  };
  w.layer = roofLayer;
  if (hip) {
    const rl = Math.max(0, L - W);
    const R1 = P(-rl, 0, top + h);
    const R2 = P(rl, 0, top + h);
    const f1 = facing([A, B, R2, R1]);
    roofTri(w, A, B, R2, roofC, f1);
    roofTri(w, A, R2, R1, roofC, f1);
    const f2 = facing([Cc, D, R1, R2]);
    roofTri(w, Cc, D, R1, roofC, f2);
    roofTri(w, Cc, R1, R2, roofC, f2);
    roofTri(w, B, Cc, R2, roofC, facing([B, Cc, R2]));
    roofTri(w, D, A, R1, roofC, facing([D, A, R1]));
  } else {
    const R1 = P(-(L + o), 0, top + h);
    const R2 = P(L + o, 0, top + h);
    const f1 = facing([A, B, R2, R1]);
    roofTri(w, A, B, R2, roofC, f1);
    roofTri(w, A, R2, R1, roofC, f1);
    const f2 = facing([Cc, D, R1, R2]);
    roofTri(w, Cc, D, R1, roofC, f2);
    roofTri(w, Cc, R1, R2, roofC, f2);
    w.layer = wallLayer;
    for (const s of [-1, 1]) w.tri(P(s * L, -W, top), P(s * L, W, top), P(s * L, 0, top + h - o * pitch * 0.4), wallC, V(ux * s, 0, uz * s), [-W, top, W, top, 0, top + h]);
  }
  w.layer = -1;
  if (!eaves) return;
  const darker = roofC.clone().multiplyScalar(0.55);
  // cumeeira (peça sobre o encontro das águas)
  {
    const rl = hip ? Math.max(0, L - W) : L + o;
    if (rl > 0.3) w.box(cx, cz, top + h - 0.06, top + h + 0.1, ux, uz, rl, 0.14, darker);
  }
  // calhas nos beirais longos
  for (const sv of [-(W + o), W + o]) {
    const gx = cx + vxx * sv;
    const gz = cz + vzz * sv;
    w.box(gx, gz, yb - 0.32, yb - 0.14, ux, uz, L + o, 0.08, PAL.metal);
  }
  const ring = [A, B, Cc, D];
  for (let i = 0; i < 4; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % 4];
    const out = p.clone().add(q).multiplyScalar(0.5).sub(center).setY(0);
    w.quad(p.clone().setY(yb - 0.16), q.clone().setY(yb - 0.16), q, p, darker, out);
    const inset = (pt: THREE.Vector3) => {
      const lx = (pt.x - cx) * ux + (pt.z - cz) * uz;
      const lz = (pt.x - cx) * vxx + (pt.z - cz) * vzz;
      return P(Math.sign(lx) * L, Math.sign(lz) * W, top - 0.02);
    };
    w.quad(inset(p), inset(q), q.clone().setY(yb - 0.16), p.clone().setY(yb - 0.16), PAL.white, V(0, -1, 0));
  }
}

function sawtoothRoof(w: GeometryWriter, r: OrientedRect, top: number, roofC: THREE.Color, roofLayer: number) {
  const teeth = Math.max(2, Math.floor((r.hl * 2) / 6));
  const tw = (r.hl * 2) / teeth;
  const h = Math.min(2.6, tw * 0.45);
  const vxx = -r.uz;
  const vzz = r.ux;
  const P = (su: number, sv: number, y: number) => V(r.cx + r.ux * su + vxx * sv, y, r.cz + r.uz * su + vzz * sv);
  for (let i = 0; i < teeth; i++) {
    const s0 = -r.hl + i * tw;
    const s1 = s0 + tw;
    w.layer = roofLayer;
    const f = V(-r.ux, 1, -r.uz);
    roofTri(w, P(s0, -r.hw, top), P(s0, r.hw, top), P(s1, r.hw, top + h), roofC, f);
    roofTri(w, P(s0, -r.hw, top), P(s1, r.hw, top + h), P(s1, -r.hw, top + h), roofC, f);
    w.layer = -1;
    // face envidraçada (claraboia) — cinza-azulado
    w.quad(P(s1, -r.hw, top), P(s1, r.hw, top), P(s1, r.hw, top + h), P(s1, -r.hw, top + h), PAL.glassRail, V(r.ux, 0, r.uz));
    for (const sv of [-r.hw, r.hw]) w.tri(P(s0, sv, top), P(s1, sv, top), P(s1, sv, top + h), roofC, V(vxx * Math.sign(sv), 0, vzz * Math.sign(sv)));
  }
}

// ------------------------------------------------------------ peças de fachada

function bayFrame(l: WallLayout, k: number, bay: number) {
  const dx = (l.b[0] - l.a[0]) / l.len;
  const dz = (l.b[1] - l.a[1]) / l.len;
  const s = l.margin + (k + 0.5) * bay;
  return { x: l.a[0] + dx * s, z: l.a[1] + dz * s, dx, dz };
}

/** toldo de lona (liso, com franja) sobre o vão */
function awning(ctx: Ctx, l: WallLayout, k: number, y: number, c: THREE.Color, striped: boolean) {
  const w = ctx.w.detail;
  const bay = BAY[ctx.style];
  const f = bayFrame(l, k, bay);
  const half = bay / 2 - 0.08;
  const depth = 1.1;
  const drop = 0.5;
  const strips = striped ? 6 : 1;
  for (let i = 0; i < strips; i++) {
    const s0 = -half + (i / strips) * half * 2;
    const s1 = -half + ((i + 1) / strips) * half * 2;
    const cc = striped && i % 2 ? PAL.white : c;
    const P = (s: number, out: number, yy: number) => V(f.x + f.dx * s + l.ox * out, yy, f.z + f.dz * s + l.oz * out);
    w.quad(P(s0, 0.05, y), P(s1, 0.05, y), P(s1, depth, y - drop), P(s0, depth, y - drop), cc, V(l.ox, 1.5, l.oz));
    w.quad(P(s0, depth, y - drop), P(s1, depth, y - drop), P(s1, depth, y - drop - 0.2), P(s0, depth, y - drop - 0.2), cc, V(l.ox, 0, l.oz));
  }
  for (const s of [-half, half]) {
    const P = (out: number, yy: number) => V(f.x + f.dx * s + l.ox * out, yy, f.z + f.dz * s + l.oz * out);
    w.tri(P(0.05, y), P(depth, y - drop), P(depth, y - drop - 0.2), c, V(f.dx * Math.sign(s), 0, f.dz * Math.sign(s)));
  }
}

/** sacada: laje + guarda-corpo (vidro ou alvenaria) */
function balcony(ctx: Ctx, l: WallLayout, k: number, y: number, slab: THREE.Color, rail: THREE.Color, solid: boolean) {
  const w = ctx.w.detail;
  const bay = BAY[ctx.style];
  const f = bayFrame(l, k, bay);
  const hu = bay * 0.44;
  const d = 1.15;
  w.box(f.x + l.ox * (d / 2), f.z + l.oz * (d / 2), y - 0.16, y, f.dx, f.dz, hu, d / 2, slab);
  const rh = solid ? 1.0 : 1.05;
  w.box(f.x + l.ox * (d - 0.04), f.z + l.oz * (d - 0.04), y, y + rh, f.dx, f.dz, hu, 0.04, rail);
  for (const s of [-1, 1]) w.box(f.x + f.dx * hu * s + l.ox * (d / 2), f.z + f.dz * hu * s + l.oz * (d / 2), y, y + rh, f.dx, f.dz, 0.04, d / 2, rail);
  if (!solid) w.box(f.x + l.ox * (d - 0.04), f.z + l.oz * (d - 0.04), y + rh, y + rh + 0.05, f.dx, f.dz, hu, 0.05, PAL.metal);
}

/** letreiro (atlas) preso na parede, acima do térreo */
function signOnWall(ctx: Ctx, atlas: SignAtlas, l: WallLayout, y: number, cell: number, maxW = 6, out = 0.12) {
  const mx = (l.a[0] + l.b[0]) / 2;
  const mz = (l.a[1] + l.b[1]) / 2;
  const dx = (l.b[0] - l.a[0]) / l.len;
  const dz = (l.b[1] - l.a[1]) / l.len;
  const hw = Math.min(l.len * 0.42, maxW / 2);
  const hh = Math.min(hw * 0.5, 0.75);
  // caixa do letreiro
  ctx.w.detail.box(mx + l.ox * (out / 2), mz + l.oz * (out / 2), y - hh, y + hh, dx, dz, hw, out / 2, PAL.dark);
  // a parede corre da direita p/ esquerda para quem olha de fora: U invertido
  const [u0, v0, u1, v1] = atlas.uv(cell);
  const P = (s: number, yy: number) => V(mx + dx * s + l.ox * (out + 0.01), yy, mz + dz * s + l.oz * (out + 0.01));
  ctx.w.signs.quad(P(-hw, y - hh), P(hw, y - hh), P(hw, y + hh), P(-hw, y + hh), PAL.white, V(l.ox, 0, l.oz), [u1, v0, u0, v0, u0, v1, u1, v1]);
}

/** outdoor na cobertura (estrutura metálica + painel) virado para a rua */
function billboard(ctx: Ctx, atlas: SignAtlas, l: WallLayout, top: number, cell: number) {
  const d = ctx.w.detail;
  const mx = (l.a[0] + l.b[0]) / 2 - l.ox * 1.5;
  const mz = (l.a[1] + l.b[1]) / 2 - l.oz * 1.5;
  const dx = (l.b[0] - l.a[0]) / l.len;
  const dz = (l.b[1] - l.a[1]) / l.len;
  const hw = Math.min(4.5, l.len * 0.4);
  const y0 = top + 1.4;
  const y1 = y0 + hw * 0.9;
  for (const s of [-0.7, 0.7]) d.box(mx + dx * hw * s, mz + dz * hw * s, top, y0 + 0.2, dx, dz, 0.08, 0.08, PAL.metal);
  d.box(mx, mz, y0 - 0.1, y1 + 0.1, dx, dz, hw + 0.1, 0.12, PAL.dark);
  // a parede corre da direita p/ esquerda para quem olha de fora: U invertido
  const [u0, v0, u1, v1] = atlas.uv(cell);
  const P = (s: number, yy: number) => V(mx + dx * s + l.ox * 0.13, yy, mz + dz * s + l.oz * 0.13);
  ctx.w.signs.quad(P(-hw, y0), P(hw, y0), P(hw, y1), P(-hw, y1), PAL.white, V(l.ox, 0, l.oz), [u1, v0, u0, v0, u0, v1, u1, v1]);
}

/** equipamentos de cobertura (ar-condicionado, caixa d'água, casa de máquinas) */
function rooftop(ctx: Ctx, r: OrientedRect, top: number, opts: { ac: number; tank: boolean; machine: boolean; hvac?: boolean }) {
  const d = ctx.w.detail;
  const rx = r.ux;
  const rz = r.uz;
  const at = (fu: number, fv: number) => [r.cx + rx * r.hl * fu - rz * r.hw * fv, r.cz + rz * r.hl * fu + rx * r.hw * fv] as const;
  for (let i = 0; i < opts.ac; i++) {
    const [x, z] = at(-0.5 + i * 0.25, -0.35 + ctx.rng() * 0.2);
    d.box(x, z, top, top + 0.7, rx, rz, 0.55, 0.4, PAL.steel);
    cylinder(d, x, z, top + 0.7, top + 0.72, 0.3, PAL.dark, 8);
  }
  if (opts.tank) {
    const [x, z] = at(0.55, 0.35);
    d.box(x, z, top, top + 0.4, rx, rz, 0.9, 0.9, PAL.metal);
    cylinder(d, x, z, top + 0.4, top + 1.8, 0.75, PAL.tank, 10, PAL.white);
  }
  if (opts.machine) {
    const [x, z] = at(-0.1, 0.2);
    const hu = Math.min(2.4, r.hl * 0.3);
    const hv = Math.min(2.0, r.hw * 0.4);
    d.box(x, z, top, top + 2.8, rx, rz, hu, hv, PAL.white);
    d.box(x, z, top + 2.8, top + 3.0, rx, rz, hu + 0.15, hv + 0.15, PAL.metal);
  }
  if (opts.hvac) {
    // dutos e exaustores (lojas grandes/escritórios)
    for (let i = 0; i < 3; i++) {
      const [x, z] = at(-0.6 + i * 0.6, 0);
      cylinder(d, x, z, top, top + 1.2, 0.6, PAL.steel, 10, PAL.dark);
    }
    const [ax, az] = at(-0.6, -0.4);
    const [bx, bz] = at(0.6, -0.4);
    const len = Math.hypot(bx - ax, bz - az);
    d.box((ax + bx) / 2, (az + bz) / 2, top + 0.6, top + 1.1, (bx - ax) / len, (bz - az) / len, len / 2, 0.3, PAL.steel);
  }
}

// ------------------------------------------------------- detalhes geométricos

/** retângulo da janela por estilo (mesmos números do shader) */
function windowRect(style: number): [number, number, number, number] | null {
  switch (style) {
    case FacadeStyle.house:
      return [0.72, 0.95, 1.88, 2.35];
    case FacadeStyle.commercial:
      return [0.45, 0.9, 2.15, 2.45];
    case FacadeStyle.apartment:
      return [0.45, 0.8, 2.55, 2.4];
    case FacadeStyle.institutional:
      return [0.35, 0.6, 2.85, 2.6];
    case FacadeStyle.modern:
      return [0.3, 0.6, 3.7, 2.5];
    case FacadeStyle.brick:
      return [0.62, 0.9, 1.78, 2.4];
    case FacadeStyle.slab:
      return [0.55, 0.85, 2.45, 2.3];
    default:
      return null;
  }
}

/** registra as molduras das janelas de uma parede (mesmas regras do shader) */
function collectWindows(ctx: Ctx, l: WallLayout, levels: number, color: THREE.Color) {
  const rect = windowRect(ctx.style);
  if (!rect || !l.bays) return;
  const bay = BAY[ctx.style];
  const dx = (l.b[0] - l.a[0]) / l.len;
  const dz = (l.b[1] - l.a[1]) / l.len;
  const yaw = Math.atan2(l.ox, l.oz);
  const mid = Math.floor(l.bays / 2);
  const doorStyle = [FacadeStyle.house, FacadeStyle.apartment, FacadeStyle.institutional, FacadeStyle.modern, FacadeStyle.brick, FacadeStyle.slab].includes(ctx.style as 0);
  for (let f = 0; f < levels; f++) {
    if ((f + 1) * FLOOR_H > ctx.topV + 0.3) break;
    for (let k = 0; k < l.bays; k++) {
      if (f === 0 && l.front && ctx.style === FacadeStyle.commercial) continue; // vitrine
      if (f === 0 && l.front && k === mid && doorStyle) continue; // porta
      const s = l.margin + k * bay + (rect[0] + rect[2]) / 2;
      ctx.w.windows.push({
        x: l.a[0] + dx * s + l.ox * 0.005,
        y: ctx.gMax + f * FLOOR_H + (rect[1] + rect[3]) / 2,
        z: l.a[1] + dz * s + l.oz * 0.005,
        yaw,
        w: rect[2] - rect[0],
        h: rect[3] - rect[1],
        color,
      });
    }
  }
}

/** cantos convexos de um anel CCW */
function convexCorners(ring: Vec2[]) {
  const out: { p: Vec2; ax: number; az: number }[] = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const a = ring[(i - 1 + ring.length) % ring.length];
    const b = ring[(i + 1) % ring.length];
    const cross = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]);
    if (cross > 0) {
      // bissetriz externa
      const e1 = norm2(p[0] - a[0], p[1] - a[1]);
      const e2 = norm2(b[0] - p[0], b[1] - p[1]);
      const n = norm2(e1[1] + e2[1], -e1[0] - e2[0]);
      out.push({ p, ax: n[0], az: n[1] });
    }
  }
  return out;
}

/** cunhais (pilastras de canto) das casas coloniais */
function quoins(w: GeometryWriter, ring: Vec2[], y0: number, y1: number, c: THREE.Color) {
  for (const { p, ax, az } of convexCorners(ring)) {
    const ux = -az;
    const uz = ax;
    w.box(p[0] + ax * 0.04, p[1] + az * 0.04, y0, y1, ux, uz, 0.24, 0.24, c);
  }
}

/** pilastras verticais entre vãos (prédios de tijolo / lojas) */
function pilasters(w: GeometryWriter, l: WallLayout, bay: number, every: number, y0: number, y1: number, c: THREE.Color, layer: number) {
  const dx = (l.b[0] - l.a[0]) / l.len;
  const dz = (l.b[1] - l.a[1]) / l.len;
  w.layer = layer;
  for (let k = 0; k <= l.bays; k += every) {
    const s = l.margin + k * bay;
    if (s < 0.3 || s > l.len - 0.3) continue;
    w.box(l.a[0] + dx * s + l.ox * 0.1, l.a[1] + dz * s + l.oz * 0.1, y0, y1, dx, dz, 0.18, 0.12, c);
  }
  w.layer = -1;
}

/** anel retangular com cantos arredondados (quartos de círculo) */
function roundedRing(r: OrientedRect, radius: number, seg = 5): Vec2[] {
  const vx = -r.uz;
  const vz = r.ux;
  const pts: Vec2[] = [];
  const corners: [number, number, number][] = [
    [r.hl - radius, -r.hw + radius, -Math.PI / 2],
    [r.hl - radius, r.hw - radius, 0],
    [-r.hl + radius, r.hw - radius, Math.PI / 2],
    [-r.hl + radius, -r.hw + radius, Math.PI],
  ];
  for (const [cu, cv, a0] of corners)
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      const su = cu + Math.cos(a) * radius;
      const sv = cv + Math.sin(a) * radius;
      pts.push([r.cx + r.ux * su + vx * sv, r.cz + r.uz * su + vz * sv]);
    }
  return orientCCW(pts);
}

/**
 * Casa com varanda recortada no volume: o anel ganha um entalhe na frente
 * (numa ponta); o telhado continua cobrindo a varanda, apoiado em colunas.
 */
function porchRing(r: OrientedRect, side: 1 | -1, pw: number, pd: number): { ring: Vec2[]; columns: Vec2[]; floor: Vec2[] } {
  const vx = -r.uz;
  const vz = r.ux;
  const W = (su: number, sv: number): Vec2 => [r.cx + r.ux * su + vx * sv * side, r.cz + r.uz * su + vz * sv * side];
  const { hl, hw } = r;
  const ring = orientCCW([W(-hl, -hw + pd), W(-hl + pw, -hw + pd), W(-hl + pw, -hw), W(hl, -hw), W(hl, hw), W(-hl, hw)]);
  const columns = [W(-hl + 0.2, -hw + 0.2)];
  if (pw > 4) columns.push(W(-hl + pw / 2, -hw + 0.2));
  const floor = [W(-hl, -hw), W(-hl + pw, -hw), W(-hl + pw, -hw + pd), W(-hl, -hw + pd)];
  return { ring, columns, floor };
}

// ------------------------------------------------------------------ escolha

export interface BuildingStyle {
  category: BuildingCategory;
  archetype: Archetype;
  seed: number;
}

/** escolhe o arquétipo (determinístico) */
export function styleFor(b: Building): BuildingStyle {
  const seed = (b.generated ? hashId(b.lotId.length * 7919 + hashCode(b.lotId)) : hashId(b.osmId)) % 100000;
  const r = mulberry32(seed)();
  const cat = categoryOf(b);
  const lv = Math.max(1, Math.round(b.levels));
  const area = b.area || polygonArea(b.outer);
  let a: Archetype;
  switch (cat) {
    case 'religious':
      a = 'igreja';
      break;
    case 'institutional':
      a = 'institucional';
      break;
    case 'industrial':
      a = r < 0.6 ? 'galpao-metalico' : 'fabrica-tijolo';
      break;
    case 'commercial':
      if (area > 600 && lv <= 2) a = 'supermercado';
      else if (lv >= 4) a = r < 0.5 ? 'escritorios' : r < 0.75 ? 'torre-moderna' : 'loja-tijolo';
      else a = r < 0.45 ? 'loja-tijolo' : 'loja-reboco';
      break;
    default:
      if (lv >= 6 || b.type === 'apartments') a = r < 0.4 ? 'bloco-bnh' : r < 0.7 ? 'torre-tijolo' : 'torre-moderna';
      else if (lv >= 3) a = r < 0.5 ? 'predio-baixo' : r < 0.8 ? 'torre-tijolo' : 'bloco-bnh';
      else a = r < 0.38 ? 'colonial' : r < 0.6 ? 'casa-moderna' : r < 0.8 ? 'sobrado-tijolo' : 'casa-simples';
  }
  return { category: cat, archetype: a, seed };
}

// ------------------------------------------------------------------ prédios

/** Escreve o prédio nos escritores (paredes, peças, letreiros). */
export function writeBuilding(ws: BuildingWriters, b: Building, hf: HeightField, detail: Detail, front?: FrontTest, signs?: SignAtlas) {
  const st = styleFor(b);
  const rng = mulberry32(st.seed * 7 + 13);
  const { gMin, gMax } = groundRange(b, hf);
  const base = gMin - 1.2;
  const area = b.area || polygonArea(b.outer);
  const rect = minAreaRect(b.outer);
  const rectangular = area / (4 * rect.hl * rect.hw) > 0.82 && !b.holes?.length;
  const levels = Math.max(1, Math.round(b.levels));
  const arch = st.archetype;

  // parâmetros por arquétipo
  let style: number = FacadeStyle.house;
  let wallLayer: number = Layer.plaster;
  let wallC = PAL.white;
  let trim = pick(PAL.trims, rng());
  let roof: 'hip' | 'gable' | 'flat' | 'saw' = 'flat';
  let roofLayer: number = Layer.roofConcrete;
  // lajes de concreto envelhecido (cinza-amarronzado)
  let roofC = pick([C('#8f8b83'), C('#827e77'), C('#9a958b'), C('#7a776f'), C('#a09b90')], rng());
  let roofBand = false;
  switch (arch) {
    case 'colonial':
      style = FacadeStyle.house;
      wallC = pick(PAL.colonial, rng());
      roof = rng() < 0.6 ? 'hip' : 'gable';
      roofLayer = Layer.roofClay;
      break;
    case 'casa-simples':
      style = FacadeStyle.house;
      wallC = pick(PAL.colonial, rng());
      roof = 'gable';
      roofLayer = rng() < 0.6 ? Layer.roofGrey : Layer.roofClay;
      break;
    case 'casa-moderna':
      style = FacadeStyle.modern;
      wallC = pick(PAL.modern, rng());
      wallLayer = rng() < 0.3 ? Layer.tiles : Layer.plaster;
      trim = PAL.dark;
      roof = 'flat';
      break;
    case 'sobrado-tijolo':
      style = FacadeStyle.brick;
      wallLayer = rng() < 0.6 ? Layer.brickRed : Layer.brickYellow;
      wallC = pick(PAL.natural, rng());
      roof = 'gable';
      roofLayer = rng() < 0.5 ? Layer.roofSlate : Layer.roofClay;
      break;
    case 'predio-baixo':
      style = FacadeStyle.apartment;
      wallC = pick(PAL.colonial, rng());
      roof = 'flat';
      roofBand = true;
      // muitos prediozinhos têm telhado de 4 águas (metal marrom ou cerâmica)
      if (rng() < 0.45) {
        roof = 'hip';
        roofBand = false;
        const metal = rng() < 0.55;
        roofLayer = metal ? Layer.roofMetal : Layer.roofClay;
        if (metal) roofC = pick([C('#7a4a3a'), C('#6e5040'), C('#835844'), C('#5f4a3e')], rng());
      }
      break;
    case 'bloco-bnh':
      style = FacadeStyle.slab;
      // painel nervurado parece chapa de galpão: residencial usa reboco/concreto liso
      wallLayer = rng() < 0.55 ? Layer.plaster : Layer.concrete;
      wallC = pick(PAL.slab, rng());
      roofBand = true;
      break;
    case 'torre-tijolo':
      style = FacadeStyle.brick;
      wallLayer = rng() < 0.65 ? Layer.brickRed : Layer.brickYellow;
      wallC = pick(PAL.natural, rng());
      roofBand = true;
      break;
    case 'torre-moderna':
      style = FacadeStyle.apartment;
      wallLayer = rng() < 0.5 ? Layer.tiles : Layer.concrete;
      wallC = pick(PAL.towerGrey, rng());
      roofBand = true;
      break;
    case 'loja-tijolo':
      style = FacadeStyle.commercial;
      wallLayer = rng() < 0.6 ? Layer.brickRed : Layer.brickYellow;
      wallC = pick(PAL.natural, rng());
      roofBand = true;
      break;
    case 'loja-reboco':
      style = FacadeStyle.commercial;
      wallC = pick(PAL.plasterShop, rng());
      roof = levels === 1 && rng() < 0.25 && rect.hw < 12 ? 'gable' : 'flat';
      roofLayer = Layer.roofClay;
      // sobrados comerciais: telhado de metal escondido atrás da platibanda é comum,
      // mas parte mostra 4 águas marrom
      if (roof === 'flat' && levels >= 2 && levels <= 3 && rng() < 0.35) {
        roof = 'hip';
        roofLayer = Layer.roofMetal;
        roofC = pick([C('#7a4a3a'), C('#6e5040'), C('#835844')], rng());
      }
      break;
    case 'supermercado':
      style = FacadeStyle.commercial;
      wallLayer = rng() < 0.5 ? Layer.tiles : Layer.concrete;
      wallC = pick(PAL.plasterShop, rng());
      roofLayer = Layer.roofMetal;
      roofC = pick([C('#7a4a3a'), C('#6e5040'), C('#8a5a44')], rng());
      roofBand = true;
      break;
    case 'escritorios':
      style = FacadeStyle.office;
      wallLayer = Layer.concrete;
      wallC = pick(PAL.towerGrey, rng());
      trim = pick([C('#2d3b48'), C('#3b4a3f'), C('#4a4038'), C('#20303f')], rng());
      roofBand = true;
      break;
    case 'galpao-metalico':
      style = FacadeStyle.industrial;
      wallLayer = Layer.metal;
      wallC = pick(PAL.industrial, rng());
      roof = rectangular && rect.hl > 8 && rng() < 0.5 ? 'saw' : 'gable';
      roofLayer = Layer.roofMetal;
      roofC = pick(PAL.industrial, rng());
      break;
    case 'fabrica-tijolo':
      style = FacadeStyle.industrial;
      wallLayer = Layer.brickRed;
      wallC = pick(PAL.natural, rng());
      roof = rectangular && rect.hl > 7 ? 'saw' : 'gable';
      roofLayer = Layer.roofMetal;
      roofC = C('#8c949b');
      break;
    case 'institucional':
      style = FacadeStyle.institutional;
      wallC = pick(PAL.institutional, rng());
      wallLayer = rng() < 0.3 ? Layer.tiles : Layer.plaster;
      roofBand = true;
      break;
    case 'igreja':
      style = FacadeStyle.plain;
      wallC = PAL.church;
      trim = PAL.churchTrim;
      break;
  }
  const pitchedOk = rectangular && rect.hw < 14 && area < 1200;
  if ((roof === 'hip' || roof === 'gable') && !pitchedOk) roof = 'flat';
  if (roof === 'saw' && !rectangular) roof = 'flat';
  // telhado é a "cara" de longe: no LOD baixo simplifica, mas mantém o tipo
  const top = gMax + Math.max(b.height, levels * FLOOR_H);
  const ctx: Ctx = { w: ws, rng, gMax, topV: top - gMax, seed: style === FacadeStyle.plain ? 0 : 0.05 + (st.seed % 1000) / 1050, trim, style };
  const frontOf = (l: WallLayout) => l.len > 3 && !!front?.((l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2, l.ox, l.oz);

  if (arch === 'igreja' && rectangular) return writeChurch(ws, b, rect, base, top, gMax, ctx, detail);

  // ---- forma do volume: polígono real, retângulo chanfrado, cantos
  // arredondados (torres modernas) ou casa com varanda recortada
  let ring: Vec2[];
  let porch: ReturnType<typeof porchRing> | null = null;
  const roundTower = rectangular && (arch === 'torre-moderna' || arch === 'escritorios') && rect.hw > 5 && rng() < 0.6;
  const housey = arch === 'colonial' || arch === 'casa-simples' || arch === 'casa-moderna';
  if (!rectangular) ring = orientCCW(b.outer);
  else if (roundTower) ring = roundedRing(rect, Math.min(3, rect.hw * 0.35));
  else if (housey && levels === 1 && detail === 'high' && rect.hl > 4.5 && rect.hw > 3.2 && rng() < 0.5) {
    // lado da frente = lado longo voltado para a rua
    const vx = -rect.uz;
    const vz = rect.ux;
    const sideFront = (sgn: number) => !!front?.(rect.cx + vx * rect.hw * sgn, rect.cz + vz * rect.hw * sgn, vx * sgn, vz * sgn);
    const side: 1 | -1 = sideFront(-1) ? -1 : sideFront(1) ? 1 : -1;
    porch = porchRing(rect, side, Math.min(rect.hl, 5.5), Math.min(2.4, rect.hw * 0.6));
    ring = porch.ring;
  } else ring = boxRing(rect, style === FacadeStyle.office || style === FacadeStyle.slab ? 0 : Math.min(0.3, rect.hw * 0.08));
  let anyFront = false;
  const walls = writeWalls(ctx, ring, base, top, wallC, wallLayer, (l) => {
    const f = frontOf(l);
    anyFront ||= f;
    return f;
  });
  if (!anyFront && walls.length) walls.reduce((a, l) => (l.len > a.len ? l : a)).front = true;
  for (const h of b.holes ?? []) writeWalls(ctx, orientCCW(h).reverse(), base, top, wallC, wallLayer, () => false);
  const d = ws.detail;

  // ---- telhado
  if (roof === 'hip' || roof === 'gable') pitchedRoof(d, rect, top, roofC, wallC, wallLayer, roofLayer, roof === 'hip', arch === 'galpao-metalico' || arch === 'fabrica-tijolo' ? 0.22 : arch === 'predio-baixo' || arch === 'loja-reboco' ? 0.32 : 0.5, detail === 'high');
  else if (roof === 'saw' && detail === 'high') {
    sawtoothRoof(d, rect, top, roofC, roofLayer);
    cap(d, ring, top - 0.02, roofC, roofLayer);
  } else {
    cap(d, ring, top + 0.01, roofC, roof === 'saw' ? roofLayer : arch === 'supermercado' ? Layer.roofMetal : Layer.roofConcrete, b.holes);
    if (detail === 'high') parapet(d, ring, top, roofBand || arch === 'casa-moderna' ? 0.9 : 0.6, wallC, wallLayer);
  }
  if (detail === 'low') return;

  // ---- molduras de janela (geometria instanciada)
  const frameC =
    style === FacadeStyle.modern
      ? C('#2a2d31')
      : style === FacadeStyle.house
        ? PAL.white
        : style === FacadeStyle.brick
          ? C('#efe9dc')
          : C('#c9ced3');
  for (const l of walls) collectWindows(ctx, l, levels, frameC);

  // ---- casas: cunhais, cornija, varanda com colunas
  if (rectangular && (arch === 'colonial' || arch === 'sobrado-tijolo')) quoins(d, ring, base, top, arch === 'colonial' ? PAL.white : C('#e6dfd2'));
  if (rectangular && (roof === 'hip' || roof === 'gable') && housey) band(d, ring, top - 0.32, top - 0.02, 0.1, PAL.white);
  if (porch) {
    d.layer = Layer.patio;
    cap(d, porch.floor, gMax + 0.14, C('#d9cbb5'), Layer.patio);
    d.layer = -1;
    for (const [x, z] of porch.columns) {
      cylinder(d, x, z, gMax, top, 0.13, PAL.white, 8);
      d.box(x, z, gMax, gMax + 0.35, rect.ux, rect.uz, 0.2, 0.2, PAL.white);
    }
  }
  // ---- pilastras em tijolo e embasamento (marquise) nas torres
  if (rectangular && (arch === 'torre-tijolo' || arch === 'loja-tijolo')) for (const l of walls) if (l.bays >= 3) pilasters(d, l, BAY[style], 2, base, top - 0.6, wallC, wallLayer);
  if (rectangular && levels >= 5) band(d, ring, gMax + FLOOR_H - 0.1, gMax + FLOOR_H + 0.18, 0.55, PAL.white, Layer.concrete);
  // ---- cobertura recuada (penthouse) nas torres altas
  let penthouse = false;
  if (rectangular && !roundTower && levels >= 7 && (arch === 'torre-moderna' || arch === 'escritorios' || arch === 'bloco-bnh') && rect.hw > 6) {
    penthouse = true;
    const ph = { ...rect, hl: rect.hl - 2.2, hw: rect.hw - 2.2 };
    const phRing = boxRing(ph);
    const ctx2: Ctx = { ...ctx, topV: top + FLOOR_H - gMax };
    writeWalls(ctx2, phRing, top, top + FLOOR_H, wallC, wallLayer, () => false);
    cap(d, phRing, top + FLOOR_H + 0.01, roofC, Layer.roofConcrete);
    parapet(d, phRing, top + FLOOR_H, 0.6, wallC, wallLayer);
  }

  // ---- faixas de laje / cornija
  if (rectangular && (style === FacadeStyle.slab || style === FacadeStyle.apartment || style === FacadeStyle.institutional)) {
    const bc = style === FacadeStyle.slab ? PAL.white : wallC.clone().multiplyScalar(0.82);
    for (let f = 1; f < levels; f++) band(d, ring, gMax + f * FLOOR_H - 0.12, gMax + f * FLOOR_H + 0.1, 0.08, bc, Layer.concrete);
  }
  if (rectangular && style === FacadeStyle.brick && levels >= 3) band(d, ring, top - 0.6, top - 0.3, 0.18, C('#d9d2c4'), Layer.concrete);
  if (rectangular && style === FacadeStyle.office) {
    // embasamento (térreo) recuado em pedra/concreto escuro
    band(d, ring, gMax + FLOOR_H - 0.25, gMax + FLOOR_H + 0.25, 0.25, C('#5a6066'), Layer.concrete);
  }

  // ---- peças por parede
  const bay = BAY[style];
  for (const l of walls) {
    if (!l.bays) continue;
    const storefront = style === FacadeStyle.commercial || style === FacadeStyle.office;
    if (storefront && l.front) {
      const c = pick(PAL.awnings, rng());
      if (arch !== 'escritorios' && arch !== 'supermercado') for (let k = 0; k < l.bays; k++) if (rng() < 0.75) awning(ctx, l, k, gMax + 3.0, c, rng() < 0.35);
      if (signs) {
        const cell = signs.signFor(b.name ?? b.pois?.[0]?.name, st.seed);
        if (arch === 'supermercado') signOnWall(ctx, signs, l, top - 1.0, cell, 12, 0.2);
        else signOnWall(ctx, signs, l, levels === 1 ? top + 0.0 : gMax + 3.45, cell, 6);
      }
    }
    if (style === FacadeStyle.house && l.front && levels >= 2) for (let k = 0; k < l.bays; k++) if (rng() < 0.3) balcony(ctx, l, k, gMax + FLOOR_H + 0.02, wallC, PAL.dark, false);
    if ((style === FacadeStyle.slab || style === FacadeStyle.apartment) && l.len > 6) {
      const glassRail = style === FacadeStyle.apartment;
      for (let f = 1; f < levels; f++)
        for (let k = 0; k < l.bays; k++) {
          const pattern = style === FacadeStyle.slab ? (k % 2 === 0) : (k + f) % 2 === 0;
          if (pattern && (l.front || style === FacadeStyle.slab)) balcony(ctx, l, k, gMax + f * FLOOR_H + 0.02, PAL.white, glassRail ? PAL.glassRail : wallC, !glassRail);
        }
    }
    if (style === FacadeStyle.industrial && l.front) {
      const k = Math.floor(l.bays / 2);
      const f = bayFrame(l, k, bay);
      d.box(f.x + l.ox * 1.2, f.z + l.oz * 1.2, gMax + 3.6, gMax + 3.8, f.dx, f.dz, bay * 1.2, 1.2, PAL.metal);
    }
  }

  // ---- outdoor em coberturas de comércio/torres
  if (signs && rectangular && (style === FacadeStyle.commercial || arch === 'torre-moderna' || arch === 'escritorios') && rng() < 0.22) {
    const fw = walls.find((l) => l.front && l.len > 6);
    if (fw) billboard(ctx, signs, fw, top + 0.6, signs.adFor(st.seed));
  }

  // ---- cobertura
  if (roof === 'flat' || roof === 'saw') {
    if (rectangular)
      rooftop(ctx, rect, top, {
        ac: style === FacadeStyle.commercial || style === FacadeStyle.office ? 2 + Math.floor(rng() * 3) : rng() < 0.4 ? 1 : 0,
        tank: rng() < 0.7 && arch !== 'supermercado',
        machine: levels >= 5 && !penthouse,
        hvac: arch === 'supermercado' || arch === 'escritorios',
      });
  } else if ((arch === 'colonial' || arch === 'sobrado-tijolo') && rng() < 0.45) {
    // chaminé
    const sx = rect.cx + rect.ux * rect.hl * 0.45 - rect.uz * rect.hw * 0.3;
    const sz = rect.cz + rect.uz * rect.hl * 0.45 + rect.ux * rect.hw * 0.3;
    const ch = top + Math.min(rect.hw * 0.5, 2.6) + 0.9;
    d.layer = arch === 'sobrado-tijolo' ? Layer.brickRed : Layer.plaster;
    d.box(sx, sz, top, ch, rect.ux, rect.uz, 0.32, 0.32, arch === 'sobrado-tijolo' ? PAL.white : wallC);
    d.layer = -1;
    d.box(sx, sz, ch, ch + 0.12, rect.ux, rect.uz, 0.4, 0.4, PAL.dark);
  }
  // indústria: chaminé e tanques
  if (style === FacadeStyle.industrial && rectangular) {
    if (rng() < 0.5) {
      const sx = rect.cx + rect.ux * rect.hl * 0.6;
      const sz = rect.cz + rect.uz * rect.hl * 0.6;
      const ch = top + 8 + rng() * 8;
      d.layer = Layer.brickRed;
      cylinder(d, sx, sz, top, ch, 0.7, PAL.white, 10, PAL.dark);
      d.layer = -1;
      cylinder(d, sx, sz, ch - 1.2, ch, 0.74, PAL.dark, 10, PAL.dark);
    }
    if (rng() < 0.4) {
      const tx = rect.cx - rect.ux * rect.hl * 0.55;
      const tz = rect.cz - rect.uz * rect.hl * 0.55;
      cylinder(d, tx, tz, top, top + 3.5, Math.min(1.8, rect.hw * 0.4), PAL.steel, 12, PAL.metal);
    }
  }
  if (arch === 'institucional' && rectangular) {
    const x = rect.cx + rect.ux * rect.hl * 0.7;
    const z = rect.cz + rect.uz * rect.hl * 0.7;
    cylinder(d, x, z, top, top + 6, 0.05, PAL.metal, 5);
    d.box(x + rect.ux * 0.7, z + rect.uz * 0.7, top + 5, top + 5.9, rect.ux, rect.uz, 0.7, 0.02, C('#2f9e44'));
  }
}

/** Igreja barroca: nave de 2 águas + torre(s) na fachada. */
function writeChurch(ws: BuildingWriters, b: Building, r: OrientedRect, base: number, top: number, ground: number, ctx: Ctx, detail: Detail) {
  writeWalls(ctx, boxRing(r), base, top, PAL.church, Layer.plaster, () => false, false);
  pitchedRoof(ws.detail, r, top, pick(PAL.natural, 0.2), PAL.church, Layer.plaster, Layer.roofClay, false, 0.7, detail === 'high');
  if (detail === 'low') return;
  const w = ws.walls;
  const d = ws.detail;
  const trim = PAL.churchTrim;
  const towers = b.area > 280 ? 2 : 1;
  const ts = Math.min(r.hw * (towers === 2 ? 0.42 : 0.6), 4.2);
  const towerTop = top + Math.max(8, r.hw * 1.2);
  const vxx = -r.uz;
  const vzz = r.ux;
  const offsets = towers === 2 ? [-(r.hw - ts), r.hw - ts] : [0];
  w.style = [trim.r, trim.g, trim.b, FacadeStyle.plain * 2];
  for (const off of offsets) {
    const cx = r.cx - r.ux * (r.hl - ts) + vxx * off;
    const cz = r.cz - r.uz * (r.hl - ts) + vzz * off;
    w.layer = Layer.plaster;
    w.box(cx, cz, ground - 1, towerTop, r.ux, r.uz, ts, ts, PAL.church);
    w.layer = -1;
    d.box(cx, cz, towerTop - 3.2, towerTop - 2.95, r.ux, r.uz, ts * 1.08, ts * 1.08, PAL.white);
    d.box(cx, cz, towerTop, towerTop + 0.45, r.ux, r.uz, ts * 1.14, ts * 1.14, trim);
    for (const s of [-1, 1]) d.box(cx + vxx * s * ts * 1.001, cz + vzz * s * ts * 1.001, towerTop - 2.6, towerTop - 0.6, r.ux, r.uz, ts * 0.45, 0.02, PAL.dark);
    const apex = V(cx, towerTop + 0.45 + ts * 1.6, cz);
    const P = (su: number, sv: number) => V(cx + r.ux * ts * su + vxx * ts * sv, towerTop + 0.45, cz + r.uz * ts * su + vzz * ts * sv);
    const cs: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (let i = 0; i < 4; i++) {
      const p0 = P(...cs[i]);
      const p1 = P(...cs[(i + 1) % 4]);
      d.tri(p0, p1, apex, trim, p0.clone().add(p1).multiplyScalar(0.5).sub(V(cx, towerTop, cz)).setY(0.5));
    }
    d.box(apex.x, apex.z, apex.y, apex.y + 1.2, r.ux, r.uz, 0.06, 0.06, C('#d9b44a'));
    d.box(apex.x, apex.z, apex.y + 0.7, apex.y + 0.82, r.ux, r.uz, 0.35, 0.06, C('#d9b44a'));
  }
  const fx = r.cx - r.ux * (r.hl + 0.02);
  const fz = r.cz - r.uz * (r.hl + 0.02);
  d.box(fx, fz, ground, ground + 3.6, vxx, vzz, 1.0, 0.05, C('#5b3a22'));
}
