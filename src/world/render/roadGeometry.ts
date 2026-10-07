import * as THREE from 'three';
import type { Street, Vec2, WaterLine } from '../../data/types';
import type { HeightField } from '../HeightField';
import type { WorldState } from '../WorldState';
import { GeometryWriter } from './GeometryWriter';

const UPV = new THREE.Vector3(0, 1, 0);

/** Densifica a polilinha (passo máx em metros) para acompanhar o relevo. */
export function densify(points: Vec2[], maxStep: number): Vec2[] {
  const out: Vec2[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1];
    const [bx, bz] = points[i];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.ceil(len / maxStep);
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}

type HeightFn = (x: number, z: number, i: number, t: number) => number;

interface Frame {
  /** normal à esquerda com fator de esquadria */
  nx: number;
  nz: number;
  miter: number;
  dist: number;
}

function frames(pts: Vec2[]): Frame[] {
  const n = pts.length;
  const out: Frame[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const p = pts[i];
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(n - 1, i + 1)];
    let t1x = p[0] - prev[0];
    let t1z = p[1] - prev[1];
    let t2x = next[0] - p[0];
    let t2z = next[1] - p[1];
    const l1 = Math.hypot(t1x, t1z) || 1;
    const l2 = Math.hypot(t2x, t2z) || 1;
    t1x /= l1;
    t1z /= l1;
    t2x /= l2;
    t2z /= l2;
    if (i === 0) [t1x, t1z] = [t2x, t2z];
    if (i === n - 1) [t2x, t2z] = [t1x, t1z];
    let tx = t1x + t2x;
    let tz = t1z + t2z;
    const tl = Math.hypot(tx, tz);
    if (tl < 1e-6) [tx, tz] = [t2x, t2z];
    else [tx, tz] = [tx / tl, tz / tl];
    const nx = -tz;
    const nz = tx;
    const miter = Math.min(2.2, 1 / Math.max(0.35, nx * -t2z + nz * t2x));
    out.push({ nx, nz, miter, dist: acc });
  }
  return out;
}

/**
 * Faixa entre dois deslocamentos laterais (a < b; positivo = esquerda).
 * UV em metros: u = lateral, v = distância.
 */
export function writeStrip(w: GeometryWriter, pts: Vec2[], a: number, b: number, c: THREE.Color, heightAt: HeightFn, flow?: { offset: number }) {
  const n = pts.length;
  if (n < 2) return;
  const fr = frames(pts);
  const L: THREE.Vector3[] = [];
  const R: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const f = fr[i];
    const t = i / (n - 1);
    const p = pts[i];
    const ax = p[0] + f.nx * a * f.miter;
    const az = p[1] + f.nz * a * f.miter;
    const bx = p[0] + f.nx * b * f.miter;
    const bz = p[1] + f.nz * b * f.miter;
    R.push(new THREE.Vector3(ax, heightAt(ax, az, i, t), az));
    L.push(new THREE.Vector3(bx, heightAt(bx, bz, i, t), bz));
  }
  const width = b - a;
  for (let i = 0; i < n - 1; i++) {
    const d0 = fr[i].dist + (flow?.offset ?? 0);
    const d1 = fr[i + 1].dist + (flow?.offset ?? 0);
    const uv = [b, d0, a, d0, a, d1, b, d1];
    const fac = flow ? [d0, 0, width, -1, d0, 1, width, -1, d1, 1, width, -1, d1, 0, width, -1] : undefined;
    w.quad(L[i], R[i], R[i + 1], L[i + 1], c, UPV, uv, fac);
  }
}

/** Faixa centrada (largura total) */
export function writeRibbon(w: GeometryWriter, pts: Vec2[], width: number, c: THREE.Color, heightAt: HeightFn, flow?: { offset: number }) {
  writeStrip(w, pts, -width / 2, width / 2, c, heightAt, flow);
}

/** Parede vertical ao longo de um deslocamento lateral (meio-fio, guarda-corpo). */
function writeSideWall(w: GeometryWriter, pts: Vec2[], off: number, y0: HeightFn, y1: HeightFn, c: THREE.Color, outward: 1 | -1) {
  const fr = frames(pts);
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    const f0 = fr[i];
    const f1 = fr[i + 1];
    const ax = p[0] + f0.nx * off * f0.miter;
    const az = p[1] + f0.nz * off * f0.miter;
    const bx = q[0] + f1.nx * off * f1.miter;
    const bz = q[1] + f1.nz * off * f1.miter;
    const t0 = i / (n - 1);
    const t1 = (i + 1) / (n - 1);
    const A = new THREE.Vector3(ax, y0(ax, az, i, t0), az);
    const B = new THREE.Vector3(bx, y0(bx, bz, i + 1, t1), bz);
    const C = new THREE.Vector3(bx, y1(bx, bz, i + 1, t1), bz);
    const D = new THREE.Vector3(ax, y1(ax, az, i, t0), az);
    const facing = new THREE.Vector3(f0.nx * outward, 0, f0.nz * outward);
    w.quad(A, B, C, D, c, facing, [fr[i].dist, A.y, fr[i + 1].dist, B.y, fr[i + 1].dist, C.y, fr[i].dist, D.y]);
  }
}

