import * as THREE from 'three';
import type { Building, Ring, Vec2 } from '../../data/types';
import type { HeightField } from '../HeightField';
import { hashId, mulberry32, polygonArea } from '../geo';
import { GeometryWriter, UP } from './GeometryWriter';
import { PALETTE, color, osmColour, pick } from './palette';

export type Detail = 'high' | 'low';

/** Um escritor por material — viram malhas separadas por chunk. */
export interface BuildingWriters {
  walls: GeometryWriter;
  roofClay: GeometryWriter;
  roofGrey: GeometryWriter;
  roofFlat: GeometryWriter;
}
export const WRITER_KEYS = ['walls', 'roofClay', 'roofGrey', 'roofFlat'] as const;
export type WriterKey = (typeof WRITER_KEYS)[number];

export function createWriters(): BuildingWriters {
  return { walls: new GeometryWriter(), roofClay: new GeometryWriter(), roofGrey: new GeometryWriter(), roofFlat: new GeometryWriter() };
}

/** Teste "esta parede dá para a rua?" (ponto médio + normal externa) */
export type FrontTest = (mx: number, mz: number, ox: number, oz: number) => boolean;

interface OrientedRect {
  cx: number;
  cz: number;
  /** eixo do lado longo */
  ux: number;
  uz: number;
  /** meia-largura ao longo de u (lado longo) e v */
  hl: number;
  hw: number;
}

/** códigos de estilo de fachada (shader) */
export const FacadeStyle = { house: 0, commercial: 1, apartment: 2, industrial: 3, plain: 4 } as const;

const FLAT_TYPES = new Set([
  'apartments',
  'industrial',
  'warehouse',
  'retail',
  'supermarket',
  'office',
  'hospital',
  'school',
  'university',
  'parking',
  'stadium',
  'hotel',
  'public',
  'civic',
  'government',
]);
const CHURCH_TYPES = new Set(['church', 'cathedral', 'chapel']);
const INDUSTRIAL = new Set(['industrial', 'warehouse', 'garage', 'garages', 'shed', 'roof', 'parking', 'carport']);
const APARTMENT = new Set(['apartments', 'office', 'hotel', 'hospital', 'school', 'university', 'public', 'civic', 'government']);

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

