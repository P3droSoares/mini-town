import * as THREE from 'three';
import type { Building, BuildingCategory, Ring, Vec2 } from '../../data/types';
import type { HeightField } from '../HeightField';
import { hashId, mulberry32, polygonArea } from '../geo';
import { GeometryWriter, UP } from './GeometryWriter';

/**
 * Kit de prédios estilo "diorama": formas limpas com cantos chanfrados,
 * cores pastel e peças geométricas (toldos listrados, sacadas, floreiras,
 * jardins na cobertura, faixas de laje, chaminés, dentes de serra).
 * As janelas são desenhadas no shader com o MESMO layout usado aqui para
 * posicionar as peças — assim toldo e sacada caem exatamente nos vãos.
 */

export type Detail = 'high' | 'low';

/** paredes (shader de fachada) e detalhes (cor sólida) */
export interface BuildingWriters {
  walls: GeometryWriter;
  detail: GeometryWriter;
}
export const WRITER_KEYS = ['walls', 'detail'] as const;
export type WriterKey = (typeof WRITER_KEYS)[number];

export function createWriters(): BuildingWriters {
  return { walls: new GeometryWriter(), detail: new GeometryWriter() };
}

/** Teste "esta parede dá para a rua?" (ponto médio + normal externa) */
export type FrontTest = (mx: number, mz: number, ox: number, oz: number) => boolean;

/** estilos de fachada (iguais no shader) */
export const FacadeStyle = { house: 0, commercial: 1, apartment: 2, industrial: 3, plain: 4, institutional: 5 } as const;
/** largura do vão por estilo (iguais no shader) */
export const BAY: Record<number, number> = { 0: 2.6, 1: 2.6, 2: 3.0, 3: 4.0, 4: 3.0, 5: 3.2 };
export const FLOOR_H = 3.0;

// ------------------------------------------------------------------ paletas

const C = (h: string) => new THREE.Color(h);
const PAL = {
  resWalls: ['#ffe8c9', '#ffd3c2', '#ffc9d6', '#cfe6f7', '#d3efcf', '#fff0b3', '#e6d9f7', '#fdf6ea', '#ffdcb0', '#c6ecec', '#f9c7c7', '#e2f2b8'].map(C),
  resRoofs: ['#e8743b', '#f08a4b', '#d9653a', '#c95a3a', '#ef7d5a', '#e66a45', '#e98aa0', '#7f93a8'].map(C),
  comWalls: ['#fdf6ea', '#ffe1c7', '#d6ecf3', '#fde2e4', '#e2f3dc', '#fff3c4', '#e9e1f7', '#f2f2f2'].map(C),
  awnings: ['#e8743b', '#2bb3a3', '#e2534a', '#f2c14e', '#2f4a6d', '#8bc34a', '#d96a9a'].map(C),
  aptWalls: ['#c9ced3', '#dfe3e6', '#f7c9d4', '#c6dff2', '#f4dcc0', '#d9e9d2', '#e8d6f2'].map(C),
  aptBands: ['#8b939b', '#a7adb3', '#7d8790', '#b5aa98'].map(C),
  indWalls: ['#c9d3dc', '#d8d2c4', '#b8c4cc', '#d6dde3', '#cfd8cf'].map(C),
  indRoofs: ['#8c99a6', '#9aa5ad', '#7d8b96'].map(C),
  instWalls: ['#f4efe6', '#eef2f6', '#f6eadf'].map(C),
  trims: ['#2f5d8a', '#2e6b4f', '#c9961e', '#8e2f2a', '#3c4f6b', '#e8743b', '#1f4a5e', '#6b4a8e'].map(C),
  white: C('#fbfaf6'),
  roofFlat: C('#c9cdd1'),
  parapet: C('#eceae4'),
  garden: C('#7cc26b'),
  bushes: ['#5fb35a', '#8fd16f', '#4fa45a', '#a3d977'].map(C),
  flowers: ['#ff8fa3', '#ffd166', '#f07167', '#c77dff', '#ffffff'].map(C),
  planter: C('#c9744e'),
  glassRail: C('#bfe0ee'),
  dark: C('#3a3f45'),
  metal: C('#9aa3ab'),
  tank: C('#4f86b0'),
  church: C('#fbfaf5'),
  churchTrim: C('#3f6d8f'),
  chimneyRed: C('#d9573f'),
};
const pick = <T>(arr: T[], r: number) => arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];

// ---------------------------------------------------------------- geometria