const VEHICLE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street']);
const FOOT = new Set(['footway', 'path', 'steps', 'cycleway', 'pedestrian', 'track']);

export const SIDEWALK_WIDTH = 1.8;
const ROAD_LIFT = 0.06;
const CURB = 0.16;

export function hasSidewalk(s: Street) {
  return VEHICLE.has(s.kind);
}

/** função de altura para a via: segue o relevo; pontes interpolam entre as cabeceiras */
function streetHeight(s: Street, pts: Vec2[], hf: HeightField, lift: number): HeightFn {
  if (s.bridge) {
    const h0 = hf.sample(pts[0][0], pts[0][1]);
    const h1 = hf.sample(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    return (_x, _z, _i, t) => h0 + (h1 - h0) * t + lift + 0.4;
  }
  return (x, z) => hf.sample(x, z) + lift;
}

interface Junction {
  x: number;
  z: number;
  /** raio livre de calçada em volta do cruzamento */
  r: number;
}

const junctionCache = new WeakMap<WorldState, Map<number, Junction>>();

/** Cruzamentos de vias de veículos (nós OSM com 3+ incidências). */
function junctions(world: WorldState): Map<number, Junction> {
  let j = junctionCache.get(world);
  if (j) return j;
  const inc = new Map<number, { n: number; w: number; x: number; z: number }>();
  for (const s of world.data.streets) {
    if (!VEHICLE.has(s.kind) && s.kind !== 'service') continue;
    s.nodes.forEach((id, i) => {
      const end = i === 0 || i === s.nodes.length - 1;
      const e = inc.get(id) ?? { n: 0, w: 0, x: s.points[i][0], z: s.points[i][1] };
      e.n += end ? 1 : 2;
      e.w = Math.max(e.w, s.width);
      inc.set(id, e);
    });
  }
  j = new Map();
  for (const [id, e] of inc) if (e.n >= 3) j.set(id, { x: e.x, z: e.z, r: e.w / 2 + SIDEWALK_WIDTH + 0.4 });
  junctionCache.set(world, j);
  return j;
}

/** divide a polilinha em trechos fora dos raios dos cruzamentos */
function runsOutside(pts: Vec2[], js: Junction[], keep: (p: Vec2) => boolean): Vec2[][] {
  const runs: Vec2[][] = [];
  let cur: Vec2[] = [];
  for (const p of pts) {
    const blocked = !keep(p) || js.some((j) => (p[0] - j.x) ** 2 + (p[1] - j.z) ** 2 < j.r * j.r);
    if (blocked) {
      if (cur.length >= 2) runs.push(cur);
      cur = [];
    } else cur.push(p);
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

// cores absolutas (texturas normalizadas: só dão o detalhe)
const C_ASPHALT = new THREE.Color('#55595e');
const C_SERVICE = new THREE.Color('#6a6d70');
const C_WHITE = new THREE.Color('#eeebe2');
const C_YELLOW = new THREE.Color('#e3b83c');
const C_WALK = new THREE.Color('#bdb7ab');
const C_CURB = new THREE.Color('#d6d2c9');
const C_FOOT = new THREE.Color('#cbb894');
const C_TRACK = new THREE.Color('#a8714f');

/** Escreve a via inteira: pista, marcações, calçadas com meio-fio, faixas de pedestre. */
export function writeStreet(asphalt: GeometryWriter, walk: GeometryWriter, s: Street, hf: HeightField, world: WorldState) {
  if (FOOT.has(s.kind)) {
    const pts = densify(s.points, 4);
    writeRibbon(walk, pts, s.width, s.kind === 'track' ? C_TRACK : s.kind === 'pedestrian' ? C_WALK : C_FOOT, streetHeight(s, pts, hf, 0.12));
    return;
  }
  const pts = densify(s.points, 3);
  const half = s.width / 2;
  const road = streetHeight(s, pts, hf, ROAD_LIFT);
  writeRibbon(asphalt, pts, s.width, s.kind === 'service' ? C_SERVICE : C_ASPHALT, road);

  const allJ = junctions(world);
  const myJ: Junction[] = [];
  s.nodes.forEach((id) => {
    const j = allJ.get(id);
    if (j) myJ.push(j);
  });

  // ---- marcações (linhas tracejadas centrais e de bordo), fora dos cruzamentos
  const paint = streetHeight(s, pts, hf, ROAD_LIFT + 0.015);
  if (s.width >= 6.5 && VEHICLE.has(s.kind)) {
    const runs = runsOutside(pts, myJ.map((j) => ({ ...j, r: j.r - 0.5 })), () => true);
    const yellow = ['primary', 'secondary', 'trunk'].includes(s.kind);
    for (const run of runs) {
      if (!s.oneway) {
        // tracejado: 3 m pintado / 3 m vazio
        let acc = 0;
        let dash: Vec2[] = [];
        for (let i = 0; i < run.length; i++) {
          if (i > 0) acc += Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
          if (acc % 6 < 3) dash.push(run[i]);
          else {
            if (dash.length) dash.push(run[i]);
            if (dash.length >= 2) writeRibbon(asphalt, dash, 0.14, yellow ? C_YELLOW : C_WHITE, paint);
            dash = [];
          }
        }
        if (dash.length >= 2) writeRibbon(asphalt, dash, 0.14, yellow ? C_YELLOW : C_WHITE, paint);
      }
      if (s.width >= 8) {
        writeStrip(asphalt, run, -half + 0.3, -half + 0.42, C_WHITE, paint);
        writeStrip(asphalt, run, half - 0.42, half - 0.3, C_WHITE, paint);
      }
    }
  }

  // ---- calçadas elevadas + meio-fio (só na área urbana)
  if (hasSidewalk(s)) {
    const inTown = (p: Vec2) => world.isInsideBounds(p[0], p[1], 40);
    const runs = runsOutside(pts, myJ, inTown);
    const top = streetHeight(s, pts, hf, ROAD_LIFT + CURB);
    for (const run of runs) {
      for (const side of [1, -1] as const) {
        const a = side === 1 ? half : -half - SIDEWALK_WIDTH;
        const b = side === 1 ? half + SIDEWALK_WIDTH : -half;
        writeStrip(walk, run, a, b, C_WALK, top);
        // face do meio-fio (voltada para a pista)
        writeSideWall(walk, run, side * half, road, top, C_CURB, side === 1 ? -1 : 1);
        // face externa (para o lote) — evita ver por baixo em declive
        const outer = side * (half + SIDEWALK_WIDTH);
        writeSideWall(walk, run, outer, (x, z) => hf.sample(x, z) - 0.3, top, C_WALK, side === 1 ? 1 : -1);
      }
    }
  }

  // ---- guarda-corpo em pontes
  if (s.bridge) {
    const rail = streetHeight(s, pts, hf, ROAD_LIFT + 1.0);
    for (const side of [1, -1] as const) {
      const off = side * (half + 0.15);
      writeSideWall(walk, pts, off, road, rail, C_CURB, side === 1 ? 1 : -1);
      writeSideWall(walk, pts, off, road, rail, C_CURB, side === 1 ? -1 : 1);
    }
  }

  // ---- faixas de pedestre na chegada aos cruzamentos (zebra)
  if (VEHICLE.has(s.kind) && s.width >= 5.5) {
    s.nodes.forEach((id, i) => {
      const j = allJ.get(id);
      if (!j || !world.isInsideBounds(j.x, j.z, 0)) return;
      for (const dir of [-1, 1]) {
        const k = i + dir;
        if (k < 0 || k >= s.points.length) continue;
        const [px, pz] = s.points[i];
        const [qx, qz] = s.points[k];
        const len = Math.hypot(qx - px, qz - pz);
        if (len < j.r + 3) continue;
        const ux = (qx - px) / len;
        const uz = (qz - pz) / len;
        const along = j.r - 1.4;
        const cx = px + ux * along;
        const cz = pz + uz * along;
        const nx = -uz;
        const nz = ux;
        for (let x = -half + 0.5; x < half - 0.5; x += 1.0) {
          const P = (lat: number, lon: number) => {
            const X = cx + nx * lat + ux * lon;
            const Z = cz + nz * lat + uz * lon;
            return new THREE.Vector3(X, hf.sample(X, Z) + ROAD_LIFT + 0.02, Z);
          };
          asphalt.quad(P(x, -1.4), P(x + 0.5, -1.4), P(x + 0.5, 1.4), P(x, 1.4), C_WHITE, UPV, [x, -1.4, x + 0.5, -1.4, x + 0.5, 1.4, x, 1.4]);
        }
      }
    });
  }
}

/** Rio/córrego: margem + lâmina d'água (com coordenada de fluxo para animação). */
export function writeWaterLine(water: GeometryWriter, bank: GeometryWriter, wl: WaterLine, hf: HeightField) {
  const pts = densify(wl.points, 5);
  const width = Math.max(1.2, wl.width);
  writeRibbon(bank, pts, width + 5, new THREE.Color('#7d7656'), (x, z) => hf.sample(x, z) + 0.04);
  writeRibbon(water, pts, width, new THREE.Color(1, 1, 1), (x, z) => hf.sample(x, z) + 0.14, { offset: 0 });
}
