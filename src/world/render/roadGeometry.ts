import * as THREE from 'three';
import type { Street, Vec2, WaterLine } from '../../data/types';
import type { HeightField } from '../HeightField';
import { GeometryWriter } from './GeometryWriter';
import { PALETTE, color } from './palette';

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

/**
 * Faixa (ribbon) ao longo de uma polilinha, com junções em esquadria
 * limitadas. `heightAt` define a altura de cada vértice.
 */
export function writeRibbon(
  w: GeometryWriter,
  pts: Vec2[],
  width: number,
  c: THREE.Color,
  heightAt: HeightFn,
  flow?: { offset: number },
) {
  const n = pts.length;
  if (n < 2) return;
  const half = width / 2;
  const left: THREE.Vector3[] = [];
  const right: THREE.Vector3[] = [];
  const dist: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    dist.push(acc);
    const p = pts[i];
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(n - 1, i + 1)];
    // tangentes dos dois segmentos
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
    if (i === 0) {
      t1x = t2x;
      t1z = t2z;
    }
    if (i === n - 1) {
      t2x = t1x;
      t2z = t1z;
    }
    let tx = t1x + t2x;
    let tz = t1z + t2z;
    const tl = Math.hypot(tx, tz);
    if (tl < 1e-6) {
      tx = t2x;
      tz = t2z;
    } else {
      tx /= tl;
      tz /= tl;
    }
    // normal à esquerda
    const nx = -tz;
    const nz = tx;
    const miter = Math.min(2.2, 1 / Math.max(0.35, nx * -t2z + nz * t2x));
    const ox = nx * half * miter;
    const oz = nz * half * miter;
    const t = n > 1 ? i / (n - 1) : 0;
    left.push(new THREE.Vector3(p[0] + ox, heightAt(p[0] + ox, p[1] + oz, i, t), p[1] + oz));
    right.push(new THREE.Vector3(p[0] - ox, heightAt(p[0] - ox, p[1] - oz, i, t), p[1] - oz));
  }
  for (let i = 0; i < n - 1; i++) {
    if (flow) {
      const d0 = dist[i] + flow.offset;
      const d1 = dist[i + 1] + flow.offset;
      w.quad(left[i], right[i], right[i + 1], left[i + 1], c, UPV, [
        [d0, 0, width, -1],
        [d0, 1, width, -1],
        [d1, 1, width, -1],
        [d1, 0, width, -1],
      ]);
    } else {
      w.quad(left[i], right[i], right[i + 1], left[i + 1], c, UPV);
    }
  }
}

const VEHICLE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street']);
const FOOT = new Set(['footway', 'path', 'steps', 'cycleway', 'pedestrian', 'track']);

export const SIDEWALK_WIDTH = 1.6;

export function hasSidewalk(s: Street) {
  return VEHICLE.has(s.kind);
}

/** função de altura para a rua: segue o relevo; pontes interpolam entre as cabeceiras */
function streetHeight(s: Street, pts: Vec2[], hf: HeightField, lift: number): HeightFn {
  if (s.bridge) {
    const h0 = hf.sample(pts[0][0], pts[0][1]);
    const h1 = hf.sample(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    return (_x, _z, _i, t) => h0 + (h1 - h0) * t + lift + 0.4;
  }
  return (x, z) => hf.sample(x, z) + lift;
}

/** Escreve a rua inteira (calçada, pista, faixa central). */
export function writeStreet(asphalt: GeometryWriter, walk: GeometryWriter, s: Street, hf: HeightField) {
  const pts = densify(s.points, 4);
  if (FOOT.has(s.kind)) {
    const c = color(s.kind === 'track' ? PALETTE.terrainSoil : s.kind === 'pedestrian' ? PALETTE.sidewalk : PALETTE.footway);
    writeRibbon(walk, pts, s.width, c, streetHeight(s, pts, hf, 0.12));
    return;
  }
  if (hasSidewalk(s)) writeRibbon(walk, pts, s.width + SIDEWALK_WIDTH * 2, color(PALETTE.sidewalk), streetHeight(s, pts, hf, 0.1));
  const c = color(s.kind === 'service' ? PALETTE.asphaltLight : PALETTE.asphalt);
  writeRibbon(asphalt, pts, s.width, c, streetHeight(s, pts, hf, 0.16));
  // faixa central tracejada nas vias de mão dupla largas
  if (s.width >= 7 && !s.oneway) {
    const mc = color(['primary', 'secondary', 'trunk'].includes(s.kind) ? PALETTE.markingYellow : PALETTE.marking);
    const h = streetHeight(s, pts, hf, 0.2);
    let acc = 0;
    let dash: Vec2[] = [];
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const on = acc % 8 < 4;
      if (on) dash.push(pts[i]);
      else if (dash.length) {
        dash.push(pts[i]);
        if (dash.length >= 2) writeRibbon(asphalt, dash, 0.18, mc, h);
        dash = [];
      }
    }
    if (dash.length >= 2) writeRibbon(asphalt, dash, 0.18, mc, h);
  }
}

/** Rio/córrego: margem + lâmina d'água (com coordenada de fluxo para animação). */
export function writeWaterLine(water: GeometryWriter, bank: GeometryWriter, wl: WaterLine, hf: HeightField) {
  const pts = densify(wl.points, 5);
  const width = Math.max(1.2, wl.width);
  writeRibbon(bank, pts, width + 4, color('#8c9b6b'), (x, z) => hf.sample(x, z) + 0.05);
  writeRibbon(water, pts, width, color(PALETTE.water), (x, z) => hf.sample(x, z) + 0.12, { offset: 0 });
}