interface OrientedRect {
  cx: number;
  cz: number;
  /** eixo do lado longo */
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

/** "caixa" orientada por (ux,uz) */
interface Box {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  hu: number;
  hv: number;
}
const vx = (b: Box) => -b.uz;
const vz = (b: Box) => b.ux;
/** ponto local (su ao longo de u, sv ao longo de v) */
const at = (b: Box, su: number, sv: number, y: number) => V(b.cx + b.ux * su + vx(b) * sv, y, b.cz + b.uz * su + vz(b) * sv);

/** Writer + contexto do prédio corrente */
interface Ctx {
  w: BuildingWriters;
  rng: () => number;
  gMax: number;
  topV: number;
  seed: number;
  trim: THREE.Color;
  style: number;
  detail: Detail;
}

/**
 * Paredes de um anel (polígono CCW) com fachada. `frontEdge` marca a
 * parede da frente (vitrines, porta). Retorna o layout de cada parede.
 */
interface WallLayout {
  a: Vec2;
  b: Vec2;
  len: number;
  bays: number;
  margin: number;
  /** normal externa */
  ox: number;
  oz: number;
  front: boolean;
}

function writeWalls(ctx: Ctx, ring: Vec2[], y0: number, y1: number, color: THREE.Color, front: (i: number, l: WallLayout) => boolean, windows = true): WallLayout[] {
  const out: WallLayout[] = [];
  const w = ctx.w.walls;
  const bay = BAY[ctx.style];
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
    l.front = front(i, l);
    w.style = [ctx.trim.r, ctx.trim.g, ctx.trim.b, ctx.style * 2 + (l.front ? 1 : 0)];
    w.wall = [len, margin, bays, 0];
    const s = bays > 0 ? ctx.seed : 0;
    const vb = y0 - ctx.gMax;
    const top = ctx.topV;
    w.quad(
      V(a[0], y0, a[1]),
      V(b[0], y0, b[1]),
      V(b[0], y1, b[1]),
      V(a[0], y1, a[1]),
      color,
      V(ox, 0, oz),
      [0, y0, len, y0, len, y1, 0, y1],
      [0, vb, top, s, len, vb, top, s, len, y1 - ctx.gMax, top, s, 0, y1 - ctx.gMax, top, s],
    );
    out.push(l);
  }
  w.wall = [0, 0, 0, 0];
  return out;
}

/** octógono = retângulo com cantos chanfrados (CCW) */
function chamferRing(b: Box, c: number): Vec2[] {
  const pts: [number, number][] = [
    [-b.hu + c, -b.hv],
    [b.hu - c, -b.hv],
    [b.hu, -b.hv + c],
    [b.hu, b.hv - c],
    [b.hu - c, b.hv],
    [-b.hu + c, b.hv],
    [-b.hu, b.hv - c],
    [-b.hu, -b.hv + c],
  ];
  const ring = pts.map(([su, sv]) => {
    const p = at(b, su, sv, 0);
    return [p.x, p.z] as Vec2;
  });
  return orientCCW(ring);
}

