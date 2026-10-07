/**
 * Gera uma cidade fictícia planejada ("Vila Aurora") no mesmo formato
 * `CityData` que o jogo consome (antes vindo do OSM).
 *
 *   npm run generate-city            -> public/data/cidade.json
 *   npm run generate-city -- --seed 7
 *
 * Desenho urbano:
 *  - centro em grade ortogonal com praça da matriz, igreja e prefeitura
 *  - comércio no miolo, prédios de apartamentos em volta, casas na borda
 *  - rio sinuoso ao sul com parque linear (Av. Beira-Rio) e duas pontes
 *  - bairro-jardim de ruas curvas (arcos concêntricos + radiais) além do rio
 *  - parque com lago ao norte, escola com quadra, distrito industrial a oeste
 *  - relevo em bacia suave: cidade plana, morros arborizados em volta
 *
 * Tudo é determinístico pela semente: ids de lote estáveis.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  Building,
  BuildingCategory,
  CityData,
  GreenArea,
  LandUse,
  Lot,
  RoadKind,
  Ring,
  Street,
  Vec2,
  WaterArea,
  WaterLine,
} from '../src/data/types';

// ------------------------------------------------------------------ util

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const SEED = Number(arg('seed', '42'));
const OUT = resolve(arg('out', 'public/data/cidade.json'));

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const rand = (a: number, b: number) => a + (b - a) * rng();
const r1 = (v: number) => Math.round(v * 10) / 10;
const P = (x: number, z: number): Vec2 => [r1(x), r1(z)];

function area(r: Ring) {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}
function centroid(r: Ring): Vec2 {
  let x = 0;
  let z = 0;
  for (const p of r) {
    x += p[0];
    z += p[1];
  }
  return P(x / r.length, z / r.length);
}
function distToSeg(px: number, pz: number, a: Vec2, b: Vec2) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / l2));
  return Math.hypot(px - a[0] - dx * t, pz - a[1] - dz * t);
}
function distToLine(px: number, pz: number, pts: Vec2[]) {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, distToSeg(px, pz, pts[i - 1], pts[i]));
  return d;
}
/** retângulo orientado: centro, direção u (frente->fundo = v) */
function orientedRect(cx: number, cz: number, ux: number, uz: number, hu: number, hv: number): Ring {
  const vx = -uz;
  const vz = ux;
  return [
    P(cx - ux * hu - vx * hv, cz - uz * hu - vz * hv),
    P(cx + ux * hu - vx * hv, cz + uz * hu - vz * hv),
    P(cx + ux * hu + vx * hv, cz + uz * hu + vz * hv),
    P(cx - ux * hu + vx * hv, cz - uz * hu + vz * hv),
  ];
}

// ------------------------------------------------------------------ desenho base

const HALF = 600; // área jogável ±600 m
/** rio: oeste -> leste, ao sul do centro */
const riverZ = (x: number) => 258 + 18 * Math.sin(x / 95) + 30 * Math.sin(x / 400);
const RIVER: Vec2[] = [];
for (let x = -1400; x <= 1400; x += 20) RIVER.push(P(x, riverZ(x)));
const RIVER_W = 16;

/** grade do centro */
const COLS = Array.from({ length: 10 }, (_, i) => -405 + i * 90); // -405..405
const ROWS = Array.from({ length: 10 }, (_, i) => -455 + i * 70); // -455..175
/** bairro-jardim: arcos concêntricos centrados abaixo do mapa */
const ARC_C: Vec2 = [0, 720];
const ARCS = [240, 300, 360, 420];
const RADIALS = [-150, -120, -90, -60, -30].map((d) => (d * Math.PI) / 180);
const arcPt = (r: number, a: number): Vec2 => P(ARC_C[0] + Math.cos(a) * r, ARC_C[1] + Math.sin(a) * r);

// ------------------------------------------------------------------ relevo

