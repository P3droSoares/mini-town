import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { QualityPreset } from '../../core/quality';
import type { GreenKind, Ring } from '../../data/types';
import type { WorldState } from '../WorldState';
import { distSqToSegment, hashId, mulberry32, pointInPolygon, ringBounds } from '../geo';

/** Espécies estilizadas (diorama). */
export enum Species {
  Round = 0,
  Pine = 1,
  Ipe = 2,
  Palm = 3,
}

export interface TreeInstance {
  x: number;
  z: number;
  y: number;
  scale: number;
  rot: number;
  kind: Species;
  tint: number;
}

// ----------------------------------------------------------------- geometria

/** cor de vértice constante */
function colored(g: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  if (ng.attributes.uv) ng.deleteAttribute('uv');
  const c = new THREE.Color(hex);
  const n = ng.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  ng.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (!ng.attributes.normal) ng.computeVertexNormals();
  return ng;
}

/** junta vértices coincidentes (normais suaves) */
function mergeVerticesSimple(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = g.attributes.position;
  const map = new Map<string, number>();
  const verts: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const k = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    let id = map.get(k);
    if (id === undefined) {
      id = verts.length / 3;
      map.set(k, id);
      verts.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
    index.push(id);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  out.setIndex(index);
  return out;
}

/** esfera "massinha": icosaedro com normais suaves (não indexada no fim) */
function blob(r: number, detail: number, x: number, y: number, z: number, sy = 0.9): THREE.BufferGeometry {
  const g = mergeVerticesSimple(new THREE.IcosahedronGeometry(r, detail));
  g.scale(1, sy, 1).translate(x, y, z);
  g.computeVertexNormals();
  return g.toNonIndexed();
}

interface SpeciesGeo {
  /** tronco (cor própria, sem tint) */
  trunk: THREE.BufferGeometry;
  /** copa (branca, tingida por instância) */
  crown: THREE.BufferGeometry;
  /** copa simplificada (longe) */
  crownFar: THREE.BufferGeometry;
}

function speciesGeometry(kind: Species): SpeciesGeo {
  const trunkC = '#8a6446';
  if (kind === Species.Pine) {
    const tiers = (seg: number) =>
      mergeGeometries([
        colored(new THREE.ConeGeometry(1.9, 2.6, seg).translate(0, 2.6, 0), '#ffffff'),
        colored(new THREE.ConeGeometry(1.5, 2.3, seg).translate(0, 3.9, 0), '#ffffff'),
        colored(new THREE.ConeGeometry(1.0, 2.0, seg).translate(0, 5.1, 0), '#ffffff'),
      ])!;
    return { trunk: colored(new THREE.CylinderGeometry(0.16, 0.22, 1.6, 6).translate(0, 0.6, 0), trunkC), crown: tiers(8), crownFar: tiers(5) };
  }
  if (kind === Species.Palm) {
    const leaves = (n: number) => {
      const parts: THREE.BufferGeometry[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const blade = new THREE.ConeGeometry(0.45, 3.2, 3, 1).rotateX(Math.PI / 2).scale(1, 0.25, 1).translate(0, 0, 1.6);
        blade.rotateX(0.35).rotateY(a).translate(0, 7.4, 0);
        parts.push(colored(blade, '#ffffff'));
      }
      parts.push(colored(new THREE.IcosahedronGeometry(0.35, 0).translate(0, 7.4, 0), '#ffffff'));
      return mergeGeometries(parts)!;
    };
    return { trunk: colored(new THREE.CylinderGeometry(0.16, 0.24, 7.6, 6).translate(0, 3.6, 0), '#b59a7a'), crown: leaves(7), crownFar: leaves(5) };
  }
  // copa redonda (árvore de rua / ipê): 1 bola grande + 2 menores
  const crown = mergeGeometries([
    colored(blob(1.9, 1, 0, 3.9, 0), '#ffffff'),
    colored(blob(1.2, 0, 1.1, 3.3, 0.4), '#ffffff'),
    colored(blob(1.1, 0, -0.9, 3.5, -0.6), '#ffffff'),
  ])!;
  return {
    trunk: colored(new THREE.CylinderGeometry(0.17, 0.25, 2.8, 6).translate(0, 1.2, 0), trunkC),
    crown,
    crownFar: colored(blob(2.1, 0, 0, 3.8, 0), '#ffffff'),
  };
}

// --------------------------------------------------------------- distribuição

const DENSITY: Partial<Record<GreenKind, number>> = {
  wood: 1 / 40,
  scrub: 1 / 120,
  park: 1 / 110,
  garden: 1 / 90,
  grass: 1 / 260,
  meadow: 1 / 400,
  cemetery: 1 / 200,
};

/**
 * Distribui árvores (determinístico):
 *  1) áreas verdes  2) calçadas  3) TODO terreno livre da cidade (sem prédio,
 *  rua, água ou lote vago reservado)  4) morros ao redor.
 */
export function scatterTrees(world: WorldState, density: number): TreeInstance[] {
  const out: TreeInstance[] = [];
  const hf = world.height;
  const factor = density;

  // prédios com recuo (quintal/fachada livres)
  const nearBuilding = (x: number, z: number, buffer: number) => {
    for (const b of world.buildingsNear(x, z, buffer + 1)) {
      if (pointInPolygon(x, z, b.outer)) return true;
      const r = b.outer;
      for (let i = 0; i < r.length; i++) {
        const a = r[i];
        const c = r[(i + 1) % r.length];
        if (distSqToSegment(x, z, a[0], a[1], c[0], c[1]).d2 < buffer * buffer) return true;
      }
    }
    return false;
  };
  // vias (pista + calçada + folga)
  const roadCell = 30;
  const roadGrid = new Map<string, { a: [number, number]; b: [number, number]; r: number }[]>();
  for (const s of world.data.streets)
    for (let i = 0; i < s.points.length - 1; i++) {
      const a = s.points[i];
      const b = s.points[i + 1];
      const r = s.width / 2 + (['footway', 'path', 'steps', 'track', 'cycleway'].includes(s.kind) ? 1.2 : 3.2);
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
        if (distSqToSegment(x, z, a[0], a[1], b[0], b[1]).d2 < (w.width / 2 + 3.5) ** 2) return true;
      }
    for (const w of world.data.waterAreas) if (pointInPolygon(x, z, w.outer, w.holes)) return true;
    return false;
  };
  // lotes vagos reservados (+1,5 m)
  const vacantGrid = new Map<string, Ring[]>();
  for (const l of world.data.lots) {
    if (!l.vacant || !l.outer) continue;
    const bb = ringBounds(l.outer);
    for (let gx = Math.floor((bb.minX - 2) / 30); gx <= Math.floor((bb.maxX + 2) / 30); gx++)
      for (let gz = Math.floor((bb.minZ - 2) / 30); gz <= Math.floor((bb.maxZ + 2) / 30); gz++) {
        const k = `${gx},${gz}`;
        if (!vacantGrid.has(k)) vacantGrid.set(k, []);
        vacantGrid.get(k)!.push(l.outer);
      }
  }
  const onVacant = (x: number, z: number) => {
    for (const r of vacantGrid.get(`${Math.floor(x / 30)},${Math.floor(z / 30)}`) ?? []) {
      if (pointInPolygon(x, z, r)) return true;
      for (let i = 0; i < r.length; i++) {
        const a = r[i];
        const c = r[(i + 1) % r.length];
        if (distSqToSegment(x, z, a[0], a[1], c[0], c[1]).d2 < 1.5 * 1.5) return true;
      }
    }
    return false;
  };
  // áreas verdes já têm distribuição própria; quadras esportivas ficam livres
  const inGreen = (x: number, z: number) => world.data.greens.some((g) => g.kind !== 'grass' && pointInPolygon(x, z, g.outer, g.holes));

  const add = (x: number, z: number, rng: () => number, kind: Species, scale = 1) => {
    out.push({ x, z, y: hf.sample(x, z) - 0.1, scale: scale * (0.75 + rng() * 0.5), rot: rng() * Math.PI * 2, kind, tint: rng() });
  };
  const townSpecies = (r: number) => (r < 0.58 ? Species.Round : r < 0.82 ? Species.Pine : r < 0.92 ? Species.Ipe : Species.Palm);

  // 1) áreas verdes
  for (const g of world.data.greens) {
    const d = DENSITY[g.kind];
    if (!d) continue;
    const rb = ringBounds(g.outer);
    const area = (rb.maxX - rb.minX) * (rb.maxZ - rb.minZ);
    const rng = mulberry32(hashId(Number(g.id.replace(/\D/g, '').slice(0, 15)) || 1));
    const count = Math.min(4000, Math.floor(area * d * factor));
    for (let k = 0; k < count; k++) {
      const x = rb.minX + rng() * (rb.maxX - rb.minX);
      const z = rb.minZ + rng() * (rb.maxZ - rb.minZ);
      if (!pointInPolygon(x, z, g.outer, g.holes) || nearBuilding(x, z, 1.5) || onRoad(x, z)) continue;
      add(x, z, rng, g.kind === 'wood' ? (rng() < 0.5 ? Species.Pine : Species.Round) : townSpecies(rng()), g.kind === 'wood' ? 1.2 : 1);
    }
  }

  // 2) arborização de calçada
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
      for (let t = 6 + rng() * 10; t < len - 4; t += (14 + rng() * 18) / Math.max(0.3, factor)) {
        if (rng() > 0.5) continue;
        const side = rng() < 0.5 ? 1 : -1;
        const off = s.width / 2 + 1.25;
        const x = ax + ux * t - uz * off * side;
        const z = az + uz * t + ux * off * side;
        if (!world.isInsideBounds(x, z) || nearBuilding(x, z, 0.8)) continue;
        add(x, z, rng, rng() < 0.2 ? Species.Ipe : Species.Round, 0.7);
      }
    }
  }

  // 3) terreno livre dentro da cidade: tudo que não é prédio/rua/água/lote reservado
  {
    const b = world.data.bounds;
    const rng = mulberry32(98765);
    const spacing = 7.5 / Math.sqrt(Math.max(0.25, factor));
    for (let x = b.minX + 2; x < b.maxX - 2; x += spacing)
      for (let z = b.minZ + 2; z < b.maxZ - 2; z += spacing) {
        const px = x + (rng() - 0.5) * spacing * 0.9;
        const pz = z + (rng() - 0.5) * spacing * 0.9;
        // manchas (bosquinhos) e clareiras: não vira um tapete uniforme
        const noise = Math.sin(px * 0.031 + Math.sin(pz * 0.017) * 2) * Math.cos(pz * 0.027 - px * 0.009) + Math.sin((px - pz) * 0.06) * 0.3;
        if (rng() > 0.5 + noise * 0.35) continue;
        if (onRoad(px, pz) || nearBuilding(px, pz, 2.5) || onWater(px, pz) || onVacant(px, pz) || inGreen(px, pz)) continue;
        add(px, pz, rng, townSpecies(rng()), 0.9);
      }
  }

  // 4) morros ao redor
  const b = world.data.bounds;
  const hm = world.data.heightmap;
  const ext = hm ? hm.minX + (hm.size - 1) * hm.cellSize : b.maxX + 400;
  const rng = mulberry32(1234567);
  const spacing = 12 / Math.sqrt(Math.max(0.2, factor));
  for (let x = -ext + 5; x < ext - 5; x += spacing)
    for (let z = -ext + 5; z < ext - 5; z += spacing) {
      const px = x + (rng() - 0.5) * spacing;
      const pz = z + (rng() - 0.5) * spacing;
      if (world.isInsideBounds(px, pz, -2)) continue;
      const noise = Math.sin(px * 0.013) * Math.cos(pz * 0.011) + Math.sin((px + pz) * 0.021) * 0.5;
      const slope = hf.slope(px, pz);
      const p = (noise > 0.1 ? 0.6 : 0.15) + Math.min(slope, 0.4) * 0.6;
      if (rng() > p) continue;
      if (onRoad(px, pz) || onWater(px, pz)) continue;
      add(px, pz, rng, rng() < 0.45 ? Species.Pine : Species.Round, 1.2);
    }
  return out;
}