function rectRing(b: Box): Vec2[] {
  const ring = (
    [
      [-b.hu, -b.hv],
      [b.hu, -b.hv],
      [b.hu, b.hv],
      [-b.hu, b.hv],
    ] as [number, number][]
  ).map(([su, sv]) => {
    const p = at(b, su, sv, 0);
    return [p.x, p.z] as Vec2;
  });
  return orientCCW(ring);
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

/** tampa plana de um anel */
function cap(w: GeometryWriter, ring: Vec2[], y: number, c: THREE.Color, holes?: Ring[]) {
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
}

/** faixa (laje/cornija) saliente em volta de um anel */
function band(w: GeometryWriter, ring: Vec2[], y0: number, y1: number, out: number, c: THREE.Color, top = true) {
  const n = ring.length;
  const off: Vec2[] = ring.map((p, i) => {
    const prev = ring[(i - 1 + n) % n];
    const next = ring[(i + 1) % n];
    const e1 = norm2(p[0] - prev[0], p[1] - prev[1]);
    const e2 = norm2(next[0] - p[0], next[1] - p[1]);
    // normais externas (CCW): (dz, -dx)
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
    const o = V(b[1] - a[1], 0, -(b[0] - a[0]));
    w.quad(V(a[0], y0, a[1]), V(b[0], y0, b[1]), V(b[0], y1, b[1]), V(a[0], y1, a[1]), c, o);
    // face de baixo (aparece em vista de baixo)
    w.quad(V(ring[i][0], y0, ring[i][1]), V(ring[(i + 1) % n][0], y0, ring[(i + 1) % n][1]), V(b[0], y0, b[1]), V(a[0], y0, a[1]), c, V(0, -1, 0));
  }
  if (top) {
    for (let i = 0; i < n; i++) {
      const a = off[i];
      const b = off[(i + 1) % n];
      w.quad(V(ring[i][0], y1, ring[i][1]), V(ring[(i + 1) % n][0], y1, ring[(i + 1) % n][1]), V(b[0], y1, b[1]), V(a[0], y1, a[1]), c, UP);
    }
  }
}

function norm2(x: number, z: number): [number, number] {
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
}

/** parapeito: paredes finas em volta da laje (face externa + interna + topo) */
function parapet(w: GeometryWriter, ring: Vec2[], y: number, h: number, c: THREE.Color, inner: THREE.Color) {
  const n = ring.length;
  const t = 0.18;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    const ox = (b[1] - a[1]) / len;
    const oz = -(b[0] - a[0]) / len;
    w.quad(V(a[0], y, a[1]), V(b[0], y, b[1]), V(b[0], y + h, b[1]), V(a[0], y + h, a[1]), c, V(ox, 0, oz));
    const ai = [a[0] - ox * t, a[1] - oz * t];
    const bi = [b[0] - ox * t, b[1] - oz * t];
    w.quad(V(ai[0], y, ai[1]), V(bi[0], y, bi[1]), V(bi[0], y + h, bi[1]), V(ai[0], y + h, ai[1]), inner, V(-ox, 0, -oz));
    w.quad(V(a[0], y + h, a[1]), V(b[0], y + h, b[1]), V(bi[0], y + h, bi[1]), V(ai[0], y + h, ai[1]), c, UP);
  }
}

/** caixa simples orientada (cor sólida) */
function boxAt(w: GeometryWriter, cx: number, cz: number, y0: number, y1: number, ux: number, uz: number, hu: number, hv: number, c: THREE.Color, top = true) {
  w.box(cx, cz, y0, y1, ux, uz, hu, hv, c, top);
}

/** arbusto redondo (icosaedro) */
const ICO = new THREE.IcosahedronGeometry(1, 0);
const ICO_POS = ICO.attributes.position;
function bush(w: GeometryWriter, x: number, y: number, z: number, r: number, c: THREE.Color) {
  for (let i = 0; i < ICO_POS.count; i += 3) {
    const p = [0, 1, 2].map((k) => V(x + ICO_POS.getX(i + k) * r, y + ICO_POS.getY(i + k) * r * 0.85, z + ICO_POS.getZ(i + k) * r));
    const cen = p[0].clone().add(p[1]).add(p[2]).divideScalar(3).sub(V(x, y, z));
    w.tri(p[0], p[1], p[2], c, cen);
  }
}

/** cilindro vertical (tanques, chaminés, colunas) */
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

// ------------------------------------------------------------ peças de fachada

/** posição (ponto na parede, direção ao longo, normal) do centro do vão k */
function bayFrame(l: WallLayout, k: number, bay: number) {
  const dx = (l.b[0] - l.a[0]) / l.len;
  const dz = (l.b[1] - l.a[1]) / l.len;
  const s = l.margin + (k + 0.5) * bay;
  return { x: l.a[0] + dx * s, z: l.a[1] + dz * s, dx, dz };
}

/** toldo listrado sobre o vão (comércio) */
function awning(ctx: Ctx, l: WallLayout, k: number, y: number, c1: THREE.Color, c2: THREE.Color) {
  const w = ctx.w.detail;
  const bay = BAY[ctx.style];
  const f = bayFrame(l, k, bay);
  const half = bay / 2 - 0.12;
  const depth = 1.15;
  const drop = 0.55;
  const strips = 6;
  for (let i = 0; i < strips; i++) {
    const s0 = -half + (i / strips) * half * 2;
    const s1 = -half + ((i + 1) / strips) * half * 2;
    const c = i % 2 ? c2 : c1;
    const P = (s: number, out: number, yy: number) => V(f.x + f.dx * s + l.ox * out, yy, f.z + f.dz * s + l.oz * out);
    // pano inclinado
    w.quad(P(s0, 0.05, y), P(s1, 0.05, y), P(s1, depth, y - drop), P(s0, depth, y - drop), c, V(l.ox, 1.5, l.oz));
    // franja (valance)
    w.quad(P(s0, depth, y - drop), P(s1, depth, y - drop), P(s1, depth, y - drop - 0.22), P(s0, depth, y - drop - 0.22), c, V(l.ox, 0, l.oz));
  }
  // laterais
  for (const s of [-half, half]) {
    const P = (out: number, yy: number) => V(f.x + f.dx * s + l.ox * out, yy, f.z + f.dz * s + l.oz * out);
    w.tri(P(0.05, y), P(depth, y - drop), P(depth, y - drop - 0.22), c1, V(f.dx * Math.sign(s), 0, f.dz * Math.sign(s)));
  }
}

/** sacada: laje + guarda-corpo */
function balcony(ctx: Ctx, l: WallLayout, k: number, y: number, slab: THREE.Color, rail: THREE.Color) {
  const w = ctx.w.detail;
  const bay = BAY[ctx.style];
  const f = bayFrame(l, k, bay);
  const hu = bay * 0.42;
  const d = 1.0;
  const cx = f.x + l.ox * (d / 2);
  const cz = f.z + l.oz * (d / 2);
  boxAt(w, cx, cz, y - 0.16, y, f.dx, f.dz, hu, d / 2, slab);
  // guarda-corpo frontal + laterais
  boxAt(w, f.x + l.ox * (d - 0.03), f.z + l.oz * (d - 0.03), y, y + 0.95, f.dx, f.dz, hu, 0.03, rail);
  for (const s of [-1, 1])
    boxAt(w, f.x + f.dx * hu * s + l.ox * (d / 2), f.z + f.dz * hu * s + l.oz * (d / 2), y, y + 0.95, f.dx, f.dz, 0.03, d / 2, rail);
}

/** floreira sob a janela */
function flowerBox(ctx: Ctx, l: WallLayout, k: number, y: number) {
  const w = ctx.w.detail;
  const f = bayFrame(l, k, BAY[ctx.style]);
  const cx = f.x + l.ox * 0.16;
  const cz = f.z + l.oz * 0.16;
  boxAt(w, cx, cz, y - 0.22, y, f.dx, f.dz, 0.6, 0.15, PAL.planter);
  const flower = pick(PAL.flowers, ctx.rng());
  for (let i = -2; i <= 2; i++) bush(w, cx + f.dx * i * 0.24, y + 0.06, cz + f.dz * i * 0.24, 0.13, i % 2 ? flower : PAL.bushes[0]);
}

/** cobertura de entrada (marquise) */
function canopy(ctx: Ctx, l: WallLayout, k: number, c: THREE.Color) {
  const w = ctx.w.detail;
  const f = bayFrame(l, k, BAY[ctx.style]);
  boxAt(w, f.x + l.ox * 0.45, f.z + l.oz * 0.45, ctx.gMax + 2.6, ctx.gMax + 2.75, f.dx, f.dz, 0.85, 0.45, c);
}

/** placa da loja sobre o toldo */
function signBoard(ctx: Ctx, l: WallLayout, y: number, c: THREE.Color) {
  const w = ctx.w.detail;
  const mx = (l.a[0] + l.b[0]) / 2;
  const mz = (l.a[1] + l.b[1]) / 2;
  const dx = (l.b[0] - l.a[0]) / l.len;
  const dz = (l.b[1] - l.a[1]) / l.len;
  const hu = Math.min(l.len * 0.32, 4);
  boxAt(w, mx + l.ox * 0.08, mz + l.oz * 0.08, y, y + 0.55, dx, dz, hu, 0.08, c);
  // "letreiro" claro
  boxAt(w, mx + l.ox * 0.17, mz + l.oz * 0.17, y + 0.17, y + 0.38, dx, dz, hu * 0.7, 0.02, PAL.white);
}

// ----------------------------------------------------------------- telhados

/** telhado de 4 ou 2 águas com espessura, beiral e testeira */
function pitchedRoof(w: GeometryWriter, r: OrientedRect, top: number, roofC: THREE.Color, wallC: THREE.Color, hip: boolean, pitch = 0.5, eaves = true) {
  const o = eaves ? 0.45 : 0.08;
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
  const darker = roofC.clone().multiplyScalar(0.72);
  if (hip) {
    const rl = Math.max(0, L - W);
    const R1 = P(-rl, 0, top + h);
    const R2 = P(rl, 0, top + h);
    w.quad(A, B, R2, R1, roofC, facing([A, B, R2, R1]));
    w.quad(Cc, D, R1, R2, roofC, facing([Cc, D, R1, R2]));
    w.tri(B, Cc, R2, roofC, facing([B, Cc, R2]));
    w.tri(D, A, R1, roofC, facing([D, A, R1]));
  } else {
    const R1 = P(-(L + o), 0, top + h);
    const R2 = P(L + o, 0, top + h);
    w.quad(A, B, R2, R1, roofC, facing([A, B, R2, R1]));
    w.quad(Cc, D, R1, R2, roofC, facing([Cc, D, R1, R2]));
    for (const s of [-1, 1]) {
      // empena + face grossa do telhado na ponta
      w.tri(P(s * L, -W, top), P(s * L, W, top), P(s * L, 0, top + h - o * pitch * 0.4), wallC, V(ux * s, 0, uz * s));
      const e1 = s < 0 ? A : B;
      const e2 = s < 0 ? D : Cc;
      const rr = s < 0 ? R1 : R2;
      w.tri(e1.clone().setY(e1.y - 0.18), e1, rr, darker, V(ux * s, 0, uz * s));
      w.tri(e2, e2.clone().setY(e2.y - 0.18), rr, darker, V(ux * s, 0, uz * s));
    }
  }
  if (!eaves) return;
  // testeira (espessura do telhado) + forro claro sob o beiral
  const ring = [A, B, Cc, D];
  const soffit = PAL.white;
  for (let i = 0; i < 4; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % 4];
    const out = p.clone().add(q).multiplyScalar(0.5).sub(center).setY(0);
    w.quad(p.clone().setY(yb - 0.18), q.clone().setY(yb - 0.18), q, p, darker, out);
    const inset = (pt: THREE.Vector3) => {
      const lx = (pt.x - cx) * ux + (pt.z - cz) * uz;
      const lz = (pt.x - cx) * vxx + (pt.z - cz) * vzz;
      return P(Math.sign(lx) * L, Math.sign(lz) * W, top - 0.02);
    };
    w.quad(inset(p), inset(q), q.clone().setY(yb - 0.18), p.clone().setY(yb - 0.18), soffit, V(0, -1, 0));
  }
}