function noise(x: number, z: number) {
  return (
    Math.sin(x * 0.0061 + 1.3) * Math.cos(z * 0.0057 - 0.4) +
    0.5 * Math.sin(x * 0.0131 - z * 0.009 + 2.1) +
    0.25 * Math.cos(x * 0.027 + z * 0.023)
  );
}
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
function heightAt(x: number, z: number) {
  const r = Math.hypot(x, z * 1.05);
  // bacia: cidade quase plana, morros subindo depois de ~520 m
  let h = 4 * smooth(0, 520, r) + 75 * smooth(520, 1250, r);
  h += noise(x, z) * (1.2 + 16 * smooth(480, 1100, r));
  // vale do rio
  const d = distToLine(x, z, RIVER);
  h -= 4.5 * Math.exp(-((d / 55) ** 2));
  return h;
}
const HM_SIZE = 241;
const HM_CELL = 10;
const HM_MIN = -1200;
const hmData: number[] = [];
for (let j = 0; j < HM_SIZE; j++)
  for (let i = 0; i < HM_SIZE; i++) hmData.push(Math.round(heightAt(HM_MIN + i * HM_CELL, HM_MIN + j * HM_CELL) * 10));

// ------------------------------------------------------------------ ruas

interface Seg {
  a: Vec2;
  b: Vec2;
  kind: RoadKind;
  width: number;
  name: string;
  bridge?: boolean;
}
const segs: Seg[] = [];

const RUAS_NS = ['Rua dos Ipês', 'Rua das Acácias', 'Rua do Comércio', 'Av. da Matriz', 'Av. Aurora', 'Rua Bela Vista', 'Rua das Hortênsias', 'Rua do Sol', 'Rua dos Jacarandás', 'Rua Alto da Serra'];
const RUAS_EO = ['Rua Mirante', 'Rua das Flores', 'Rua da Paz', 'Rua São José', 'Rua Nova', 'Av. das Palmeiras', 'Rua da Matriz', 'Rua Esperança', 'Rua do Parque', 'Av. Beira-Rio'];
const ARC_NAMES = ['Alameda dos Sabiás', 'Alameda das Orquídeas', 'Alameda dos Girassóis', 'Alameda Primavera'];
const RAD_NAMES = ['Rua do Bosque', 'Rua do Pomar', 'Av. Central Sul', 'Rua da Fonte', 'Rua do Moinho'];

/** quadras do parque norte (sem ruas internas) */
const PARK_N = { x0: 135, x1: 315, z0: -385, z1: -245 };
const inParkN = (x: number, z: number) => x > PARK_N.x0 + 1 && x < PARK_N.x1 - 1 && z > PARK_N.z0 + 1 && z < PARK_N.z1 - 1;

