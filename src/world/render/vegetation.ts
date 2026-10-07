import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GreenArea, GreenKind } from '../../data/types';
import type { WorldState } from '../WorldState';
import { distSqToSegment, hashId, mulberry32, pointInPolygon, ringBounds } from '../geo';
import { PALETTE, color } from './palette';

export interface TreeInstance {
  x: number;
  z: number;
  y: number;
  scale: number;
  rot: number;
  kind: 0 | 1;
  tint: number;
}

function colorize(g: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry {
  const g2 = g.index ? g.toNonIndexed() : g;
  const n = g2.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g2.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g2.deleteAttribute('uv');
  g2.computeVertexNormals();
  return g2;
}

/** Duas árvores low-poly (copa redonda e cônica), com tronco, ~30 triângulos cada. */
export function createTreeGeometries(): THREE.BufferGeometry[] {
  const trunk = colorize(new THREE.CylinderGeometry(0.18, 0.26, 2.2, 5, 1).translate(0, 1.1, 0), color(PALETTE.trunk));
  const round = colorize(new THREE.IcosahedronGeometry(2.1, 0).scale(1, 0.9, 1).translate(0, 3.6, 0), color('#ffffff'));
  const cone = colorize(new THREE.ConeGeometry(1.8, 5.2, 6, 1).translate(0, 4.4, 0), color('#ffffff'));
  // copa branca * instanceColor = tom de verde da instância; tronco escuro fica escuro
  return [mergeGeometries([trunk, round])!, mergeGeometries([trunk.clone(), cone])!];
}

const DENSITY: Partial<Record<GreenKind, number>> = {
  wood: 1 / 45,
  scrub: 1 / 160,
  park: 1 / 140,
  garden: 1 / 110,
  grass: 1 / 500,
  meadow: 1 / 900,
  cemetery: 1 / 260,
};

/**
 * Distribui árvores (determinístico): áreas verdes, calçadas de ruas
 * residenciais e morros fora da área urbana.
 */
export function scatterTrees(world: WorldState, mobile: boolean): TreeInstance[] {
  const out: TreeInstance[] = [];
  const hf = world.height;
  const factor = mobile ? 0.55 : 1;
  const leafTints = PALETTE.treeLeaves.length;

  const blocked = (x: number, z: number) => {
    for (const b of world.buildingsNear(x, z, 3)) if (pointInPolygon(x, z, b.outer)) return true;
    return false;
  };
  // grade de segmentos de rua para evitar árvores no asfalto
  const roadCell = 30;
  const roadGrid = new Map<string, { a: [number, number]; b: [number, number]; r: number }[]>();
  for (const s of world.data.streets)
    for (let i = 0; i < s.points.length - 1; i++) {
      const a = s.points[i];
      const b = s.points[i + 1];
      const r = s.width / 2 + 1.2;
      for (let gx = Math.floor((Math.min(a[0], b[0]) - r) / roadCell); gx <= Math.floor((Math.max(a[0], b[0]) + r) / roadCell); gx++)
        for (let gz = Math.floor((Math.min(a[1], b[1]) - r) / roadCell); gz <= Math.floor((Math.max(a[1], b[1]) + r) / roadCell); gz++) {
          const k = `${gx},${gz}`;
          if (!roadGrid.has(k)) roadGrid.set(k, []);
          roadGrid.get(k)!.push({ a, b, r });
        }
    }
  const onRoad = (x: number, z: number) => {
    for (const s of roadGrid.get(`${Math.floor(x / roadCell)},${Math.floor(z / roadCell)}`) ?? [])
      if (distSqToSegment(x, z, s.a[0], s.a[1], s.b[0], s.b[1]).d2 < s.r * s.r) return true;
    return false;
  };
  const onWater = (x: number, z: number) => {
    for (const w of world.data.waterLines)
      for (let i = 0; i < w.points.length - 1; i++) {
        const a = w.points[i];
        const b = w.points[i + 1];
        if (distSqToSegment(x, z, a[0], a[1], b[0], b[1]).d2 < (w.width / 2 + 2.5) ** 2) return true;
      }
    return false;
  };
  const add = (x: number, z: number, rng: () => number, scale = 1) => {
    out.push({
      x,
      z,
      y: hf.sample(x, z) - 0.2,
      scale: scale * (0.75 + rng() * 0.6),
      rot: rng() * Math.PI * 2,
      kind: rng() < 0.7 ? 0 : 1,
      tint: Math.floor(rng() * leafTints),
    });
  };

  // 1) áreas verdes
  for (const g of world.data.greens) scatterInGreen(g, factor, add, blocked, onRoad);

  // 2) árvores de calçada em ruas residenciais
  for (const s of world.data.streets) {
    if (!['residential', 'tertiary', 'living_street', 'secondary'].includes(s.kind)) continue;
    const rng = mulberry32(hashId(s.osmId) ^ 0x51ed);
    for (let i = 0; i < s.points.length - 1; i++) {
      const [ax, az] = s.points[i];
      const [bx, bz] = s.points[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1) continue;
      const ux = (bx - ax) / len;
      const uz = (bz - az) / len;
      for (let t = 6 + rng() * 10; t < len - 4; t += (16 + rng() * 22) / factor) {
        if (rng() > 0.45) continue;
        const side = rng() < 0.5 ? 1 : -1;
        const off = s.width / 2 + 1.0;
        const x = ax + ux * t - uz * off * side;
        const z = az + uz * t + ux * off * side;
        if (!world.isInsideBounds(x, z) || blocked(x, z) || onRoad(x, z)) continue;
        add(x, z, rng, 0.7);
      }
    }
  }

  // 3) morros ao redor (fora da área de dados), em manchas de mata
  const b = world.data.bounds;
  const hm = world.data.heightmap;
  const ext = hm ? hm.minX + (hm.size - 1) * hm.cellSize : b.maxX + 400;
  const rng = mulberry32(1234567);
  const spacing = 13 / Math.sqrt(factor);
  for (let x = -ext + 5; x < ext - 5; x += spacing)
    for (let z = -ext + 5; z < ext - 5; z += spacing) {
      const px = x + (rng() - 0.5) * spacing;
      const pz = z + (rng() - 0.5) * spacing;
      const inside = world.isInsideBounds(px, pz, -10);
      const noise = Math.sin(px * 0.013) * Math.cos(pz * 0.011) + Math.sin((px + pz) * 0.021) * 0.5;
      const edge = world.isInsideBounds(px, pz, 60) && !inside;
      if (inside) continue;
      // encostas mais íngremes têm mais mata (como os morros de Itabirito)
      const slope = hf.slope(px, pz);
      const p = (noise > 0.15 ? 0.55 : 0.08) + Math.min(slope, 0.4) * 0.8 - (edge ? 0.3 : 0);
      if (rng() > p) continue;
      if (onRoad(px, pz) || onWater(px, pz)) continue;
      add(px, pz, rng, 1.1);
    }
  return out;
}

function scatterInGreen(
  g: GreenArea,
  factor: number,
  add: (x: number, z: number, rng: () => number, scale?: number) => void,
  blocked: (x: number, z: number) => boolean,
  onRoad: (x: number, z: number) => boolean,
) {
  const d = DENSITY[g.kind];
  if (!d) return;
  const rb = ringBounds(g.outer);
  const area = (rb.maxX - rb.minX) * (rb.maxZ - rb.minZ);
  const rng = mulberry32(hashId(Number(g.id.replace(/\D/g, '').slice(0, 15)) || 1));
  const count = Math.min(4000, Math.floor(area * d * factor));
  for (let k = 0; k < count; k++) {
    const x = rb.minX + rng() * (rb.maxX - rb.minX);
    const z = rb.minZ + rng() * (rb.maxZ - rb.minZ);
    if (!pointInPolygon(x, z, g.outer, g.holes)) continue;
    if (blocked(x, z) || onRoad(x, z)) continue;
    add(x, z, rng, g.kind === 'wood' ? 1.15 : 1);
  }
}

/** Cores de copa por índice de tint */
export function leafColors(): THREE.Color[] {
  return PALETTE.treeLeaves.map((h) => new THREE.Color(h));
}
