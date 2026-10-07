import * as THREE from 'three';
import type { Building, Ring, Vec2 } from '../../data/types';
import type { HeightField } from '../HeightField';
import { hashId, mulberry32, polygonArea } from '../geo';
import { GeometryWriter, UP } from './GeometryWriter';
import { PALETTE, color, osmColour, pick } from './palette';

export type Detail = 'high' | 'low';

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
      let r: OrientedRect = {
        cx: cu * ux - cv * uz,
        cz: cu * uz + cv * ux,
        ux,
        uz,
        hl: (maxU - minU) / 2,
        hw: (maxV - minV) / 2,
      };
      if (r.hw > r.hl) r = { ...r, ux: -uz, uz: ux, hl: r.hw, hw: r.hl };
      best = r;
    }
  }
  return best!;
}

export interface BuildingStyle {
  wall: THREE.Color;
  roof: THREE.Color;
  roofKind: 'flat' | 'hip' | 'gable' | 'church';
  seed: number;
  rect?: OrientedRect;
  tank: boolean;
}

export function styleFor(b: Building): BuildingStyle {
  const seed = b.generated ? hashId(b.lotId.length * 7919 + hashCode(b.lotId)) : hashId(b.osmId);
  const rng = mulberry32(seed);
  const isChurch = CHURCH_TYPES.has(b.type);
  const commercial = b.type === 'commercial' || b.type === 'retail';
  const wall = isChurch ? color(PALETTE.church) : color(pick(commercial ? PALETTE.wallsCommercial : PALETTE.walls, rng()));
  let roofKind: BuildingStyle['roofKind'] = 'flat';
  let rect: OrientedRect | undefined;
  const area = b.area || polygonArea(b.outer);
  const shape = b.roofShape;
  if (shape === 'flat') roofKind = 'flat';
  else {
    rect = minAreaRect(b.outer);
    const rectangularity = area / (4 * rect.hl * rect.hw);
    if (isChurch && rectangularity > 0.6) roofKind = 'church';
    else if (shape === 'gabled') roofKind = 'gable';
    else if (shape === 'hipped' || shape === 'pyramidal') roofKind = 'hip';
    else if (FLAT_TYPES.has(b.type) || (commercial && b.levels >= 3) || b.levels >= 5) roofKind = 'flat';
    else if (rectangularity > 0.78 && area < 1200 && rect.hw < 16) roofKind = rng() < 0.65 ? 'hip' : 'gable';
  }
  const roof =
    roofKind === 'flat'
      ? color(pick(PALETTE.roofsFlat, rng()))
      : b.roofColour
        ? osmColour(b.roofColour, PALETTE.roofsCeramic[0])
        : color(rng() < 0.85 ? pick(PALETTE.roofsCeramic, rng()) : pick(PALETTE.roofsGray, rng()));
  rng();
  return { wall, roof, roofKind, seed, rect, tank: roofKind === 'flat' && area < 900 && rng() < 0.55 };
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

export interface BuildingSpan {
  start: number;
  count: number;
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

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

/** Escreve o prédio no writer. Retorna o intervalo de vértices (para picking). */
export function writeBuilding(w: GeometryWriter, b: Building, hf: HeightField, detail: Detail): BuildingSpan {
  const start = w.vertexCount;
  const st = styleFor(b);
  const { gMin, gMax } = groundRange(b, hf);
  const base = gMin - 1.2; // afunda para não flutuar em declives
  const top = gMax + b.height;
  const facadeTop = top - gMax;
  const seedF = 0.05 + (st.seed % 1000) / 1050;

  // paredes
  const rings: Ring[] = [b.outer, ...(b.holes ?? [])];
  const wallSeed = detail === 'high' ? seedF : seedF; // janelas também no LOD baixo (custo zero)
  for (const ring of rings) {
    let u = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x0, z0] = ring[i];
      const [x1, z1] = ring[(i + 1) % ring.length];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.05) continue;
      const outward = tmpA.set(z1 - z0, 0, -(x1 - x0));
      // paredes curtas (< 2 m) sem janelas
      const s = len >= 2 ? wallSeed : 0;
      const vb = base - gMax;
      w.quad(
        new THREE.Vector3(x0, base, z0),
        new THREE.Vector3(x1, base, z1),
        new THREE.Vector3(x1, top, z1),
        new THREE.Vector3(x0, top, z0),
        st.wall,
        outward,
        [
          [u, vb, facadeTop, s],
          [u + len, vb, facadeTop, s],
          [u + len, facadeTop, facadeTop, s],
          [u, facadeTop, facadeTop, s],
        ],
      );
      u += len;
    }
  }

  const kind = detail === 'low' && st.roofKind !== 'flat' ? 'lowpitch' : st.roofKind;
  if (kind === 'flat' || kind === 'lowpitch' || !st.rect) {
    const y = kind === 'lowpitch' && st.rect ? top + st.rect.hw * 0.25 : top;
    if (kind === 'lowpitch') {
      // LOD baixo: "bloco" do telhado com a mesma cor (silhueta parecida, poucos triângulos)
      writeFlatCap(w, b.outer, b.holes, top, st.roof);
      if (st.rect) {
        const r = st.rect;
        w.box(r.cx, r.cz, top, y, r.ux, r.uz, r.hl * 0.7, r.hw * 0.6, st.roof);
      }
    } else {
      writeFlatCap(w, b.outer, b.holes, top, st.roof);
      if (detail === 'high') {
        // platibanda simples
        if (b.area > 60 && b.levels >= 2) writeParapet(w, b.outer, top, st.wall);
        if (st.tank && st.rect) {
          const r = st.rect;
          w.box(r.cx, r.cz, top, top + 1.6, r.ux, r.uz, 1.1, 1.1, color(PALETTE.waterTank));
        }
      }
    }
  } else if (kind === 'hip' || kind === 'gable') {
    writePitchedRoof(w, st.rect, top, st.roof, st.wall, kind === 'hip');
  } else if (kind === 'church') {
    writeChurch(w, b, st.rect, top, gMax, st.roof, st.wall, detail);
  }
  return { start, count: w.vertexCount - start };
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
    w.tri(new THREE.Vector3(p0.x, y, p0.y), new THREE.Vector3(p1.x, y, p1.y), new THREE.Vector3(p2.x, y, p2.y), c, UP);
  }
}