function colKind(x: number): [RoadKind, number] {
  if (x === -45 || x === 45) return ['secondary', 10];
  if (Math.abs(x) <= 225) return ['tertiary', 8.5];
  return ['residential', 7.5];
}
function rowKind(z: number): [RoadKind, number] {
  if (z === -105 || z === 175) return ['secondary', 10];
  if (z >= -245) return ['tertiary', 8.5];
  return ['residential', 7.5];
}
// colunas (N-S)
COLS.forEach((x, ci) => {
  for (let j = 0; j < ROWS.length - 1; j++) {
    const z0 = ROWS[j];
    const z1 = ROWS[j + 1];
    if (inParkN(x, (z0 + z1) / 2)) continue;
    const [kind, width] = colKind(x);
    segs.push({ a: P(x, z0), b: P(x, z1), kind, width, name: RUAS_NS[ci] });
  }
});
// linhas (L-O): pontos extras na Beira-Rio para as pontes
ROWS.forEach((z, ri) => {
  const xs = [...COLS];
  if (z === 175) xs.push(0, -210, 210);
  xs.sort((a, b) => a - b);
  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = xs[i];
    const x1 = xs[i + 1];
    if (inParkN((x0 + x1) / 2, z)) continue;
    const [kind, width] = rowKind(z);
    segs.push({ a: P(x0, z), b: P(x1, z), kind, width, name: RUAS_EO[ri] });
  }
});
// arcos: amostrados a cada ~4°, passando exatamente pelos ângulos das radiais
ARCS.forEach((r, ai) => {
  const a0 = RADIALS[0];
  const a1 = RADIALS[RADIALS.length - 1];
  const angles = new Set<number>(RADIALS);
  const steps = Math.ceil(((a1 - a0) * 180) / Math.PI / 4);
  for (let i = 0; i <= steps; i++) angles.add(a0 + ((a1 - a0) * i) / steps);
  const list = [...angles].sort((a, b) => a - b);
  for (let i = 0; i < list.length - 1; i++)
    segs.push({ a: arcPt(r, list[i]), b: arcPt(r, list[i + 1]), kind: 'residential', width: 7.5, name: ARC_NAMES[ai] });
});
// radiais
RADIALS.forEach((a, k) => {
  for (let i = 0; i < ARCS.length - 1; i++)
    segs.push({ a: arcPt(ARCS[i], a), b: arcPt(ARCS[i + 1], a), kind: k === 2 ? 'secondary' : 'residential', width: k === 2 ? 10 : 7.5, name: RAD_NAMES[k] });
});
// pontes: radial central e duas laterais até a Beira-Rio
segs.push({ a: arcPt(420, -Math.PI / 2), b: P(0, 175), kind: 'secondary', width: 10, name: 'Ponte Aurora', bridge: true });
for (const s of [-1, 1]) {
  const a = arcPt(420, (s < 0 ? -120 : -60) * (Math.PI / 180));
  segs.push({ a, b: P(a[0], 340), kind: 'residential', width: 7.5, name: 'Ladeira do Rio' });
  segs.push({ a: P(a[0], 340), b: P(s * 210, 175), kind: 'residential', width: 7.5, name: s < 0 ? 'Ponte Velha' : 'Ponte Nova', bridge: true });
}