export interface BuildingStyle {
  wall: THREE.Color;
  trim: THREE.Color;
  roof: THREE.Color;
  roofWriter: WriterKey;
  roofKind: 'flat' | 'hip' | 'gable' | 'church';
  facade: number;
  seed: number;
  rect?: OrientedRect;
  tank: boolean;
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

const TRIMS = ['#2f5d8a', '#2e6b4f', '#c9961e', '#6b3f24', '#8e2f2a', '#3c4f6b', '#f4f1ea', '#1f4a5e'];

export function styleFor(b: Building): BuildingStyle {
  const seed = b.generated ? hashId(b.lotId.length * 7919 + hashCode(b.lotId)) : hashId(b.osmId);
  const rng = mulberry32(seed);
  const isChurch = CHURCH_TYPES.has(b.type);
  const commercial = b.type === 'commercial' || b.type === 'retail' || b.type === 'supermarket' || !!b.pois?.length;
  const wall = isChurch ? color(PALETTE.church) : color(pick(commercial ? PALETTE.wallsCommercial : PALETTE.walls, rng()));
  const trim = color(isChurch ? PALETTE.churchTrim : pick(TRIMS, rng()));
  let roofKind: BuildingStyle['roofKind'] = 'flat';
  let rect: OrientedRect | undefined;
  const area = b.area || polygonArea(b.outer);
  const shape = b.roofShape;
  if (shape !== 'flat') {
    rect = minAreaRect(b.outer);
    const rectangularity = area / (4 * rect.hl * rect.hw);
    if (isChurch && rectangularity > 0.6) roofKind = 'church';
    else if (shape === 'gabled') roofKind = 'gable';
    else if (shape === 'hipped' || shape === 'pyramidal') roofKind = 'hip';
    else if (FLAT_TYPES.has(b.type) || (commercial && b.levels >= 3) || b.levels >= 5) roofKind = 'flat';
    else if (rectangularity > 0.78 && area < 1200 && rect.hw < 16) roofKind = rng() < 0.65 ? 'hip' : 'gable';
  } else rect = minAreaRect(b.outer);

  let roofWriter: WriterKey = 'roofFlat';
  let roof = color('#ffffff');
  if (roofKind !== 'flat') {
    const grey = !b.roofColour && rng() > 0.85;
    roofWriter = grey ? 'roofGrey' : 'roofClay';
    // textura normalizada: cor final vem da paleta (variação entre telhados)
    roof = b.roofColour ? osmColour(b.roofColour, PALETTE.roofsCeramic[0]) : color(pick(grey ? PALETTE.roofsGray : PALETTE.roofsCeramic, rng()));
  } else {
    roof = color(pick(PALETTE.roofsFlat, rng()));
  }
  const facade = isChurch
    ? FacadeStyle.plain
    : INDUSTRIAL.has(b.type)
      ? FacadeStyle.industrial
      : commercial
        ? FacadeStyle.commercial
        : APARTMENT.has(b.type) || b.levels >= 4
          ? FacadeStyle.apartment
          : FacadeStyle.house;
  return { wall, trim, roof, roofWriter, roofKind, facade, seed, rect, tank: roofKind === 'flat' && area < 900 && rng() < 0.55 };
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

/** Escreve o prédio nos escritores (um por material). */
export function writeBuilding(ws: BuildingWriters, b: Building, hf: HeightField, detail: Detail, front?: FrontTest) {
  const st = styleFor(b);
  const { gMin, gMax } = groundRange(b, hf);
  const base = gMin - 1.2; // afunda para não flutuar em declives
  const top = gMax + b.height;
  const facadeTop = top - gMax;
  const seedF = st.facade === FacadeStyle.plain ? 0 : 0.05 + (st.seed % 1000) / 1050;
  const w = ws.walls;

  // ---- paredes
  const rings: Ring[] = [b.outer, ...(b.holes ?? [])];
  for (const ring of rings) {
    let u = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x0, z0] = ring[i];
      const [x1, z1] = ring[(i + 1) % ring.length];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.05) continue;
      const ox = (z1 - z0) / len;
      const oz = -(x1 - x0) / len;
      const isFront = ring === b.outer && len > 3 && !!front?.((x0 + x1) / 2, (z0 + z1) / 2, ox, oz);
      w.style = [st.trim.r, st.trim.g, st.trim.b, st.facade * 2 + (isFront ? 1 : 0)];
      const s = len >= 2 ? seedF : 0;
      const vb = base - gMax;
      // começa a fachada num múltiplo do vão para janelas alinhadas por parede
      const u0 = Math.ceil(u / 3) * 3 + 0.4;
      w.quad(
        V(x0, base, z0),
        V(x1, base, z1),
        V(x1, top, z1),
        V(x0, top, z0),
        st.wall,
        V(ox, 0, oz),
        [u0, base, u0 + len, base, u0 + len, top, u0, top],
        [u0, vb, facadeTop, s, u0 + len, vb, facadeTop, s, u0 + len, facadeTop, facadeTop, s, u0, facadeTop, facadeTop, s],
      );
      u = u0 + len;
    }
  }
  w.style = [st.trim.r, st.trim.g, st.trim.b, FacadeStyle.plain * 2];

  // ---- telhado
  const roofW = ws[st.roofWriter];
  const kind = detail === 'low' && st.roofKind !== 'flat' ? 'lowpitch' : st.roofKind;
  if (kind === 'flat' || !st.rect) {
    writeFlatCap(ws.roofFlat, b.outer, b.holes, top, st.roof);
    if (detail === 'high') {
      if (b.area > 60 && b.levels >= 2) writeParapet(w, b.outer, top, st.wall);
      if (st.tank) {
        const r = st.rect!;
        const rng = mulberry32(st.seed ^ 77);
        const ox = (rng() - 0.5) * r.hl;
        const oz = (rng() - 0.5) * r.hw;
        ws.roofFlat.box(r.cx + r.ux * ox - r.uz * oz, r.cz + r.uz * ox + r.ux * oz, top, top + 1.5, r.ux, r.uz, 1.0, 1.0, color(PALETTE.waterTank));
      }
    }
  } else if (kind === 'lowpitch') {
    // LOD baixo: telhado em 4 águas sem beiral (poucos triângulos, mesma silhueta)
    writePitchedRoof(roofW, w, st.rect, top, st.roof, st.trim, true, 0.55, false);
  } else if (kind === 'hip' || kind === 'gable') {
    writePitchedRoof(roofW, w, st.rect, top, st.roof, st.wall, kind === 'hip', 0.55, detail === 'high');
  } else if (kind === 'church') {
    writeChurch(ws, b, st.rect, top, gMax, st, detail);
  }
}