/** telhado em dente de serra (galpões) */
function sawtoothRoof(w: GeometryWriter, r: OrientedRect, top: number, roofC: THREE.Color, glassC: THREE.Color) {
  const teeth = Math.max(2, Math.floor((r.hl * 2) / 5));
  const tw = (r.hl * 2) / teeth;
  const h = Math.min(2.4, tw * 0.5);
  const vxx = -r.uz;
  const vzz = r.ux;
  const P = (su: number, sv: number, y: number) => V(r.cx + r.ux * su + vxx * sv, y, r.cz + r.uz * su + vzz * sv);
  for (let i = 0; i < teeth; i++) {
    const s0 = -r.hl + i * tw;
    const s1 = s0 + tw;
    // água inclinada
    w.quad(P(s0, -r.hw, top), P(s0, r.hw, top), P(s1, r.hw, top + h), P(s1, -r.hw, top + h), roofC, V(-r.ux, 1, -r.uz));
    // face vertical envidraçada
    w.quad(P(s1, -r.hw, top), P(s1, r.hw, top), P(s1, r.hw, top + h), P(s1, -r.hw, top + h), glassC, V(r.ux, 0, r.uz));
    // laterais triangulares
    for (const sv of [-r.hw, r.hw]) w.tri(P(s0, sv, top), P(s1, sv, top), P(s1, sv, top + h), roofC, V(vxx * Math.sign(sv), 0, vzz * Math.sign(sv)));
  }
}