// nós: mesmo ponto = mesmo nó (interseções)
const nodeIds = new Map<string, number>();
const nodeOf = (p: Vec2) => {
  const k = `${p[0]},${p[1]}`;
  let id = nodeIds.get(k);
  if (id === undefined) {
    id = 1_000_000 + nodeIds.size;
    nodeIds.set(k, id);
  }
  return id;
};
// encadeia segmentos colineares/contínuos do mesmo nome e tipo em polilinhas
const streets: Street[] = [];
{
  const used = new Set<Seg>();
  const byStart = new Map<string, Seg[]>();
  const key = (p: Vec2) => `${p[0]},${p[1]}`;
  for (const s of segs) {
    if (!byStart.has(key(s.a))) byStart.set(key(s.a), []);
    byStart.get(key(s.a))!.push(s);
  }
  const hasPrev = (s: Seg) => segs.some((o) => o !== s && key(o.b) === key(s.a) && o.name === s.name && o.kind === s.kind && !!o.bridge === !!s.bridge);
  let sid = 1;
  for (const s of segs) {
    if (used.has(s) || hasPrev(s)) continue;
    const pts: Vec2[] = [s.a, s.b];
    used.add(s);
    let cur = s;
    for (;;) {
      const next = (byStart.get(key(cur.b)) ?? []).find((o) => !used.has(o) && o.name === cur.name && o.kind === cur.kind && !!o.bridge === !!cur.bridge);
      if (!next) break;
      used.add(next);
      pts.push(next.b);
      cur = next;
    }
    streets.push({ id: `way/${sid}`, osmId: sid, name: s.name, kind: s.kind, width: s.width, oneway: false, points: pts, nodes: pts.map(nodeOf), bridge: s.bridge });
    sid++;
  }
  for (const s of segs)
    if (!used.has(s)) {
      const pts = [s.a, s.b];
      streets.push({ id: `way/${sid}`, osmId: sid, name: s.name, kind: s.kind, width: s.width, oneway: false, points: pts, nodes: pts.map(nodeOf), bridge: s.bridge });
      sid++;
    }
}
const nearestStreet = (x: number, z: number) => {
  let best: Street | undefined;
  let bd = Infinity;
  for (const s of streets) {
    const d = distToLine(x, z, s.points) - s.width / 2;
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return { street: best!, d: bd };
};

// ------------------------------------------------------------------ verde, água, zonas

const greens: GreenArea[] = [];
const waterAreas: WaterArea[] = [];
const waterLines: WaterLine[] = [{ id: 'water/rio', name: 'Rio Aurora', kind: 'river', width: RIVER_W, points: RIVER }];
const landuse: LandUse[] = [];
const rectRing = (x0: number, z0: number, x1: number, z1: number): Ring => [P(x0, z0), P(x1, z0), P(x1, z1), P(x0, z1)];

// praça da matriz (quadra central)
greens.push({ id: 'green/praca', name: 'Praça da Matriz', kind: 'park', outer: rectRing(-45 + 8, -35 + 8, 45 - 8, 35 - 8) });
// parque norte com lago
greens.push({ id: 'green/parque-norte', name: 'Parque do Lago', kind: 'park', outer: rectRing(PARK_N.x0 + 7, PARK_N.z0 + 7, PARK_N.x1 - 7, PARK_N.z1 - 7) });
{
  const lake: Ring = [];
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    const w = 1 + 0.12 * Math.sin(a * 3 + 0.7);
    lake.push(P(225 + Math.cos(a) * 52 * w, -315 + Math.sin(a) * 32 * w));
  }
  waterAreas.push({ id: 'water/lago', name: 'Lago Azul', outer: lake });
}
// parque linear da beira-rio (entre a avenida e o rio)
{
  const north: Vec2[] = [];
  const south: Vec2[] = [];
  for (let x = -560; x <= 560; x += 20) {
    north.push(P(x, 175 + 9));
    south.push(P(x, riverZ(x) - RIVER_W / 2 - 3));
  }
  greens.push({ id: 'green/beira-rio', name: 'Parque Beira-Rio', kind: 'park', outer: [...north, ...south.reverse()] });
}
// margem sul do rio
{
  const a: Vec2[] = [];
  const b: Vec2[] = [];
  for (let x = -560; x <= 560; x += 20) {
    a.push(P(x, riverZ(x) + RIVER_W / 2 + 3));
    b.push(P(x, riverZ(x) + RIVER_W / 2 + 22));
  }
  greens.push({ id: 'green/margem-sul', kind: 'grass', outer: [...a, ...b.reverse()] });
}
// quadra da escola: campo
greens.push({ id: 'green/quadra', name: 'Campo da Escola', kind: 'pitch', outer: rectRing(-225 + 12, -245 + 10, -135 - 12, -210) });
// matas nos morros (cantos)
for (const [x0, z0, x1, z1] of [
  [-1150, -1150, -480, -560],
  [480, -1150, 1150, -560],
  [-1150, -560, -560, 150],
  [560, -560, 1150, 150],
  [-1150, 420, -560, 1150],
  [560, 420, 1150, 1150],
])
  greens.push({ id: `green/mata-${x0}-${z0}`, kind: 'wood', outer: rectRing(x0, z0, x1, z1) });

landuse.push({ id: 'landuse/centro', kind: 'commercial', name: 'Centro', outer: rectRing(-140, -180, 140, 110) });
landuse.push({ id: 'landuse/industrial', kind: 'industrial', name: 'Distrito Industrial', outer: rectRing(-410, -40, -220, 180) });
landuse.push({ id: 'landuse/residencial', kind: 'residential', outer: rectRing(-600, -600, 600, 600) });

// ------------------------------------------------------------------ lotes e prédios

const buildings: Building[] = [];
const lots: Lot[] = [];
let bid = 1;

type Zone = 'house' | 'apartment' | 'commercial' | 'industrial';
interface Spec {
  zone: Zone;
  bairro: string;
  lotW: [number, number];
}