function writeFlatCap(w: GeometryWriter, outer: Ring, holes: Ring[] | undefined, y: number, c: THREE.Color) {
  const contour = outer.map(([x, z]) => new THREE.Vector2(x, z));
  const hs = (holes ?? []).map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
  const tris = THREE.ShapeUtils.triangulateShape(contour, hs);
  const all = contour.concat(...hs);
  for (const [a, b2, c2] of tris) {
    const p0 = all[a];
    const p1 = all[b2];
    const p2 = all[c2];
    w.tri(V(p0.x, y, p0.y), V(p1.x, y, p1.y), V(p2.x, y, p2.y), c, UP);
  }
}

function writeParapet(w: GeometryWriter, ring: Ring, top: number, c: THREE.Color) {
  const h = 0.7;
  let u = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % ring.length];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const out = V(z1 - z0, 0, -(x1 - x0));
    const uv = [u, top, u + len, top, u + len, top + h, u, top + h];
    w.quad(V(x0, top, z0), V(x1, top, z1), V(x1, top + h, z1), V(x0, top + h, z0), c, out, uv);
    w.quad(V(x0, top, z0), V(x1, top, z1), V(x1, top + h, z1), V(x0, top + h, z0), c, out.clone().negate(), uv);
    u += len;
  }
}

/**
 * Telhado de 4 ou 2 águas sobre o retângulo orientado, com beiral.
 * UV alinhado: u ao longo do beiral, v descendo a água (fileiras de telha).
 */