// -------------------------------------------------------------- renderização

const TINTS: Record<Species, string[]> = {
  [Species.Round]: ['#7cc26b', '#8fd16f', '#5fb35a', '#a3d977', '#6cbf7a', '#9bcf5f'],
  [Species.Pine]: ['#4fa45a', '#5fb35a', '#3f9a62', '#6cbf7a'],
  [Species.Ipe]: ['#ffd84a', '#ffc93c', '#e990c8', '#d77bd2', '#ffb3d1', '#ffe066'],
  [Species.Palm]: ['#6cbf5a', '#7fcb62'],
};

const TREE_LOD_DISTANCE = 260;

/**
 * Árvores instanciadas numa grade de 250 m. Cada célula é um LOD:
 * perto = copas lisas com tronco; longe = copa simplificada.
 */
export class TreeRenderer {
  private species: SpeciesGeo[];
  private trunkMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  private crownMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });

  constructor(
    _quality: QualityPreset,
    private readonly bounds: { minX: number; minZ: number; maxX: number; maxZ: number },
  ) {
    this.species = [Species.Round, Species.Pine, Species.Ipe, Species.Palm].map((k) => speciesGeometry(k));
  }

  build(trees: TreeInstance[], cell = 250): THREE.Object3D[] {
    const cells = new Map<string, TreeInstance[]>();
    for (const t of trees) {
      const k = `${Math.floor(t.x / cell)},${Math.floor(t.z / cell)}`;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k)!.push(t);
    }
    const out: THREE.Object3D[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const axis = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const b = this.bounds;
    for (const [k, list] of cells) {
      const [gx, gz] = k.split(',').map(Number);
      const cx = (gx + 0.5) * cell;
      const cz = (gz + 0.5) * cell;
      const cy = list.reduce((a, t) => a + t.y, 0) / list.length;
      const nearTown = cx > b.minX - cell && cx < b.maxX + cell && cz > b.minZ - cell && cz < b.maxZ + cell;
      const lod = new THREE.LOD();
      lod.position.set(cx, cy, cz);
      const near = new THREE.Group();
      const far = new THREE.Group();
      for (let kind = 0; kind < this.species.length; kind++) {
        const sl = list.filter((t) => t.kind === kind);
        if (!sl.length) continue;
        const sp = this.species[kind];
        const trunk = new THREE.InstancedMesh(sp.trunk, this.trunkMat, sl.length);
        const crown = new THREE.InstancedMesh(sp.crown, this.crownMat, sl.length);
        const crownFar = new THREE.InstancedMesh(sp.crownFar, this.crownMat, sl.length);
        const tints = TINTS[kind as Species];
        sl.forEach((t, i) => {
          q.setFromAxisAngle(axis, t.rot);
          s.setScalar(t.scale);
          p.set(t.x - cx, t.y - cy, t.z - cz);
          m.compose(p, q, s);
          trunk.setMatrixAt(i, m);
          crown.setMatrixAt(i, m);
          crownFar.setMatrixAt(i, m);
          col.set(tints[Math.floor(t.tint * tints.length) % tints.length]);
          crown.setColorAt(i, col);
          crownFar.setColorAt(i, col);
        });
        trunk.castShadow = crown.castShadow = nearTown;
        trunk.receiveShadow = crown.receiveShadow = crownFar.receiveShadow = true;
        for (const im of [trunk, crown, crownFar]) im.computeBoundingSphere();
        near.add(trunk, crown);
        far.add(crownFar);
      }
      lod.addLevel(near, 0);
      lod.addLevel(far, TREE_LOD_DISTANCE);
      out.push(lod);
    }
    return out;
  }
}