function addBuilding(opts: {
  lotId: string;
  outer: Ring;
  lotOuter?: Ring;
  type: string;
  category: BuildingCategory;
  levels: number;
  name?: string;
  street: string;
  number: number;
}) {
  const id = `gen/${bid}`;
  const a = area(opts.outer);
  const c = centroid(opts.outer);
  const address = { street: opts.street, housenumber: String(opts.number) };
  buildings.push({
    id,
    osmId: bid,
    osmType: 'way',
    lotId: opts.lotId,
    name: opts.name,
    type: opts.type,
    category: opts.category,
    levels: opts.levels,
    height: opts.levels * 3,
    heightFromTag: false,
    generated: true,
    outer: opts.outer,
    area: r1(a),
    centroid: c,
    address,
  });
  const zoning = { residential: 'R1', commercial: 'C1', industrial: 'I1', institutional: 'INST', religious: 'INST' }[opts.category];
  lots.push({
    lotId: opts.lotId,
    buildingId: id,
    outer: opts.lotOuter,
    area: r1(area(opts.lotOuter ?? opts.outer)),
    centroid: c,
    address,
    ownerId: null,
    price: null,
    zoning,
  });
  bid++;
}

function addVacant(lotId: string, outer: Ring, street: string, number: number) {
  lots.push({
    lotId,
    buildingId: null,
    outer,
    vacant: true,
    area: r1(area(outer)),
    centroid: centroid(outer),
    address: { street, housenumber: String(number) },
    ownerId: null,
    price: null,
    zoning: 'R1',
  });
}

const okFromRiver = (r: Ring, margin: number) => r.every(([x, z]) => distToLine(x, z, RIVER) > RIVER_W / 2 + margin);

/**
 * Lote em frente a uma rua: (fx, fz) = ponto médio da frente, (ux, uz) =
 * direção ao longo da rua, (nx, nz) = normal para dentro do lote.
 */
function placeLot(spec: Spec, lotId: string, fx: number, fz: number, ux: number, uz: number, nx: number, nz: number, w: number, depth: number, street: string, number: number) {
  const cx = fx + nx * depth * 0.5;
  const cz = fz + nz * depth * 0.5;
  // u = ao longo da rua (meia largura w/2), v = profundidade
  const lotRing = orientedRect(cx, cz, ux, uz, w / 2, depth / 2);
  if (!okFromRiver(lotRing, 6)) return;
  const z = spec.zone;
  if (z === 'house' && rng() < 0.05) return addVacant(lotId, lotRing, street, number);

  let front = 0;
  let side = 0;
  let bd = 0;
  let levels = 1;
  let type = 'house';
  let category: BuildingCategory = 'residential';
  if (z === 'house') {
    front = rand(3.5, 5.5);
    side = rand(1.3, 2.2);
    bd = Math.min(depth - front - 5, rand(8.5, 12));
    levels = rng() < 0.28 ? 2 : 1;
  } else if (z === 'apartment') {
    front = rand(3.5, 5);
    side = rand(2.5, 3.5);
    bd = Math.min(depth - front - 4, rand(14, 18));
    levels = Math.round(rand(4, 9));
    type = 'apartments';
  } else if (z === 'commercial') {
    front = rand(0.3, 1);
    side = 0.35;
    bd = Math.min(depth - 3, rand(15, 22));
    levels = Math.round(rand(2, 6.4));
    type = 'commercial';
    category = 'commercial';
  } else {
    front = rand(6, 9);
    side = rand(3, 5);
    bd = Math.min(depth - front - 5, rand(18, 30));
    levels = 2;
    type = 'industrial';
    category = 'industrial';
  }
  const bw = w - side * 2;
  if (bw < 5 || bd < 5) return;
  const bcx = fx + nx * (front + bd / 2);
  const bcz = fz + nz * (front + bd / 2);
  let outer = orientedRect(bcx, bcz, ux, uz, bw / 2, bd / 2);
  // algumas casas em L (volume dos fundos mais estreito)
  if (z === 'house' && bw > 8 && rng() < 0.3) {
    const s = rng() < 0.5 ? 1 : -1;
    const notch = bw * 0.42;
    const nd = bd * 0.45;
    const W = (su: number, sv: number): Vec2 => P(bcx + ux * su * s + nx * sv, bcz + uz * su * s + nz * sv);
    outer = [W(-bw / 2, -bd / 2), W(bw / 2, -bd / 2), W(bw / 2, bd / 2 - nd), W(bw / 2 - notch, bd / 2 - nd), W(bw / 2 - notch, bd / 2), W(-bw / 2, bd / 2)];
    if (s < 0) outer.reverse();
  }
  addBuilding({
    lotId,
    outer,
    lotOuter: z === 'house' || z === 'apartment' ? lotRing : undefined,
    type,
    category,
    levels,
    street,
    number,
  });
}