// ------------------------------------------------------------------ prédios

export interface BuildingStyle {
  category: BuildingCategory;
  wall: THREE.Color;
  trim: THREE.Color;
  roof: THREE.Color;
  facade: number;
  seed: number;
}

export function styleFor(b: Building): BuildingStyle {
  const seed = b.generated ? hashId(b.lotId.length * 7919 + hashCode(b.lotId)) : hashId(b.osmId);
  const rng = mulberry32(seed);
  const cat = categoryOf(b);
  const tall = b.levels >= 4 || b.type === 'apartments';
  let wall: THREE.Color;
  let roof: THREE.Color = PAL.roofFlat;
  let facade: number;
  switch (cat) {
    case 'commercial':
      wall = pick(PAL.comWalls, rng());
      facade = FacadeStyle.commercial;
      break;
    case 'industrial':
      wall = pick(PAL.indWalls, rng());
      roof = pick(PAL.indRoofs, rng());
      facade = FacadeStyle.industrial;
      break;
    case 'institutional':
      wall = pick(PAL.instWalls, rng());
      facade = FacadeStyle.institutional;
      break;
    case 'religious':
      wall = PAL.church;
      roof = PAL.resRoofs[0];
      facade = FacadeStyle.plain;
      break;
    default:
      wall = tall ? pick(PAL.aptWalls, rng()) : pick(PAL.resWalls, rng());
      roof = pick(PAL.resRoofs, rng() * 0.999);
      facade = tall ? FacadeStyle.apartment : FacadeStyle.house;
  }
  const trim = cat === 'religious' ? PAL.churchTrim : pick(PAL.trims, rng());
  return { category: cat, wall, trim, roof, facade, seed: seed % 1000 };
}

