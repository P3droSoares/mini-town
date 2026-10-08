/**
 * Gera a cidade fictícia "Vila Aurora" no formato `CityData` (antes vindo
 * do OSM). Inspirada — sem copiar — em Nova York e Madri:
 *
 *  Leste (Nova York): grade de quarteirões alongados, avenidas largas N-S e
 *    ruas estreitas L-O; a "Via Larga" corta a grade na diagonal (Broadway)
 *    abrindo largos nos cruzamentos; parque central retangular com lago;
 *    torres no centro financeiro (sul) e em Midtown; sobrados de tijolo
 *    (brownstones) ao norte.
 *  Oeste (Madri): centro histórico orgânico com ruas radiais saindo da Praça
 *    do Sol, dois anéis irregulares e vielas; Praça Maior fechada com pátio;
 *    catedral; a Grande Via curva; em volta, a malha de quadras quadradas do
 *    "ensanche" com prédios de perímetro; parque estilo Retiro com lago.
 *  Entre os dois: Passeio do Prado — bulevar duplo arborizado com rotatórias
 *    (glorietas) e chafariz. A oeste, rio largo com orla.
 *
 *   npm run generate-city            -> public/data/cidade.json
 *   npm run generate-city -- --seed 7
 *
 * Determinístico pela semente: ids de lote estáveis.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Building, BuildingCategory, CityData, GreenArea, GreenKind, LandUse, Lot, RoadKind, Ring, Street, Vec2, WaterArea, WaterLine } from '../src/data/types';

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
const D2R = Math.PI / 180;

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
function pointInPoly(x: number, z: number, r: Ring) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i];
    const [xj, zj] = r[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
/** retângulo orientado: centro, eixo u (meia medida hu) e v = perpendicular (hv) */
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
const rectRing = (x0: number, z0: number, x1: number, z1: number): Ring => [P(x0, z0), P(x1, z0), P(x1, z1), P(x0, z1)];
const circle = (cx: number, cz: number, r: number, n = 28, sx = 1, sz = 1): Ring =>
  Array.from({ length: n }, (_, i) => P(cx + Math.cos((i / n) * Math.PI * 2) * r * sx, cz + Math.sin((i / n) * Math.PI * 2) * r * sz));

// ------------------------------------------------------------------ desenho base

const HALF = 600;

/** rio largo a oeste (N-S) */
const riverX = (z: number) => -548 + 20 * Math.sin(z / 170) + 8 * Math.sin(z / 61);
const RIVER_W = 46;
const RIVER: Vec2[] = [];
for (let z = -1400; z <= 1400; z += 20) RIVER.push(P(riverX(z), z));
/** avenida da orla */
const driveX = (z: number) => riverX(z) + RIVER_W / 2 + 36;

/** Passeio do Prado: duas pistas com canteiro central; rotatórias */
const PASEO = 22;
const G1 = { x: 0, z: 0, r: 36 };
const G2 = { x: 0, z: -360, r: 30 };

/** centro histórico (Madri): Praça do Sol e anéis irregulares */
const SOL: Vec2 = [-240, -60];
const ringR = (R: number, th: number) => R * (1 + 0.09 * Math.sin(3 * th + 0.5) + 0.04 * Math.sin(5 * th + 1.7));
const R1 = 105;
const R2 = 215;
const polar = (r: number, th: number): Vec2 => [SOL[0] + Math.cos(th) * r, SOL[1] + Math.sin(th) * r];
const thetaOf = (x: number, z: number) => Math.atan2(z - SOL[1], x - SOL[0]);
const inOld = (x: number, z: number, margin = 0) => Math.hypot(x - SOL[0], z - SOL[1]) < ringR(R2, thetaOf(x, z)) + margin;
/** ângulos das radiais (a primeira aponta para a rotatória G1) */
const RAD = [14, 59, 104, 149, 194, 239, 284, 329].map((d) => d * D2R);

/** grade de Nova York (leste) */
const AVES = [140, 260, 380, 500];
const NY_STREETS = Array.from({ length: 20 }, (_, k) => -570 + 60 * k);
const CPARK = { x0: 140, x1: 380, z0: -510, z1: -210 };
const inCPark = (x: number, z: number, m = 1) => x > CPARK.x0 + m && x < CPARK.x1 - m && z > CPARK.z0 + m && z < CPARK.z1 - m;
const BROADWAY: Vec2[] = [P(60, -600), P(132, -215), P(300, 120), P(450, 400), P(560, 600)];