/** preenche uma quadra retangular com lotes nas frentes norte e sul */
function fillBlock(x0: number, z0: number, x1: number, z1: number, spec: Spec, streetN: string, streetS: string) {
  const depth = (z1 - z0) / 2;
  for (const [edge, nz, street] of [
    [z0, 1, streetN],
    [z1, -1, streetS],
  ] as const) {
    let x = x0;
    let n = 1;
    while (x1 - x > spec.lotW[0]) {
      let w = rand(spec.lotW[0], spec.lotW[1]);
      if (x1 - x - w < spec.lotW[0]) w = x1 - x;
      const lotId = `VA-${spec.bairro}-${Math.round(x0)}${Math.round(z0)}-${nz > 0 ? 'N' : 'S'}${n}`;
      placeLot(spec, lotId, x + w / 2, edge, 1, 0, 0, nz, w, depth, street, Math.round(Math.abs(x + w / 2) * 2) + (nz > 0 ? 0 : 1));
      x += w;
      n++;
    }
  }
}

const SET = 3; // calçada
for (let i = 0; i < COLS.length - 1; i++)
  for (let j = 0; j < ROWS.length - 1; j++) {
    const xa = COLS[i];
    const xb = COLS[i + 1];
    const za = ROWS[j];
    const zb = ROWS[j + 1];
    const cx = (xa + xb) / 2;
    const cz = (za + zb) / 2;
    const x0 = xa + colKind(xa)[1] / 2 + SET;
    const x1 = xb - colKind(xb)[1] / 2 - SET;
    const z0 = za + rowKind(za)[1] / 2 + SET;
    const z1 = zb - rowKind(zb)[1] / 2 - SET;
    const sN = RUAS_EO[j];
    const sS = RUAS_EO[j + 1];
    if (cx === 0 && cz === 0) continue; // praça
    if (inParkN(cx, cz)) continue;
    // igreja matriz (de frente para a praça) + comércio atrás
    if (cx === 0 && cz === -70) {
      const ux = 1;
      const outer = orientedRect(0, z1 - 16, ux, 0, 9, 15);
      addBuilding({ lotId: 'VA-CENTRO-MATRIZ', outer, type: 'church', category: 'religious', levels: 4, name: 'Igreja Matriz de Santa Aurora', street: 'Praça da Matriz', number: 1 });
      fillBlock(x0, z0, x1, z0 + (z1 - z0) / 2, { zone: 'commercial', bairro: 'CENTRO', lotW: [12, 18] }, sN, sN);
      continue;
    }
    // prefeitura (de frente para a praça)
    if (cx === 0 && cz === 70) {
      const outer = orientedRect(0, z0 + 13, 1, 0, 24, 11);
      addBuilding({ lotId: 'VA-CENTRO-PREFEITURA', outer, type: 'townhall', category: 'institutional', levels: 3, name: 'Prefeitura Municipal', street: 'Praça da Matriz', number: 100 });
      fillBlock(x0, z0 + (z1 - z0) / 2, x1, z1, { zone: 'commercial', bairro: 'CENTRO', lotW: [12, 18] }, sS, sS);
      continue;
    }
    // escola
    if (cx === -180 && cz === -210) {
      const outer = orientedRect(-180, z1 - 12, 1, 0, 30, 10);
      addBuilding({ lotId: 'VA-ESCOLA', outer, type: 'school', category: 'institutional', levels: 2, name: 'Escola Estadual Aurora', street: sS, number: 50 });
      continue;
    }
    let spec: Spec;
    if (cx < -225 && cz > -35) spec = { zone: 'industrial', bairro: 'DI', lotW: [32, 44] };
    else if (Math.abs(cx) <= 135 && cz >= -175 && cz <= 105) spec = { zone: 'commercial', bairro: 'CENTRO', lotW: [12, 20] };
    else if (Math.abs(cx) <= 225 && cz >= -315) spec = rng() < 0.7 ? { zone: 'apartment', bairro: 'JARDINS', lotW: [22, 30] } : { zone: 'house', bairro: 'JARDINS', lotW: [12, 16] };
    else spec = { zone: 'house', bairro: cz < -245 ? 'ALTO' : 'VILA', lotW: [11, 15] };
    fillBlock(x0, z0, x1, z1, spec, sN, sS);
  }