/** Escreve o prédio (corpo + telhado + peças) nos escritores. */
export function writeBuilding(ws: BuildingWriters, b: Building, hf: HeightField, detail: Detail, front?: FrontTest) {
  const st = styleFor(b);
  const rng = mulberry32(st.seed * 7 + 13);
  const { gMin, gMax } = groundRange(b, hf);
  const base = gMin - 1.2;
  const area = b.area || polygonArea(b.outer);
  const rect = minAreaRect(b.outer);
  const rectangular = area / (4 * rect.hl * rect.hw) > 0.82 && !b.holes?.length;
  const cat = st.category;
  const levels = Math.max(1, Math.round(b.levels));
  const top = gMax + Math.max(b.height, levels * FLOOR_H);
  const ctx: Ctx = {
    w: ws,
    rng,
    gMax,
    topV: top - gMax,
    seed: st.facade === FacadeStyle.plain ? 0 : 0.05 + st.seed / 1050,
    trim: st.trim,
    style: st.facade,
    detail,
  };
  const frontOf = (l: WallLayout) => !!front?.((l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2, l.ox, l.oz);

  if (cat === 'religious' && rectangular) return writeChurch(ws, b, rect, base, top, gMax, st, detail);

  // corpo: retangular = octógono chanfrado; senão o polígono real
  const box: Box = { cx: rect.cx, cz: rect.cz, ux: rect.ux, uz: rect.uz, hu: rect.hl, hv: rect.hw };
  const ring = rectangular ? chamferRing(box, Math.min(0.45, rect.hw * 0.12)) : orientCCW(b.outer);
  let frontCount = 0;
  const walls = writeWalls(ctx, ring, base, top, st.wall, (_i, l) => {
    const f = l.len > 3 && frontOf(l);
    if (f) frontCount++;
    return f;
  });
  // sem frente detectada: a parede mais longa vira frente (peças continuam visíveis)
  if (!frontCount && walls.length) {
    const longest = walls.reduce((a, l) => (l.len > a.len ? l : a));
    longest.front = true;
  }
  for (const h of b.holes ?? []) writeWalls(ctx, orientCCW(h).reverse(), base, top, st.wall, () => false);

  const pitchedOk = rectangular && rect.hw < 14 && area < 900;
  const d = ws.detail;

  if (cat === 'industrial') {
    if (rectangular && rect.hl > 7 && detail === 'high') {
      sawtoothRoof(d, rect, top, st.roof, PAL.glassRail);
      cap(d, ring, top - 0.01, st.roof);
    } else if (pitchedOk) pitchedRoof(d, rect, top, st.roof, st.wall, false, 0.22, detail === 'high');
    else {
      cap(d, ring, top, st.roof);
      parapet(d, ring, top, 0.6, st.wall, st.wall);
    }
    if (detail === 'high') {
      // portão com marquise, chaminé listrada e tanques
      for (const l of walls) if (l.front && l.bays) canopy({ ...ctx, style: FacadeStyle.industrial }, l, Math.floor(l.bays / 2), PAL.metal);
      if (rng() < 0.45 && rectangular) {
        const sx = rect.cx + rect.ux * rect.hl * 0.6;
        const sz = rect.cz + rect.uz * rect.hl * 0.6;
        const ch = top + 6 + rng() * 6;
        cylinder(d, sx, sz, top, ch, 0.55, PAL.metal, 8, PAL.dark);
        cylinder(d, sx, sz, ch - 2.2, ch - 1.2, 0.58, PAL.chimneyRed, 8);
      }
      if (rng() < 0.4 && rectangular) {
        const tx = rect.cx - rect.ux * rect.hl * 0.55;
        const tz = rect.cz - rect.uz * rect.hl * 0.55;
        cylinder(d, tx, tz, top, top + 3.2, Math.min(1.6, rect.hw * 0.4), PAL.white, 12, PAL.metal);
      }
    }
    return;
  }

  if (detail === 'low') {
    if ((cat === 'residential' && levels <= 2 && pitchedOk) || (cat === 'commercial' && levels === 1 && pitchedOk && rng() < 0.3))
      pitchedRoof(d, rect, top, st.roof, st.wall, true, 0.5, false);
    else cap(d, ring, top, cat === 'residential' && levels <= 3 ? PAL.garden : PAL.roofFlat);
    return;
  }

  // ---- faixas de laje (maquete) em prédios altos e institucionais
  if ((st.facade === FacadeStyle.apartment || st.facade === FacadeStyle.institutional) && rectangular) {
    const bandC = pick(PAL.aptBands, rng());
    for (let f = 1; f < levels; f++) band(d, ring, gMax + f * FLOOR_H - 0.12, gMax + f * FLOOR_H + 0.08, 0.1, bandC);
  }

  // ---- peças da fachada frontal
  const bay = BAY[st.facade];
  for (const l of walls) {
    if (!l.bays) continue;
    if (cat === 'commercial' && l.front) {
      const c1 = pick(PAL.awnings, rng());
      for (let k = 0; k < l.bays; k++) awning(ctx, l, k, gMax + 3.0, c1, PAL.white);
      if (levels === 1) signBoard(ctx, l, top + 0.05, c1);
      else signBoard(ctx, l, gMax + 3.15, c1);
    }
    if (st.facade === FacadeStyle.house && l.front) {
      // porta no vão do meio com marquise; floreiras em parte das janelas
      canopy(ctx, l, Math.floor(l.bays / 2), st.trim);
      for (let f = levels > 1 ? 1 : 0; f < levels; f++)
        for (let k = 0; k < l.bays; k++) {
          if (f === 0 && k === Math.floor(l.bays / 2)) continue;
          if (rng() < 0.45) flowerBox(ctx, l, k, gMax + f * FLOOR_H + 0.92);
        }
      if (levels >= 2) for (let k = 0; k < l.bays; k++) if (rng() < 0.3) balcony(ctx, l, k, gMax + FLOOR_H + 0.02, st.wall, st.trim);
    }
    if (st.facade === FacadeStyle.apartment && l.len > 6) {
      for (let f = 1; f < levels; f++)
        for (let k = 0; k < l.bays; k++) if ((k + f) % 2 === 0 && l.front) balcony(ctx, l, k, gMax + f * FLOOR_H + 0.02, PAL.white, PAL.glassRail);
    }
    if (st.facade === FacadeStyle.institutional && l.front) canopy(ctx, l, Math.floor(l.bays / 2), PAL.white);
    void bay;
  }

  // ---- cobertura
  const pitched = (cat === 'residential' && levels <= 2 && pitchedOk && rng() < 0.82) || (cat === 'commercial' && levels === 1 && pitchedOk && rng() < 0.3);
  if (pitched) {
    pitchedRoof(d, rect, top, st.roof, st.wall, rng() < 0.6, 0.5, true);
    if (rng() < 0.45) {
      const sx = rect.cx + rect.ux * rect.hl * 0.45 - rect.uz * rect.hw * 0.35;
      const sz = rect.cz + rect.uz * rect.hl * 0.45 + rect.ux * rect.hw * 0.35;
      boxAt(d, sx, sz, top, top + Math.min(rect.hw * 0.5, 2.6) + 0.8, rect.ux, rect.uz, 0.32, 0.32, st.wall);
      boxAt(d, sx, sz, top + Math.min(rect.hw * 0.5, 2.6) + 0.8, top + Math.min(rect.hw * 0.5, 2.6) + 0.95, rect.ux, rect.uz, 0.4, 0.4, PAL.dark);
    }
    return;
  }
  // laje plana: cornija + parapeito
  if (rectangular) band(d, ring, top - 0.05, top + 0.18, 0.12, PAL.white);
  const garden = cat === 'residential' && levels <= 4 && rng() < 0.75;
  cap(d, ring, top + 0.01, garden ? PAL.garden : PAL.roofFlat, b.holes);
  parapet(d, ring, top + 0.18, 0.55, st.wall, PAL.parapet);
  // equipamentos / jardim na cobertura
  const rx = rect.ux;
  const rz = rect.uz;
  const inside = (fu: number, fv: number) => [rect.cx + rx * rect.hl * fu - rz * rect.hw * fv, rect.cz + rz * rect.hl * fu + rx * rect.hw * fv] as const;
  if (garden) {
    const n = 2 + Math.floor(rng() * 4);
    for (let i = 0; i < n; i++) {
      const [x, z] = inside((rng() - 0.5) * 1.3, (rng() - 0.5) * 1.3);
      bush(d, x, top + 0.35, z, 0.35 + rng() * 0.35, pick(PAL.bushes, rng()));
    }
    const [px, pz] = inside(-0.55, 0.55);
    boxAt(d, px, pz, top, top + 0.45, rx, rz, 0.7, 0.3, PAL.planter);
    bush(d, px, top + 0.55, pz, 0.32, pick(PAL.flowers, rng()));
  }
  if (rng() < 0.6) {
    const [x, z] = inside(0.45, -0.35);
    cylinder(d, x, z, top, top + 1.3, 0.55, PAL.tank, 8, PAL.white);
  }
  const acs = cat === 'commercial' || st.facade === FacadeStyle.apartment ? 1 + Math.floor(rng() * 3) : rng() < 0.4 ? 1 : 0;
  for (let i = 0; i < acs; i++) {
    const [x, z] = inside(-0.4 + i * 0.3, -0.2);
    boxAt(d, x, z, top, top + 0.55, rx, rz, 0.45, 0.35, PAL.white);
  }
  if (st.facade === FacadeStyle.apartment) {
    // casa de máquinas
    const [x, z] = inside(0, 0.2);
    boxAt(d, x, z, top, top + 2.6, rx, rz, Math.min(2.2, rect.hl * 0.3), Math.min(1.8, rect.hw * 0.4), st.wall);
    boxAt(d, x, z, top + 2.6, top + 2.8, rx, rz, Math.min(2.4, rect.hl * 0.32), Math.min(2, rect.hw * 0.42), PAL.white);
  }
  if (st.facade === FacadeStyle.institutional) {
    // mastro com bandeira
    const [x, z] = inside(0.7, 0.7);
    cylinder(d, x, z, top, top + 5, 0.05, PAL.metal, 5);
    boxAt(d, x + rx * 0.6, z + rz * 0.6, top + 4.1, top + 4.9, rx, rz, 0.6, 0.02, C('#2f9e44'));
  }
}

/** Igreja barroca estilizada: nave de 2 águas + torre(s) na fachada. */
function writeChurch(ws: BuildingWriters, b: Building, r: OrientedRect, base: number, top: number, ground: number, st: BuildingStyle, detail: Detail) {
  const ctx: Ctx = { w: ws, rng: mulberry32(st.seed), gMax: ground, topV: top - ground, seed: 0, trim: st.trim, style: FacadeStyle.plain, detail };
  const box: Box = { cx: r.cx, cz: r.cz, ux: r.ux, uz: r.uz, hu: r.hl, hv: r.hw };
  writeWalls(ctx, rectRing(box), base, top, st.wall, () => false, false);
  pitchedRoof(ws.detail, r, top, st.roof, st.wall, false, 0.7, detail === 'high');
  if (detail === 'low') return;
  const w = ws.walls;
  const d = ws.detail;
  const towers = b.area > 280 ? 2 : 1;
  const ts = Math.min(r.hw * (towers === 2 ? 0.42 : 0.6), 4.2);
  const towerTop = top + Math.max(8, r.hw * 1.2);
  const vxx = -r.uz;
  const vzz = r.ux;
  const offsets = towers === 2 ? [-(r.hw - ts), r.hw - ts] : [0];
  w.style = [st.trim.r, st.trim.g, st.trim.b, FacadeStyle.plain * 2];
  for (const off of offsets) {
    const cx = r.cx - r.ux * (r.hl - ts) + vxx * off;
    const cz = r.cz - r.uz * (r.hl - ts) + vzz * off;
    w.box(cx, cz, ground - 1, towerTop, r.ux, r.uz, ts, ts, st.wall);
    boxAt(d, cx, cz, towerTop - 3.2, towerTop - 2.95, r.ux, r.uz, ts * 1.08, ts * 1.08, PAL.white);
    boxAt(d, cx, cz, towerTop, towerTop + 0.45, r.ux, r.uz, ts * 1.14, ts * 1.14, st.trim);
    // sineira (vão escuro)
    for (const s of [-1, 1]) boxAt(d, cx + vxx * s * ts * 1.001, cz + vzz * s * ts * 1.001, towerTop - 2.6, towerTop - 0.6, r.ux, r.uz, ts * 0.45, 0.02, PAL.dark);
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
      const f = p0.clone().add(p1).multiplyScalar(0.5).sub(V(cx, towerTop, cz)).setY(0.5);
      d.tri(p0, p1, apex, st.trim, f);
    }
    // cruz
    boxAt(d, apex.x, apex.z, apex.y, apex.y + 1.2, r.ux, r.uz, 0.06, 0.06, C('#d9b44a'));
    boxAt(d, apex.x, apex.z, apex.y + 0.7, apex.y + 0.82, r.ux, r.uz, 0.35, 0.06, C('#d9b44a'));
  }
  // porta principal
  const fx = r.cx - r.ux * (r.hl + 0.02);
  const fz = r.cz - r.uz * (r.hl + 0.02);
  boxAt(d, fx, fz, ground, ground + 3.6, vxx, vzz, 1.0, 0.05, C('#6b3f24'));
}