function writeParapet(w: GeometryWriter, ring: Ring, top: number, c: THREE.Color) {
  // borda elevada de 0.6 m ao redor do telhado (só face externa + topo fino)
  const h = 0.6;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % ring.length];
    const outward = tmpB.set(z1 - z0, 0, -(x1 - x0));
    w.quad(
      new THREE.Vector3(x0, top, z0),
      new THREE.Vector3(x1, top, z1),
      new THREE.Vector3(x1, top + h, z1),
      new THREE.Vector3(x0, top + h, z0),
      c,
      outward,
    );
    // face interna (mais escura não é necessário — a luz cuida)
    w.quad(
      new THREE.Vector3(x0, top, z0),
      new THREE.Vector3(x1, top, z1),
      new THREE.Vector3(x1, top + h, z1),
      new THREE.Vector3(x0, top + h, z0),
      c,
      outward.clone().negate(),
    );
  }
}

function writePitchedRoof(
  w: GeometryWriter,
  r: OrientedRect,
  top: number,
  roofC: THREE.Color,
  wallC: THREE.Color,
  hip: boolean,
  pitch = 0.55,
) {
  const o = 0.4; // beiral
  const { cx, cz, ux, uz } = r;
  const vx = -uz;
  const vz = ux;
  const L = r.hl;
  const W = r.hw;
  const h = Math.min(W * pitch, 7);
  const P = (su: number, sv: number, y: number) => new THREE.Vector3(cx + ux * su + vx * sv, y, cz + uz * su + vz * sv);
  const yb = top - o * pitch * 0.6;
  const A = P(-(L + o), -(W + o), yb);
  const B = P(L + o, -(W + o), yb);
  const C = P(L + o, W + o, yb);
  const D = P(-(L + o), W + o, yb);
  const center = new THREE.Vector3(cx, top, cz);
  const facing = (pts: THREE.Vector3[]) => {
    const m = new THREE.Vector3();
    pts.forEach((p) => m.add(p));
    return m.divideScalar(pts.length).sub(center).normalize().add(new THREE.Vector3(0, 0.3, 0));
  };
  if (hip) {
    const rl = Math.max(0, L - W);
    const R1 = P(-rl, 0, top + h);
    const R2 = P(rl, 0, top + h);
    w.quad(A, B, R2, R1, roofC, facing([A, B, R2, R1]));
    w.quad(C, D, R1, R2, roofC, facing([C, D, R1, R2]));
    w.tri(B, C, R2, roofC, facing([B, C, R2]));
    w.tri(D, A, R1, roofC, facing([D, A, R1]));
  } else {
    const R1 = P(-(L + o), 0, top + h);
    const R2 = P(L + o, 0, top + h);
    w.quad(A, B, R2, R1, roofC, facing([A, B, R2, R1]));
    w.quad(C, D, R1, R2, roofC, facing([C, D, R1, R2]));
    // empenas (triângulos de parede)
    const g1a = P(-L, -W, top);
    const g1b = P(-L, W, top);
    const g1c = P(-L, 0, top + h - o * pitch * 0.4);
    w.tri(g1a, g1b, g1c, wallC, new THREE.Vector3(-ux, 0, -uz));
    const g2a = P(L, -W, top);
    const g2b = P(L, W, top);
    const g2c = P(L, 0, top + h - o * pitch * 0.4);
    w.tri(g2a, g2b, g2c, wallC, new THREE.Vector3(ux, 0, uz));
    // face de baixo do beiral não é desenhada (low-poly)
  }
}