// bairro-jardim: lotes nos dois lados de cada arco, longe das radiais
{
  const offset = 7.5 / 2 + SET;
  ARCS.forEach((r, ai) => {
    for (const side of [-1, 1]) {
      const depth = 22;
      if (side < 0 && ai === 0) continue; // dentro do primeiro arco: mata
      const rFront = r + side * offset;
      const a0 = RADIALS[0];
      const a1 = RADIALS[RADIALS.length - 1];
      let a = a0;
      let n = 1;
      while (a < a1) {
        const w = rand(13, 17);
        const da = w / rFront;
        const am = a + da / 2;
        a += da;
        if (a > a1) break;
        // afastado das radiais (cruzamentos)
        if (RADIALS.some((ra) => Math.abs(ra - am) * rFront < w / 2 + 7)) continue;
        const fx = ARC_C[0] + Math.cos(am) * rFront;
        const fz = ARC_C[1] + Math.sin(am) * rFront;
        const nx = Math.cos(am) * side;
        const nz = Math.sin(am) * side;
        const ux = -Math.sin(am);
        const uz = Math.cos(am);
        const lotId = `VA-SUL-A${ai}${side > 0 ? 'E' : 'I'}${n}`;
        placeLot({ zone: 'house', bairro: 'SUL', lotW: [13, 17] }, lotId, fx, fz, ux, uz, nx, nz, w, depth, ARC_NAMES[ai], n * 2 + (side > 0 ? 0 : 1));
        n++;
      }
    }
  });
}

// descarta lotes/prédios fora da área ou sobre ruas
{
  const bad = new Set<string>();
  for (const b of buildings) {
    const hit = b.outer.some(([x, z]) => Math.abs(x) > HALF - 5 || Math.abs(z) > HALF - 5) || b.outer.some(([x, z]) => nearestStreet(x, z).d < 0.5);
    if (hit) bad.add(b.id);
  }
  for (let i = buildings.length - 1; i >= 0; i--) if (bad.has(buildings[i].id)) buildings.splice(i, 1);
  for (let i = lots.length - 1; i >= 0; i--) {
    const l = lots[i];
    if ((l.buildingId && bad.has(l.buildingId)) || (l.outer && l.outer.some(([x, z]) => Math.abs(x) > HALF - 5 || Math.abs(z) > HALF - 5))) lots.splice(i, 1);
  }
}

// ------------------------------------------------------------------ saída

const data: CityData = {
  version: 1,
  name: 'Vila Aurora',
  generatedAt: new Date().toISOString(),
  attribution: 'Cidade fictícia gerada proceduralmente (scripts/generate-city.ts)',
  origin: { lat: -20.253, lon: -43.803, elevation: 900 },
  bounds: { minX: -HALF, minZ: -HALF, maxX: HALF, maxZ: HALF },
  bbox: { south: -20.2585, west: -43.8087, north: -20.2475, east: -43.7973 },
  heightmap: { size: HM_SIZE, cellSize: HM_CELL, minX: HM_MIN, minZ: HM_MIN, data: hmData },
  streets,
  buildings,
  lots,
  waterLines,
  waterAreas,
  greens,
  railways: [],
  landuse,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(data));
const counts = buildings.reduce<Record<string, number>>((m, b) => ((m[b.category] = (m[b.category] ?? 0) + 1), m), {});
console.log(`Vila Aurora: ${streets.length} ruas, ${buildings.length} prédios ${JSON.stringify(counts)}, ${lots.length} lotes (${lots.filter((l) => l.vacant).length} vagos) -> ${OUT}`);