/** ensanche (Madri, oeste): quadras quadradas de 80 m */
const ENS_X = [-422, -342, -262, -182, -102];
const ENS_Z = Array.from({ length: 15 }, (_, k) => -580 + 80 * k);
const RETIRO = { x0: -422, x1: -182, z0: 220, z1: 460 };
const inRetiro = (x: number, z: number, m = 1) => x > RETIRO.x0 + m && x < RETIRO.x1 - m && z > RETIRO.z0 + m && z < RETIRO.z1 - m;

const inGlorieta = (x: number, z: number, m = 0) => Math.hypot(x - G1.x, z - G1.z) < G1.r + m || Math.hypot(x - G2.x, z - G2.z) < G2.r + m;

// ------------------------------------------------------------------ relevo

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
function noise(x: number, z: number) {
  return Math.sin(x * 0.0061 + 1.3) * Math.cos(z * 0.0057 - 0.4) + 0.5 * Math.sin(x * 0.0131 - z * 0.009 + 2.1) + 0.25 * Math.cos(x * 0.027 + z * 0.023);
}
function heightAt(x: number, z: number) {
  const r = Math.max(Math.abs(x), Math.abs(z));
  // cidade quase plana, subindo de leve para nordeste; morros fora do mapa
  let h = 0.006 * (x - z) + 60 * smooth(640, 1250, r);
  h += noise(x, z) * (0.8 + 14 * smooth(620, 1100, r));
  // calha do rio
  const d = Math.abs(x - riverX(z));
  h -= 5 * Math.exp(-((d / 70) ** 2));
  return h;
}
const HM_SIZE = 241;
const HM_CELL = 10;
const HM_MIN = -1200;
const hmData: number[] = [];
for (let j = 0; j < HM_SIZE; j++) for (let i = 0; i < HM_SIZE; i++) hmData.push(Math.round(heightAt(HM_MIN + i * HM_CELL, HM_MIN + j * HM_CELL) * 10));

// ------------------------------------------------------------------ ruas (polilinhas livres + noding)

interface Road {
  name: string;
  kind: RoadKind;
  width: number;
  pts: Vec2[];
  bridge?: boolean;
  /** não recebe lotes (anéis de rotatória) */
  noLots?: boolean;
}
const roads: Road[] = [];

/** densifica, remove trechos onde `cut` é verdade e simplifica os trechos retos */
function clipRoad(r: Road, cut: (x: number, z: number) => boolean, step = 3) {
  const dense: Vec2[] = [];
  for (let i = 1; i < r.pts.length; i++) {
    const a = r.pts[i - 1];
    const b = r.pts[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) dense.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  const runs: Vec2[][] = [];
  let cur: Vec2[] = [];
  for (const p of dense) {
    if (cut(p[0], p[1])) {
      if (cur.length > 1) runs.push(cur);
      cur = [];
    } else cur.push(p);
  }
  if (cur.length > 1) runs.push(cur);
  for (const run of runs) {
    // simplifica: mantém pontas e mudanças de direção
    const out: Vec2[] = [run[0]];
    for (let i = 1; i < run.length - 1; i++) {
      const a = out[out.length - 1];
      const b = run[i];
      const c = run[i + 1];
      const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
      let d = Math.abs(a1 - a2);
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > 0.012) out.push(b);
    }
    out.push(run[run.length - 1]);
    const len = out.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) : 0), 0);
    if (len > 10) roads.push({ ...r, pts: out.map(([x, z]) => P(x, z)) });
  }
}
const outside = (x: number, z: number) => Math.abs(x) > HALF + 2 || Math.abs(z) > HALF + 2;

// --- Passeio do Prado (duas pistas) e rotatórias
for (const s of [-1, 1])
  clipRoad({ name: 'Passeio do Prado', kind: 'primary', width: 10, pts: [P(s * PASEO, -HALF), P(s * PASEO, HALF)] }, (x, z) => inGlorieta(x, z, -3));
for (const [gl, name] of [
  [G1, 'Rotatória da Cibele'],
  [G2, 'Rotatória do Netuno'],
] as const) {
  const pts: Vec2[] = [];
  for (let i = 0; i <= 32; i++) pts.push(P(gl.x + Math.cos((i / 32) * Math.PI * 2) * gl.r, gl.z + Math.sin((i / 32) * Math.PI * 2) * gl.r));
  roads.push({ name, kind: 'primary', width: 10, pts, noLots: true });
}