/** Igreja barroca simplificada: nave com 2 águas + torre(s) na fachada. */
function writeChurch(
  w: GeometryWriter,
  b: Building,
  r: OrientedRect,
  top: number,
  ground: number,
  roofC: THREE.Color,
  wallC: THREE.Color,
  detail: Detail,
) {
  writePitchedRoof(w, r, top, roofC, wallC, false, 0.7);
  if (detail === 'low') return;
  const trim = color(PALETTE.churchTrim);
  // a fachada fica no lado do eixo longo mais próximo da rua? usamos o sentido -u
  const towers = b.area > 280 ? 2 : 1;
  const ts = Math.min(r.hw * (towers === 2 ? 0.42 : 0.6), 4.2);
  const towerTop = top + Math.max(8, r.hw * 1.2);
  const vx = -r.uz;
  const vz = r.ux;
  const offsets = towers === 2 ? [-(r.hw - ts), r.hw - ts] : [0];
  for (const off of offsets) {
    const cx = r.cx - r.ux * (r.hl - ts) + vx * off;
    const cz = r.cz - r.uz * (r.hl - ts) + vz * off;
    w.box(cx, cz, ground - 1, towerTop, r.ux, r.uz, ts, ts, wallC);
    // cornija
    w.box(cx, cz, towerTop, towerTop + 0.5, r.ux, r.uz, ts * 1.12, ts * 1.12, trim);
    // cúpula/pirâmide
    const apex = new THREE.Vector3(cx, towerTop + 0.5 + ts * 1.5, cz);
    const P = (su: number, sv: number) =>
      new THREE.Vector3(cx + r.ux * ts * su + vx * ts * sv, towerTop + 0.5, cz + r.uz * ts * su + vz * ts * sv);
    const cs: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (let i = 0; i < 4; i++) {
      const p0 = P(...cs[i]);
      const p1 = P(...cs[(i + 1) % 4]);
      const f = p0.clone().add(p1).multiplyScalar(0.5).sub(new THREE.Vector3(cx, towerTop, cz)).setY(0.5);
      w.tri(p0, p1, apex, trim, f);
    }
  }
}