function writePitchedRoof(
  roof: GeometryWriter,
  walls: GeometryWriter,
  r: OrientedRect,
  top: number,
  roofC: THREE.Color,
  wallC: THREE.Color,
  hip: boolean,
  pitch: number,
  eaves: boolean,
) {
  const o = eaves ? 0.45 : 0.05; // beiral
  const { cx, cz, ux, uz } = r;
  const vx = -uz;
  const vz = ux;
  const L = r.hl;
  const W = r.hw;
  const h = Math.min(W * pitch, 7);
  const k = Math.sqrt(1 + (h / W) ** 2); // fator da inclinação para o v
  const P = (su: number, sv: number, y: number) => V(cx + ux * su + vx * sv, y, cz + uz * su + vz * sv);
  const yb = top - o * (h / W);
  const A = P(-(L + o), -(W + o), yb);
  const B = P(L + o, -(W + o), yb);
  const C = P(L + o, W + o, yb);
  const D = P(-(L + o), W + o, yb);
  const center = V(cx, top, cz);
  const facing = (pts: THREE.Vector3[]) => {
    const m = V(0, 0, 0);
    pts.forEach((p) => m.add(p));
    return m.divideScalar(pts.length).sub(center).normalize().add(V(0, 0.3, 0));
  };
  // coordenadas locais (su, sv) de um ponto
  const loc = (p: THREE.Vector3) => [(p.x - cx) * ux + (p.z - cz) * uz, (p.x - cx) * vx + (p.z - cz) * vz];
  // uv para água longa (u = su, v = |sv| * k) e para água de ponta (u = sv, v = |su| * k)
  const uvLong = (...ps: THREE.Vector3[]) => ps.flatMap((p) => {
    const [su, sv] = loc(p);
    return [su, (W + o - Math.abs(sv)) * k];
  });
  const uvEnd = (...ps: THREE.Vector3[]) => ps.flatMap((p) => {
    const [su, sv] = loc(p);
    return [sv, (L + o - Math.abs(su)) * k];
  });

  if (hip) {
    const rl = Math.max(0, L - W);
    const R1 = P(-rl, 0, top + h);
    const R2 = P(rl, 0, top + h);
    roof.quad(A, B, R2, R1, roofC, facing([A, B, R2, R1]), uvLong(A, B, R2, R1));
    roof.quad(C, D, R1, R2, roofC, facing([C, D, R1, R2]), uvLong(C, D, R1, R2));
    roof.tri(B, C, R2, roofC, facing([B, C, R2]), uvEnd(B, C, R2));
    roof.tri(D, A, R1, roofC, facing([D, A, R1]), uvEnd(D, A, R1));
  } else {
    const R1 = P(-(L + o), 0, top + h);
    const R2 = P(L + o, 0, top + h);
    roof.quad(A, B, R2, R1, roofC, facing([A, B, R2, R1]), uvLong(A, B, R2, R1));
    roof.quad(C, D, R1, R2, roofC, facing([C, D, R1, R2]), uvLong(C, D, R1, R2));
    // empenas (triângulos de parede)
    for (const s of [-1, 1]) {
      const g1 = P(s * L, -W, top);
      const g2 = P(s * L, W, top);
      const g3 = P(s * L, 0, top + h - o * pitch * 0.4);
      walls.tri(g1, g2, g3, wallC, V(ux * s, 0, uz * s), [-W, top, W, top, 0, top + h]);
    }
  }

  if (!eaves) return;
  // testeira (tábua do beiral) + forro (parte de baixo do beiral)
  const fascia = color('#f4efe6');
  const ft = 0.22;
  const ring = [A, B, C, D];
  for (let i = 0; i < 4; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % 4];
    const out = p.clone().add(q).multiplyScalar(0.5).sub(center).setY(0);
    walls.quad(p.clone().setY(yb - ft), q.clone().setY(yb - ft), q, p, fascia, out);
    // forro: do topo da parede até a borda do beiral
    const pw = P(...(loc(p).map((v, j) => Math.sign(v) * (j === 0 ? L : W)) as [number, number]), top - 0.02);
    const qw = P(...(loc(q).map((v, j) => Math.sign(v) * (j === 0 ? L : W)) as [number, number]), top - 0.02);
    walls.quad(pw, qw, q.clone().setY(yb - ft), p.clone().setY(yb - ft), fascia, V(0, -1, 0));
  }
}

/** Igreja barroca simplificada: nave com 2 águas + torre(s) na fachada. */
function writeChurch(ws: BuildingWriters, b: Building, r: OrientedRect, top: number, ground: number, st: BuildingStyle, detail: Detail) {
  writePitchedRoof(ws.roofClay, ws.walls, r, top, st.roof, st.wall, false, 0.7, detail === 'high');
  if (detail === 'low') return;
  const trim = st.trim;
  const w = ws.walls;
  const towers = b.area > 280 ? 2 : 1;
  const ts = Math.min(r.hw * (towers === 2 ? 0.42 : 0.6), 4.2);
  const towerTop = top + Math.max(8, r.hw * 1.2);
  const vx = -r.uz;
  const vz = r.ux;
  const offsets = towers === 2 ? [-(r.hw - ts), r.hw - ts] : [0];
  for (const off of offsets) {
    const cx = r.cx - r.ux * (r.hl - ts) + vx * off;
    const cz = r.cz - r.uz * (r.hl - ts) + vz * off;
    w.box(cx, cz, ground - 1, towerTop, r.ux, r.uz, ts, ts, st.wall);
    // cornija e sineira
    w.box(cx, cz, towerTop - 3.2, towerTop - 2.9, r.ux, r.uz, ts * 1.08, ts * 1.08, color('#f4f1ea'));
    w.box(cx, cz, towerTop, towerTop + 0.5, r.ux, r.uz, ts * 1.14, ts * 1.14, color('#f4f1ea'));
    // cúpula/pirâmide
    const apex = V(cx, towerTop + 0.5 + ts * 1.6, cz);
    const P = (su: number, sv: number) => V(cx + r.ux * ts * su + vx * ts * sv, towerTop + 0.5, cz + r.uz * ts * su + vz * ts * sv);
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
      ws.roofGrey.tri(p0, p1, apex, trim, f, [0, 0, ts * 2, 0, ts, ts * 1.8]);
    }
  }
}