// --- Leste: grade de Nova York
const ORD = ['Primeira', 'Segunda', 'Terceira', 'Quarta'];
AVES.forEach((x, i) =>
  clipRoad({ name: `${ORD[i]} Avenida`, kind: 'secondary', width: 13, pts: [P(x, -HALF), P(x, HALF)] }, (px, pz) => inCPark(px, pz, 2) || outside(px, pz)),
);
NY_STREETS.forEach((z, k) => {
  const wide = k % 4 === 2;
  clipRoad(
    { name: `Rua ${(k + 1) * 3}`, kind: wide ? 'tertiary' : 'residential', width: wide ? 10 : 7.5, pts: [P(PASEO - 3, z), P(HALF, z)] },
    (px, pz) => inCPark(px, pz, 2) || inGlorieta(px, pz, -3),
  );
});
clipRoad({ name: 'Via Larga', kind: 'secondary', width: 11, pts: BROADWAY }, (px, pz) => inCPark(px, pz, 2) || outside(px, pz));

// --- Oeste: centro histórico (Madri)
const RAD_NAMES = ['Rua de Alcalá', 'Rua da Montera', 'Rua do Carmo', 'Rua Maior', 'Rua do Arenal', 'Rua da Prata', 'Rua das Carretas', 'Rua da Cruz'];
RAD.forEach((th, k) => {
  // comprimento: até o 2º anel (+3 m), exceto Alcalá (até G1) e a do rio (até a orla)
  let L = ringR(R2, th) + 3;
  if (k === 0) L = Math.hypot(G1.x - SOL[0], G1.z - SOL[1]) - G1.r + 3;
  if (k === 4) L = SOL[0] - driveX(SOL[1]) + 4;
  const pts: Vec2[] = [];
  const n = Math.max(2, Math.round(L / 18));
  const dx = Math.cos(th);
  const dz = Math.sin(th);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // ondulação (ruas antigas não são retas), nula nas pontas
    const w = k === 0 ? 0 : 7 * Math.sin(t * Math.PI) * Math.sin(t * 4.1 + k);
    pts.push(P(SOL[0] + dx * L * t - dz * w, SOL[1] + dz * L * t + dx * w));
  }
  roads.push({ name: RAD_NAMES[k], kind: k === 0 ? 'secondary' : 'tertiary', width: k === 0 ? 11 : 7.5, pts });
});
for (const [R, name] of [
  [R1, 'Ronda Interna'],
  [R2, 'Ronda de Toledo'],
] as const) {
  const pts: Vec2[] = [];
  for (let i = 0; i <= 64; i++) {
    const th = (i / 64) * Math.PI * 2;
    pts.push(P(...polar(ringR(R, th), th)));
  }
  roads.push({ name, kind: R === R2 ? 'secondary' : 'residential', width: R === R2 ? 10 : 7, pts });
}
// vielas entre radiais
for (let k = 0; k < RAD.length; k += 2) {
  const th = (RAD[k] + RAD[(k + 1) % RAD.length] + (k === RAD.length - 1 ? Math.PI * 2 : 0)) / 2;
  const a = ringR(R1, th) - 2;
  const b = ringR(R2, th) + 2;
  const pts: Vec2[] = [];
  for (let i = 0; i <= 5; i++) {
    const r = a + ((b - a) * i) / 5;
    pts.push(P(...polar(r, th + 0.05 * Math.sin(i * 1.7 + k))));
  }
  roads.push({ name: `Travessa ${k / 2 + 1}`, kind: 'living_street', width: 6, pts });
}
for (const k of [1, 3, 7]) {
  const a0 = RAD[k];
  const a1 = RAD[(k + 1) % RAD.length] + (k === 7 ? Math.PI * 2 : 0);
  const pts: Vec2[] = [];
  for (let i = 0; i <= 10; i++) {
    const th = a0 + ((a1 - a0) * i) / 10;
    pts.push(P(...polar(ringR(160, th), th)));
  }
  roads.push({ name: `Beco ${k}`, kind: 'living_street', width: 6, pts });
}
// Grande Via: do anel interno, em curva, até o Passeio
roads.push({
  name: 'Grande Via',
  kind: 'primary',
  width: 14,
  pts: [P(...polar(ringR(R1, -100 * D2R) - 2, -100 * D2R)), P(-205, -205), P(-150, -232), P(-90, -246), P(-PASEO + 3, -255)],
});

// --- Oeste: ensanche (quadras quadradas), recortado pelo centro histórico e pelo Retiro
const ENS_CUT = (x: number, z: number) => inOld(x, z, -3) || inRetiro(x, z, 2) || x < driveX(z) - 3 || outside(x, z);
const ENS_X_NAMES = ['Rua de Serrano', 'Rua de Velázquez', 'Rua do Príncipe', 'Rua de Goya', 'Rua do Conde'];
const ENS_Z_NAMES = ['Ayala', 'Lagasca', 'Jorge Juan', 'Hermosilla', 'Claudio', 'Ortega', 'Lista', 'Diego', 'Castelló', 'Núñez', 'Padilla', 'Juan Bravo', 'Maldonado', 'Villanueva', 'Recoletos'];
ENS_X.forEach((x, i) => clipRoad({ name: ENS_X_NAMES[i], kind: 'residential', width: 8, pts: [P(x, -HALF), P(x, HALF)] }, ENS_CUT));
ENS_Z.forEach((z, k) =>
  clipRoad(
    { name: `Rua ${ENS_Z_NAMES[k]}`, kind: k % 3 === 1 ? 'tertiary' : 'residential', width: k % 3 === 1 ? 9 : 8, pts: [P(driveX(z) - 3, z), P(-PASEO + 3, z)] },
    (x, pz) => ENS_CUT(x, pz) || inGlorieta(x, pz, -3),
  ),
);
// --- avenida da orla
{
  const pts: Vec2[] = [];
  for (let z = -HALF - 10; z <= HALF + 10; z += 30) pts.push(P(driveX(z), z));
  roads.push({ name: 'Avenida da Orla', kind: 'primary', width: 12, pts });
}

// --- noding: insere os cruzamentos nas duas ruas (nó compartilhado)
{
  type Hit = { seg: number; t: number; p: Vec2 };
  const hits: Hit[][] = roads.map(() => []);
  const cell = 40;
  const grid = new Map<string, [number, number][]>();
  roads.forEach((r, ri) => {
    for (let si = 1; si < r.pts.length; si++) {
      const a = r.pts[si - 1];
      const b = r.pts[si];
      for (let gx = Math.floor(Math.min(a[0], b[0]) / cell); gx <= Math.floor(Math.max(a[0], b[0]) / cell); gx++)
        for (let gz = Math.floor(Math.min(a[1], b[1]) / cell); gz <= Math.floor(Math.max(a[1], b[1]) / cell); gz++) {
          const k = `${gx},${gz}`;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k)!.push([ri, si]);
        }
    }
  });
  const seen = new Set<string>();
  for (const list of grid.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const [ra, sa] = list[i];
        const [rb, sb] = list[j];
        if (ra === rb) continue;
        const key = `${ra}:${sa}|${rb}:${sb}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const a0 = roads[ra].pts[sa - 1];
        const a1 = roads[ra].pts[sa];
        const b0 = roads[rb].pts[sb - 1];
        const b1 = roads[rb].pts[sb];
        const dax = a1[0] - a0[0];
        const daz = a1[1] - a0[1];
        const dbx = b1[0] - b0[0];
        const dbz = b1[1] - b0[1];
        const den = dax * dbz - daz * dbx;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((b0[0] - a0[0]) * dbz - (b0[1] - a0[1]) * dbx) / den;
        const u = ((b0[0] - a0[0]) * daz - (b0[1] - a0[1]) * dax) / den;
        const e = 1e-6;
        if (t < -e || t > 1 + e || u < -e || u > 1 + e) continue;
        const p = P(a0[0] + dax * t, a0[1] + daz * t);
        hits[ra].push({ seg: sa, t, p });
        hits[rb].push({ seg: sb, t: u, p });
      }
  roads.forEach((r, ri) => {
    const hs = hits[ri].sort((a, b) => a.seg - b.seg || a.t - b.t);
    const out: Vec2[] = [r.pts[0]];
    let hi = 0;
    // cruzamento exatamente no 1º ponto
    while (hi < hs.length && hs[hi].seg === 1 && hs[hi].t < 1e-4) out[0] = hs[hi++].p;
    for (let si = 1; si < r.pts.length; si++) {
      while (hi < hs.length && hs[hi].seg === si) {
        const p = hs[hi++].p;
        const last = out[out.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.4) out[out.length - 1] = p;
        else out.push(p);
      }
      const v = r.pts[si];
      const last = out[out.length - 1];
      if (Math.hypot(v[0] - last[0], v[1] - last[1]) >= 0.4) out.push(v);
    }
    r.pts = out;
  });
}

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
const streets: Street[] = roads.map((r, i) => ({
  id: `way/${i + 1}`,
  osmId: i + 1,
  name: r.name,
  kind: r.kind,
  width: r.width,
  oneway: false,
  points: r.pts,
  nodes: r.pts.map(nodeOf),
  bridge: r.bridge,
}));

// índice espacial de trechos de rua
const SEG_CELL = 30;
const segGrid = new Map<string, { a: Vec2; b: Vec2; hw: number }[]>();
for (const s of streets)
  for (let i = 1; i < s.points.length; i++) {
    const a = s.points[i - 1];
    const b = s.points[i];
    const seg = { a, b, hw: s.width / 2 };
    for (let gx = Math.floor((Math.min(a[0], b[0]) - 10) / SEG_CELL); gx <= Math.floor((Math.max(a[0], b[0]) + 10) / SEG_CELL); gx++)
      for (let gz = Math.floor((Math.min(a[1], b[1]) - 10) / SEG_CELL); gz <= Math.floor((Math.max(a[1], b[1]) + 10) / SEG_CELL); gz++) {
        const k = `${gx},${gz}`;
        if (!segGrid.has(k)) segGrid.set(k, []);
        segGrid.get(k)!.push(seg);
      }
  }
/** folga até a borda da pista mais próxima (negativo = sobre a pista) */
function streetClearance(x: number, z: number) {
  let d = Infinity;
  for (const s of segGrid.get(`${Math.floor(x / SEG_CELL)},${Math.floor(z / SEG_CELL)}`) ?? []) d = Math.min(d, distToSeg(x, z, s.a, s.b) - s.hw);
  return d;
}

// ------------------------------------------------------------------ verde e água

const greens: GreenArea[] = [];
const waterAreas: WaterArea[] = [];
const waterLines: WaterLine[] = [{ id: 'water/rio', name: 'Rio Aurora', kind: 'river', width: RIVER_W, points: RIVER }];
const landuse: LandUse[] = [];
const green = (id: string, kind: GreenKind, outer: Ring, name?: string) => greens.push({ id: `green/${id}`, kind, outer, name });

// orla do rio
{
  const a: Vec2[] = [];
  const b: Vec2[] = [];
  for (let z = -HALF - 20; z <= HALF + 20; z += 20) {
    a.push(P(riverX(z) + RIVER_W / 2 + 2, z));
    b.push(P(driveX(z) - 9, z));
  }
  green('orla', 'park', [...a, ...b.reverse()], 'Parque da Orla');
}
// canteiro central do Passeio (entre as rotatórias)
for (const [z0, z1] of [
  [-HALF, G2.z - G2.r - 2],
  [G2.z + G2.r + 2, G1.z - G1.r - 2],
  [G1.z + G1.r + 2, HALF],
])
  green(`passeio${z0}`, 'park', rectRing(-PASEO + 6, z0, PASEO - 6, z1), 'Passeio do Prado');
green('cibele', 'park', circle(G1.x, G1.z, G1.r - 7), 'Praça da Cibele');
green('netuno', 'park', circle(G2.x, G2.z, G2.r - 7), 'Praça do Netuno');
waterAreas.push({ id: 'water/chafariz', name: 'Chafariz da Cibele', outer: circle(G1.x, G1.z, 8, 20) });
waterAreas.push({ id: 'water/chafariz2', name: 'Chafariz do Netuno', outer: circle(G2.x, G2.z, 6, 20) });
// parque central (NY) com reservatório e lago
green('central', 'park', rectRing(CPARK.x0 + 9, CPARK.z0 + 6, CPARK.x1 - 9, CPARK.z1 - 6), 'Parque Central');
waterAreas.push({ id: 'water/reservatorio', name: 'Reservatório', outer: circle(275, -425, 1, 36, 62, 38) });
waterAreas.push({
  id: 'water/lago-central',
  name: 'Lago do Parque',
  outer: Array.from({ length: 30 }, (_, i) => {
    const a = (i / 30) * Math.PI * 2;
    const w = 1 + 0.18 * Math.sin(a * 3 + 1);
    return P(205 + Math.cos(a) * 38 * w, -280 + Math.sin(a) * 22 * w);
  }),
});
green('campo-central', 'pitch', rectRing(300, -320, 360, -260), 'Gramado Grande');
// Retiro (Madri) com lago retangular de cantos redondos
green('retiro', 'park', rectRing(RETIRO.x0 + 8, RETIRO.z0 + 8, RETIRO.x1 - 8, RETIRO.z1 - 8), 'Parque do Retiro');
waterAreas.push({
  id: 'water/estanque',
  name: 'Lago do Retiro',
  outer: Array.from({ length: 36 }, (_, i) => {
    const a = (i / 36) * Math.PI * 2;
    // superelipse: retângulo de cantos arredondados
    const c = Math.cos(a);
    const s = Math.sin(a);
    return P(-300 + Math.sign(c) * Math.abs(c) ** 0.4 * 52, 330 + Math.sign(s) * Math.abs(s) ** 0.4 * 24);
  }),
});
// matas nos morros fora do mapa
for (const [x0, z0, x1, z1] of [
  [-1150, -1150, 1150, -650],
  [-1150, 650, 1150, 1150],
  [650, -650, 1150, 650],
])
  green(`mata${x0}${z0}${x1}`, 'wood', rectRing(x0, z0, x1, z1));

// ------------------------------------------------------------------ bairros

type Zone = 'oldtown' | 'ensanche' | 'brownstone' | 'midtown' | 'downtown' | 'docks';
interface ZoneSpec {
  w: [number, number];
  depth: number;
  front: number;
  side: number;
  levels: [number, number];
  /** chance de comercial */
  shop: number;
}
const ZONES: Record<Zone, ZoneSpec> = {
  oldtown: { w: [8, 13], depth: 15, front: 0.2, side: 0.25, levels: [3, 5], shop: 0.45 },
  ensanche: { w: [14, 22], depth: 16, front: 0.3, side: 0.3, levels: [5, 7], shop: 0.2 },
  brownstone: { w: [7, 10], depth: 15, front: 2, side: 0.25, levels: [3, 5], shop: 0.08 },
  midtown: { w: [18, 32], depth: 22, front: 0.5, side: 0.4, levels: [6, 22], shop: 0.7 },
  downtown: { w: [20, 34], depth: 24, front: 0.5, side: 0.4, levels: [12, 34], shop: 0.85 },
  docks: { w: [30, 44], depth: 28, front: 5, side: 4, levels: [2, 2], shop: 0 },
};
function zoneAt(x: number, z: number): Zone {
  if (x < 0) {
    if (inOld(x, z)) return 'oldtown';
    if (x < -422 && z > 460) return 'docks';
    return 'ensanche';
  }
  if (z > 330) return 'downtown';
  if (z > -210) return 'midtown';
  return 'brownstone';
}
landuse.push({ id: 'landuse/centro-historico', kind: 'commercial', name: 'Centro Histórico', outer: circle(SOL[0], SOL[1], R2, 40) });
landuse.push({ id: 'landuse/midtown', kind: 'commercial', name: 'Midtown', outer: rectRing(PASEO, -210, HALF, HALF) });
landuse.push({ id: 'landuse/docas', kind: 'industrial', name: 'Docas', outer: rectRing(-HALF, 460, -422, HALF) });
landuse.push({ id: 'landuse/residencial', kind: 'residential', outer: rectRing(-HALF, -HALF, HALF, HALF) });

// ------------------------------------------------------------------ ocupação

const buildings: Building[] = [];
const lots: Lot[] = [];
let bid = 1;

/** polígonos ocupados (lotes e prédios especiais), num índice espacial */
const OCC = 25;
const occGrid = new Map<string, Ring[]>();
function occupy(r: Ring) {
  const xs = r.map((p) => p[0]);
  const zs = r.map((p) => p[1]);
  for (let gx = Math.floor(Math.min(...xs) / OCC); gx <= Math.floor(Math.max(...xs) / OCC); gx++)
    for (let gz = Math.floor(Math.min(...zs) / OCC); gz <= Math.floor(Math.max(...zs) / OCC); gz++) {
      const k = `${gx},${gz}`;
      if (!occGrid.has(k)) occGrid.set(k, []);
      occGrid.get(k)!.push(r);
    }
}
/** SAT entre polígonos convexos */
function convexOverlap(a: Ring, b: Ring) {
  for (const poly of [a, b])
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const nx = q[1] - p[1];
      const nz = p[0] - q[0];
      let amin = Infinity;
      let amax = -Infinity;
      let bmin = Infinity;
      let bmax = -Infinity;
      for (const v of a) {
        const d = v[0] * nx + v[1] * nz;
        amin = Math.min(amin, d);
        amax = Math.max(amax, d);
      }
      for (const v of b) {
        const d = v[0] * nx + v[1] * nz;
        bmin = Math.min(bmin, d);
        bmax = Math.max(bmax, d);
      }
      const eps = 0.05 * Math.hypot(nx, nz);
      if (amax <= bmin + eps || bmax <= amin + eps) return false;
    }
  return true;
}
function overlapsOccupied(r: Ring) {
  const xs = r.map((p) => p[0]);
  const zs = r.map((p) => p[1]);
  const seen = new Set<Ring>();
  for (let gx = Math.floor(Math.min(...xs) / OCC); gx <= Math.floor(Math.max(...xs) / OCC); gx++)
    for (let gz = Math.floor(Math.min(...zs) / OCC); gz <= Math.floor(Math.max(...zs) / OCC); gz++)
      for (const o of occGrid.get(`${gx},${gz}`) ?? []) {
        if (seen.has(o)) continue;
        seen.add(o);
        if (convexOverlap(r, o)) return true;
      }
  return false;
}

/** praças e largos abertos (sem lotes) */
const OPEN: { x: number; z: number; r: number }[] = [
  { x: SOL[0], z: SOL[1], r: 34 },
  { x: G1.x, z: G1.z, r: G1.r + 12 },
  { x: G2.x, z: G2.z, r: G2.r + 12 },
];
// largos da Via Larga nos cruzamentos com as avenidas
for (const x of AVES) {
  for (let i = 1; i < BROADWAY.length; i++) {
    const a = BROADWAY[i - 1];
    const b = BROADWAY[i];
    if ((a[0] - x) * (b[0] - x) <= 0 && a[0] !== b[0]) {
      const t = (x - a[0]) / (b[0] - a[0]);
      OPEN.push({ x, z: a[1] + (b[1] - a[1]) * t, r: 20 });
    }
  }
}
const blockedGreens = greens.filter((gr) => gr.kind !== 'wood');
function freeLand(r: Ring) {
  const pts = [...r, centroid(r)];
  for (const [x, z] of pts) {
    if (Math.abs(x) > HALF - 4 || Math.abs(z) > HALF - 4) return false;
    if (Math.abs(x - riverX(z)) < RIVER_W / 2 + 6) return false;
    if (OPEN.some((o) => Math.hypot(x - o.x, z - o.z) < o.r)) return false;
    if (blockedGreens.some((gr) => pointInPoly(x, z, gr.outer))) return false;
    if (waterAreas.some((w) => pointInPoly(x, z, w.outer))) return false;
    if (inCPark(x, z, -2) || inRetiro(x, z, -2)) return false;
  }
  // nenhuma rua passando pelo lote (bordas e meio das arestas)
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    for (const t of [0, 0.25, 0.5, 0.75]) if (streetClearance(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) < 1.2) return false;
  }
  const c = centroid(r);
  return streetClearance(c[0], c[1]) > 1.2;
}

function addBuilding(o: { lotId: string; outer: Ring; holes?: Ring[]; type: string; category: BuildingCategory; levels: number; name?: string; street: string; number: number; lotOuter?: Ring }) {
  const id = `gen/${bid}`;
  const a = area(o.outer) - (o.holes ?? []).reduce((s, h) => s + area(h), 0);
  const c = centroid(o.outer);
  const address = { street: o.street, housenumber: String(o.number) };
  buildings.push({
    id,
    osmId: bid,
    osmType: 'way',
    lotId: o.lotId,
    name: o.name,
    type: o.type,
    category: o.category,
    levels: o.levels,
    height: o.levels * 3,
    heightFromTag: false,
    generated: true,
    outer: o.outer,
    holes: o.holes,
    area: r1(a),
    centroid: c,
    address,
  });
  const zoning = { residential: 'R2', commercial: 'C1', industrial: 'I1', institutional: 'INST', religious: 'INST' }[o.category];
  lots.push({ lotId: o.lotId, buildingId: id, outer: o.lotOuter, area: r1(area(o.lotOuter ?? o.outer)), centroid: c, address, ownerId: null, price: null, zoning });
  bid++;
}

// --- marcos (antes dos lotes comuns)
{
  // Praça Maior: quadra fechada com pátio, eixo longo na direção radial
  const th = (RAD[2] + RAD[3]) / 2;
  const [cx, cz] = polar(70, th);
  const ux = Math.cos(th);
  const uz = Math.sin(th);
  const outer = orientedRect(cx, cz, ux, uz, 22, 17);
  addBuilding({ lotId: 'VA-PRACA-MAIOR', outer, holes: [orientedRect(cx, cz, ux, uz, 13, 8)], type: 'apartments', category: 'residential', levels: 4, name: 'Praça Maior', street: 'Praça Maior', number: 1 });
  occupy(outer);
  // catedral (setor norte do centro histórico, entre radiais sem viela)
  const tc = (RAD[5] + RAD[6]) / 2;
  const [kx, kz] = polar(158, tc);
  const cat = orientedRect(kx, kz, Math.cos(tc), Math.sin(tc), 16, 10);
  addBuilding({ lotId: 'VA-CATEDRAL', outer: cat, type: 'cathedral', category: 'religious', levels: 6, name: 'Catedral de Santa Aurora', street: 'Rua da Prata', number: 2 });
  occupy(orientedRect(kx, kz, Math.cos(tc), Math.sin(tc), 22, 14));
  // museu junto ao Passeio do Prado
  const mus = rectRing(-PASEO - 9 - 26, 70, -PASEO - 9, 150);
  if (freeLand(mus)) {
    addBuilding({ lotId: 'VA-MUSEU', outer: mus, type: 'museum', category: 'institutional', levels: 3, name: 'Museu Nacional de Arte', street: 'Passeio do Prado', number: 10 });
    occupy(mus);
  }
  // palácio municipal em frente à rotatória da Cibele
  const pal = rectRing(PASEO + 9, G1.r + 14, PASEO + 9 + 46, G1.r + 14 + 30);
  if (freeLand(pal)) {
    addBuilding({ lotId: 'VA-PREFEITURA', outer: pal, type: 'townhall', category: 'institutional', levels: 5, name: 'Palácio Municipal', street: 'Rotatória da Cibele', number: 1 });
    occupy(pal);
  }
}

// --- lotes ao longo das ruas (serve para grade, radiais e curvas)
const NO_LOTS = new Set<RoadKind>(['footway', 'path', 'steps', 'cycleway', 'pedestrian']);
const SIDEWALK = 3;
let vacantCount = 0;
// ruas mais largas primeiro: os lotes de esquina ficam de frente para elas
const order = streets.map((s, i) => ({ s, r: roads[i] })).sort((a, b) => b.s.width - a.s.width);
for (const { s, r } of order) {
  if (NO_LOTS.has(s.kind) || r.noLots || s.bridge) continue;
  for (let si = 1; si < s.points.length; si++) {
    const a = s.points[si - 1];
    const b = s.points[si];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 6) continue;
    const ux = (b[0] - a[0]) / len;
    const uz = (b[1] - a[1]) / len;
    for (const side of [-1, 1]) {
      const nx = -uz * side;
      const nz = ux * side;
      let t = 0;
      let n = 1;
      while (t < len - 5) {
        const mx = a[0] + ux * t;
        const mz = a[1] + uz * t;
        const zone = zoneAt(mx + nx * 12, mz + nz * 12);
        const spec = ZONES[zone];
        let placed = false;
        for (const wf of [1, 0.75]) {
          const w = Math.min(rand(spec.w[0], spec.w[1]) * wf, len - t);
          if (w < spec.w[0] * 0.7) break;
          for (const df of [1, 0.75, 0.55]) {
            const depth = spec.depth * df + spec.front;
            const off = s.width / 2 + SIDEWALK;
            const fx = mx + ux * (w / 2) + nx * off;
            const fz = mz + uz * (w / 2) + nz * off;
            const lot = orientedRect(fx + nx * (depth / 2), fz + nz * (depth / 2), ux, uz, w / 2, depth / 2);
            if (!freeLand(lot) || overlapsOccupied(lot)) continue;
            occupy(lot);
            const lotId = `VA-${zone.toUpperCase()}-${s.osmId}-${si}${side > 0 ? 'D' : 'E'}${n}`;
            const number = Math.round(t + w / 2) * 2 + (side > 0 ? 0 : 1);
            if (zone === 'ensanche' && rng() < 0.03) {
              vacantCount++;
              lots.push({ lotId, buildingId: null, outer: lot, vacant: true, area: r1(area(lot)), centroid: centroid(lot), address: { street: s.name ?? '', housenumber: String(number) }, ownerId: null, price: null, zoning: 'R2' });
            } else {
              const bw = w - spec.side * 2;
              const bd = depth - spec.front - (zone === 'docks' ? 6 : 0.4);
              const bcx = fx + nx * (spec.front + bd / 2);
              const bcz = fz + nz * (spec.front + bd / 2);
              const shop = rng() < spec.shop;
              const levels = Math.round(rand(spec.levels[0], spec.levels[1] + 0.49));
              const category: BuildingCategory = zone === 'docks' ? 'industrial' : shop ? 'commercial' : 'residential';
              const type = zone === 'docks' ? 'warehouse' : shop ? 'commercial' : levels >= 3 ? 'apartments' : 'house';
              addBuilding({ lotId, outer: orientedRect(bcx, bcz, ux, uz, bw / 2, bd / 2), type, category, levels, street: s.name ?? '', number });
            }
            t += w;
            n++;
            placed = true;
            break;
          }
          if (placed) break;
        }
        if (!placed) t += 3;
      }
    }
  }
}

// ------------------------------------------------------------------ saída

const data: CityData = {
  version: 1,
  name: 'Vila Aurora',
  generatedAt: new Date().toISOString(),
  attribution: 'Cidade fictícia gerada proceduralmente (scripts/generate-city.ts), inspirada em Nova York e Madri',
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
console.log(`Vila Aurora: ${streets.length} ruas, ${nodeIds.size} nós, ${buildings.length} prédios ${JSON.stringify(counts)}, ${lots.length} lotes (${vacantCount} vagos) -> ${OUT}`);
