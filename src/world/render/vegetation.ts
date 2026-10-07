import * as THREE from 'three';
import { worldUniforms } from './materials';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { QualityPreset } from '../../core/quality';
import type { GreenKind, Ring } from '../../data/types';
import type { WorldState } from '../WorldState';
import { distSqToSegment, hashId, mulberry32, pointInPolygon, ringBounds } from '../geo';
import type { TextureLibrary } from './textures';

/** Espécies: copa larga (rua/praça), ipê florido, palmeira-imperial, eucalipto. */
export enum Species {
  Broadleaf = 0,
  Ipe = 1,
  Palm = 2,
  Eucalyptus = 3,
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

// ------------------------------------------------------------------ texturas

/** atlas de folhagem gerado em canvas (sem download) */
function foliageTexture(kind: 'broad' | 'palm' | 'euca'): THREE.Texture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const rng = mulberry32(kind === 'broad' ? 11 : kind === 'palm' ? 22 : 33);
  if (kind === 'palm') {
    // folha de palmeira: ráquis central + folíolos
    g.translate(S / 2, S);
    g.strokeStyle = '#4d6b2c';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(10, -S * 0.5, 0, -S * 0.98);
    g.stroke();
    for (let i = 0; i < 46; i++) {
      const t = i / 46;
      const y = -S * 0.05 - t * S * 0.9;
      const len = (S * 0.42) * Math.sin(Math.PI * (0.15 + t * 0.85)) + 6;
      for (const s of [-1, 1]) {
        const shade = 70 + rng() * 40;
        g.strokeStyle = `rgb(${shade * 0.6},${shade * 1.15},${shade * 0.45})`;
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(0, y);
        g.quadraticCurveTo(s * len * 0.5, y - 12, s * len, y + 10 + rng() * 8);
        g.stroke();
      }
    }
  } else {
    const leaves = kind === 'broad' ? 900 : 700;
    for (let i = 0; i < leaves; i++) {
      // distribuição em nuvem (mais denso no centro)
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * S * 0.46;
      const x = S / 2 + Math.cos(a) * r;
      const y = S / 2 + Math.sin(a) * r * (kind === 'euca' ? 1.0 : 0.85);
      const shade = 0.55 + rng() * 0.45 + (1 - r / (S * 0.46)) * -0.15;
      const [cr, cg, cb] = kind === 'broad' ? [0.32, 0.55, 0.2] : [0.42, 0.55, 0.38];
      g.fillStyle = `rgb(${Math.round(cr * shade * 255)},${Math.round(cg * shade * 255)},${Math.round(cb * shade * 255)})`;
      g.save();
      g.translate(x, y);
      g.rotate(rng() * Math.PI * 2);
      g.beginPath();
      if (kind === 'broad') g.ellipse(0, 0, 7 + rng() * 4, 3.5 + rng() * 2, 0, 0, Math.PI * 2);
      else g.ellipse(0, 0, 9 + rng() * 5, 1.8 + rng(), 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    // galhinhos
    g.strokeStyle = 'rgba(70,52,36,0.8)';
    g.lineWidth = 2;
    for (let i = 0; i < 10; i++) {
      g.beginPath();
      g.moveTo(S / 2, S * 0.95);
      g.lineTo(S / 2 + (rng() - 0.5) * S * 0.7, S * 0.2 + rng() * S * 0.5);
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ----------------------------------------------------------------- geometria

/** cilindro afunilado entre dois pontos, UV de casca em metros */
function limb(from: THREE.Vector3, to: THREE.Vector3, r0: number, r1: number, seg = 6): THREE.BufferGeometry {
  const len = from.distanceTo(to);
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, true);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * r0, uv.getY(i) * len);
  g.translate(0, len / 2, 0);
  const dir = to.clone().sub(from).normalize();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
  g.translate(from.x, from.y, from.z);
  return g;
}

/**
 * Copa de cartões: `count` quads em volta de um elipsoide. Normais apontam
 * para fora do centro da copa (iluminação "volumosa", sem cara de plano).
 */
function crown(center: THREE.Vector3, rx: number, ry: number, count: number, size: number, rng: () => number, droop = 0): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < count; i++) {
    // pontos espalhados (Fibonacci) + ruído
    const t = (i + 0.5) / count;
    const phi = Math.acos(1 - 2 * t);
    const th = Math.PI * (1 + Math.sqrt(5)) * i;
    const d = new THREE.Vector3(Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th));
    const c = center.clone().add(new THREE.Vector3(d.x * rx * 0.6, d.y * ry * 0.6, d.z * rx * 0.6));
    c.x += (rng() - 0.5) * rx * 0.3;
    c.z += (rng() - 0.5) * rx * 0.3;
    // orientação aleatória do cartão
    const n = new THREE.Vector3(rng() - 0.5, (rng() - 0.5) * 0.6 + droop, rng() - 0.5).normalize();
    const tA = new THREE.Vector3().crossVectors(n, Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : up).normalize();
    const tB = new THREE.Vector3().crossVectors(n, tA).normalize();
    const s = size * (0.75 + rng() * 0.5);
    const corners = [
      [-1, -1, 0, 0],
      [1, -1, 1, 0],
      [1, 1, 1, 1],
      [-1, 1, 0, 1],
    ];
    const verts = corners.map(([a, b]) => c.clone().addScaledVector(tA, (a * s) / 2).addScaledVector(tB, (b * s) / 2));
    for (const idx of [0, 1, 2, 0, 2, 3]) {
      const v = verts[idx];
      pos.push(v.x, v.y, v.z);
      const sn = v.clone().sub(center);
      sn.y *= 0.7;
      sn.normalize().lerp(up, 0.25).normalize();
      nor.push(sn.x, sn.y, sn.z);
      uvs.push(corners[idx][2], corners[idx][3]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return g;
}

/** folhas de palmeira: cartões longos irradiando do topo, arqueados */
function palmFronds(top: THREE.Vector3, count: number, len: number, rng: () => number): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rng() * 0.3;
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const lift = 0.35 - (i % 3) * 0.25;
    const segs = 3;
    let prev: THREE.Vector3[] | null = null;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const p = top
        .clone()
        .addScaledVector(dir, t * len)
        .add(new THREE.Vector3(0, (lift * t - t * t * 0.9) * len * 0.5, 0));
      const w = 0.9 * (1 - t * 0.5);
      const row = [p.clone().addScaledVector(side, -w), p.clone().addScaledVector(side, w)];
      if (prev) {
        const quad = [prev[0], prev[1], row[1], prev[0], row[1], row[0]];
        const quv = [
          [0, (s - 1) / segs],
          [1, (s - 1) / segs],
          [1, t],
          [0, (s - 1) / segs],
          [1, t],
          [0, t],
        ];
        quad.forEach((v, k) => {
          pos.push(v.x, v.y, v.z);
          nor.push(0, 1, 0);
          uvs.push(quv[k][0], quv[k][1]);
        });
      }
      prev = row;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return g;
}

interface SpeciesGeo {
  trunk: THREE.BufferGeometry;
  leaves: THREE.BufferGeometry;
  foliage: 'broad' | 'palm' | 'euca';
}

function speciesGeometry(kind: Species, cards: number): SpeciesGeo {
  const rng = mulberry32(100 + kind);
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  if (kind === Species.Palm) {
    const parts: THREE.BufferGeometry[] = [];
    // tronco reto e liso (palmeira-imperial), com "palmito" verde no topo
    parts.push(limb(V(0, -0.3, 0), V(0, 9, 0), 0.3, 0.22, 8));
    parts.push(limb(V(0, 9, 0), V(0, 10.6, 0), 0.24, 0.2, 8));
    return { trunk: mergeGeometries(parts)!, leaves: palmFronds(V(0, 10.5, 0), Math.max(8, cards), 4.2, rng), foliage: 'palm' };
  }
  if (kind === Species.Eucalyptus) {
    const parts = [limb(V(0, -0.3, 0), V(0.2, 9, 0.1), 0.26, 0.1, 6), limb(V(0.1, 5, 0), V(1.2, 8, 0.5), 0.09, 0.04, 4), limb(V(0.15, 6, 0.05), V(-0.7, 8.6, -0.5), 0.08, 0.04, 4)];
    // copa alta e rala em tufos pendentes (cartões menores, mais numerosos)
    const leaves = mergeGeometries([
      crown(V(0.2, 9.8, 0.1), 1.7, 2.2, Math.ceil(cards * 0.9), 1.9, rng, -0.25),
      crown(V(0.9, 7.8, 0.4), 1.2, 1.3, Math.ceil(cards * 0.5), 1.6, rng, -0.25),
      crown(V(-0.6, 8.6, -0.5), 1.1, 1.2, Math.ceil(cards * 0.45), 1.5, rng, -0.25),
      crown(V(0.5, 11.2, -0.2), 1.0, 0.9, Math.ceil(cards * 0.35), 1.4, rng, -0.25),
    ])!;
    return { trunk: mergeGeometries(parts)!, leaves, foliage: 'euca' };
  }
  // copa larga: tronco + 5 galhos; copa em aglomerados (silhueta irregular,
  // muitos cartões pequenos em vez de poucos grandes = menos cara de papelão)
  const parts = [limb(V(0, -0.3, 0), V(0, 2.6, 0), 0.26, 0.19, 7)];
  const ends: THREE.Vector3[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4 + (rng() - 0.5) * 0.5;
    const rr = 1.3 + rng() * 0.6;
    const end = V(Math.cos(a) * rr, 3.9 + rng() * 0.9, Math.sin(a) * rr);
    parts.push(limb(V(0, 2.3 + rng() * 0.3, 0), end, 0.13, 0.05, 5));
    ends.push(end);
  }
  const leaves = mergeGeometries([
    crown(V(0, 4.9, 0), 2.2, 1.5, Math.ceil(cards * 1.2), 2.1, rng),
    ...ends.map((e) => crown(e.clone().add(V(0, 0.45, 0)), 1.2 + rng() * 0.3, 0.95, Math.ceil(cards * 0.55), 1.6, rng)),
  ])!;
  return { trunk: mergeGeometries(parts)!, leaves, foliage: 'broad' };
}

// --------------------------------------------------------------- distribuição

const DENSITY: Partial<Record<GreenKind, number>> = {
  wood: 1 / 40,
  scrub: 1 / 120,
  park: 1 / 45,
  garden: 1 / 50,
  grass: 1 / 120,
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
  // lotes (vagos reservados e quintais) ficam livres (+1,5 m)
  const vacantGrid = new Map<string, Ring[]>();
  for (const l of world.data.lots) {
    if (!l.outer) continue;
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
  const townSpecies = (r: number) => (r < 0.66 ? Species.Broadleaf : r < 0.76 ? Species.Eucalyptus : r < 0.8 ? Species.Ipe : Species.Palm);

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
      add(x, z, rng, g.kind === 'wood' ? (rng() < 0.5 ? Species.Eucalyptus : Species.Broadleaf) : townSpecies(rng()), g.kind === 'wood' ? 1.2 : 1);
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
        if (rng() > 0.75) continue;
        const side = rng() < 0.5 ? 1 : -1;
        const off = s.width / 2 + 1.25;
        const x = ax + ux * t - uz * off * side;
        const z = az + uz * t + ux * off * side;
        if (!world.isInsideBounds(x, z) || nearBuilding(x, z, 0.8)) continue;
        add(x, z, rng, rng() < 0.35 ? Species.Palm : rng() < 0.15 ? Species.Ipe : Species.Broadleaf, 0.9);
      }
    }
  }

  // 3) terreno livre dentro da cidade: tudo que não é prédio/rua/água/lote reservado
  {
    const b = world.data.bounds;
    const rng = mulberry32(98765);
    const spacing = 6 / Math.sqrt(Math.max(0.25, factor));
    for (let x = b.minX + 2; x < b.maxX - 2; x += spacing)
      for (let z = b.minZ + 2; z < b.maxZ - 2; z += spacing) {
        const px = x + (rng() - 0.5) * spacing * 0.9;
        const pz = z + (rng() - 0.5) * spacing * 0.9;
        // manchas (bosquinhos) e clareiras: não vira um tapete uniforme
        const noise = Math.sin(px * 0.031 + Math.sin(pz * 0.017) * 2) * Math.cos(pz * 0.027 - px * 0.009) + Math.sin((px - pz) * 0.06) * 0.3;
        // mata densa com poucas clareiras
        if (rng() > 0.72 + noise * 0.25) continue;
        if (onRoad(px, pz) || nearBuilding(px, pz, 2.5) || onWater(px, pz) || onVacant(px, pz) || inGreen(px, pz)) continue;
        add(px, pz, rng, townSpecies(rng()), 1.5);
      }
  }

  // 4) uma árvore em parte dos quintais (nos fundos, longe da casa e do muro)
  for (const l of world.data.lots) {
    if (!l.outer || l.vacant || !l.buildingId) continue;
    const rng = mulberry32(hashId(l.lotId.length * 977 + Math.round(l.area * 13)));
    if (rng() > 0.45) continue;
    const bb = ringBounds(l.outer);
    for (let tries = 0; tries < 8; tries++) {
      const x = bb.minX + rng() * (bb.maxX - bb.minX);
      const z = bb.minZ + rng() * (bb.maxZ - bb.minZ);
      if (!pointInPolygon(x, z, l.outer) || nearBuilding(x, z, 2)) continue;
      let edge = false;
      for (let i = 0; i < l.outer.length && !edge; i++) {
        const a = l.outer[i];
        const c = l.outer[(i + 1) % l.outer.length];
        edge = distSqToSegment(x, z, a[0], a[1], c[0], c[1]).d2 < 1.6 * 1.6;
      }
      if (edge) continue;
      add(x, z, rng, rng() < 0.25 ? Species.Palm : rng() < 0.3 ? Species.Ipe : Species.Broadleaf, 0.75);
      break;
    }
  }

  // 5) morros ao redor
  const b = world.data.bounds;
  const hm = world.data.heightmap;
  const ext = hm ? hm.minX + (hm.size - 1) * hm.cellSize : b.maxX + 400;
  const rng = mulberry32(1234567);
  const spacing = 9.5 / Math.sqrt(Math.max(0.2, factor));
  for (let x = -ext + 5; x < ext - 5; x += spacing)
    for (let z = -ext + 5; z < ext - 5; z += spacing) {
      const px = x + (rng() - 0.5) * spacing;
      const pz = z + (rng() - 0.5) * spacing;
      if (world.isInsideBounds(px, pz, -2)) continue;
      const noise = Math.sin(px * 0.013) * Math.cos(pz * 0.011) + Math.sin((px + pz) * 0.021) * 0.5;
      const slope = hf.slope(px, pz);
      // morros cobertos de mata (como Itabirito e a referência)
      const p = (noise > -0.4 ? 0.88 : 0.35) + Math.min(slope, 0.4) * 0.4;
      if (rng() > p) continue;
      if (onRoad(px, pz) || onWater(px, pz)) continue;
      add(px, pz, rng, rng() < 0.15 ? Species.Eucalyptus : Species.Broadleaf, 2.1);
    }
  return out;
}

// -------------------------------------------------------------- renderização

const LEAF_TINTS: Record<Species, string[]> = {
  [Species.Broadleaf]: ['#d4e0b0', '#c6d6a2', '#dde4ba', '#bccc98', '#cfd8a8', '#e4e8c0'],
  [Species.Ipe]: ['#ffd84a', '#ffcf2e', '#d98ad6', '#e7a6e0', '#ffe066'],
  [Species.Palm]: ['#c6d0a8', '#b8c39a', '#d0d6b0'],
  [Species.Eucalyptus]: ['#d6dcc4', '#c8d0b6', '#e0e4cc'],
};


/** layer usada só pela câmera de sombra (proxies de copa) */
export const SHADOW_ONLY_LAYER = 1;

/** distância (m) da câmera ao centro da célula para trocar por impostores */
const TREE_LOD_DISTANCE = 170;

/**
 * Impostor: 3 quads verticais cruzados (silhueta lateral) + 2 discos de copa
 * horizontais (vista de cima). Sem os discos, de cima a árvore vira uma
 * "estrela" fina — na vista aérea a copa redonda é o que aparece.
 * Atlas: metade esquerda = lateral; quadrante superior direito = topo.
 */
function impostorGeometry(width: number, height: number, crownY: number, palm: boolean): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const push = (q: number[][], n: number[]) => {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const [x, y, z, u, v] = q[i];
      pos.push(x, y, z);
      nor.push(...n);
      uvs.push(u, v);
    }
  };
  for (let k = 0; k < 3; k++) {
    const ang = (k / 3) * Math.PI;
    const dx = Math.cos(ang) * (width / 2);
    const dz = Math.sin(ang) * (width / 2);
    push(
      [
        [-dx, 0, -dz, 0, 0],
        [dx, 0, dz, 0.5, 0],
        [dx, height, dz, 0.5, 1],
        [-dx, height, -dz, 0, 1],
      ],
      [0, 0.85, 0.5],
    );
  }
  // discos de copa (vistos de cima)
  const disc = (r: number, y: number, rot: number) => {
    const c = Math.cos(rot) * r;
    const sn = Math.sin(rot) * r;
    push(
      [
        [-c + sn, y, -sn - c, 0.5, 0.5],
        [c + sn, y, sn - c, 1, 0.5],
        [c - sn, y, sn + c, 1, 1],
        [-c - sn, y, -sn + c, 0.5, 1],
      ],
      [0, 1, 0],
    );
  };
  disc(width * 0.5, crownY, 0);
  if (!palm) disc(width * 0.38, crownY + (height - crownY) * 0.45, 0.8);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return g;
}

/** atlas do impostor: lateral (esq.) + copa vista de cima (dir. superior) */
function impostorTexture(leaf: THREE.Texture, kind: Species, crownBottom: number): THREE.Texture {
  const W = 128;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W * 2;
  c.height = H;
  const g = c.getContext('2d')!;
  const yb = H * (1 - crownBottom);
  g.fillStyle = '#5a4634';
  g.fillRect(W / 2 - (kind === Species.Palm ? 3 : 5), yb - 10, kind === Species.Palm ? 6 : 10, H - yb + 10);
  const img = leaf.image as CanvasImageSource;
  if (kind === Species.Palm) {
    for (let i = 0; i < 6; i++) {
      g.save();
      g.translate(W / 2, 30);
      g.rotate(-1.2 + i * 0.48);
      g.drawImage(img, -18, -10, 36, 80);
      g.restore();
    }
  } else {
    const blobs = kind === Species.Eucalyptus ? 7 : 9;
    for (let i = 0; i < blobs; i++) {
      const t = i / blobs;
      const bw = W * (0.55 + 0.35 * Math.sin(Math.PI * t));
      const x = W / 2 - bw / 2 + Math.sin(i * 2.3) * W * 0.12;
      const y = t * (yb - 10) * 0.85;
      g.drawImage(img, x, y, bw, bw * 0.9);
    }
  }
  // ---- copa de cima (quadrante superior direito: 128x128)
  const S = W;
  const cx = W + S / 2;
  const cy = S / 2;
  const rng = mulberry32(kind * 31 + 7);
  g.save();
  g.beginPath();
  g.arc(cx, cy, S * 0.47, 0, Math.PI * 2);
  g.clip();
  if (kind === Species.Palm) {
    for (let i = 0; i < 9; i++) {
      g.save();
      g.translate(cx, cy);
      g.rotate((i / 9) * Math.PI * 2 + rng() * 0.3);
      g.drawImage(img, -14, 0, 28, S * 0.5);
      g.restore();
    }
  } else {
    // tufos sobrepostos formando uma copa cheia e irregular
    for (let i = 0; i < 26; i++) {
      const ang = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * S * 0.3;
      const sz = S * (0.28 + rng() * 0.22);
      g.drawImage(img, cx + Math.cos(ang) * r - sz / 2, cy + Math.sin(ang) * r - sz / 2, sz, sz);
    }
  }
  g.restore();
  // borda irregular: recorta com tufos alfa (sem círculo perfeito)
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 18; i++) {
    const ang = (i / 18) * Math.PI * 2 + rng() * 0.3;
    const r = S * (0.44 + rng() * 0.06);
    g.beginPath();
    g.arc(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, S * (0.05 + rng() * 0.05), 0, Math.PI * 2);
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  // volume: centro mais claro, borda mais escura
  const grad = g.createRadialGradient(cx - S * 0.08, cy - S * 0.08, S * 0.05, cx, cy, S * 0.5);
  grad.addColorStop(0, 'rgba(255,255,230,0.18)');
  grad.addColorStop(0.7, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,20,0,0.35)');
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = grad;
  g.fillRect(W, 0, S, S);
  g.globalCompositeOperation = 'source-over';
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * Folhagem: luz envolvente (wrap) + translucidez. Folha real deixa passar luz;
 * sem isso o lado da copa oposto ao sol vira um borrão escuro e chapado.
 */
function foliageShading(m: THREE.Material, strength = 1) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uSunDirW = worldUniforms.uSunDirW;
    sh.uniforms.uSunCol = worldUniforms.uSunCol;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSunDirW;\nuniform vec3 uSunCol;')
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          vec3 sv = normalize((viewMatrix * vec4(uSunDirW, 0.0)).xyz);
          vec3 toFrag = -normalize(vViewPosition);
          float back = pow(max(dot(toFrag, sv), 0.0), 3.0);
          float wrap = clamp((dot(normal, sv) + 0.6) / 1.6, 0.0, 1.0);
          vec3 leafT = diffuseColor.rgb * vec3(1.0, 1.08, 0.7);
          reflectedLight.indirectDiffuse += leafT * uSunCol * (0.11 * wrap + 0.3 * back + 0.03) * ${strength.toFixed(2)};
        }`,
      );
  };
  m.customProgramCacheKey = () => `foliage${strength}`;
}

interface SpeciesRender {
  geo: SpeciesGeo;
  proxy: THREE.BufferGeometry;
  impostor: THREE.BufferGeometry;
  impostorMat: THREE.MeshStandardMaterial;
}

/**
 * Árvores instanciadas numa grade própria de 250 m. Cada célula é um LOD:
 * perto = tronco + cartões de folhagem; longe = impostores (6 triângulos).
 * Sombra da copa vem de um proxy simples (icosaedro) numa layer só da
 * câmera de sombra — alpha-test em sombra é caro.
 */
export class TreeRenderer {
  private species: SpeciesRender[];
  private barkMat: THREE.MeshStandardMaterial;
  private leafMats: Record<string, THREE.MeshStandardMaterial> = {};
  private proxyMat = new THREE.MeshBasicMaterial({ color: '#000000' });

  constructor(
    tex: TextureLibrary,
    quality: QualityPreset,
    private readonly bounds: { minX: number; minZ: number; maxX: number; maxZ: number },
  ) {
    this.barkMat = new THREE.MeshStandardMaterial({ color: '#8a7766', roughness: 0.95 });
    tex.apply(this.barkMat, 'bark', 1);
    const leafTex: Record<string, THREE.Texture> = {};
    for (const f of ['broad', 'palm', 'euca'] as const) {
      leafTex[f] = foliageTexture(f);
      this.leafMats[f] = new THREE.MeshStandardMaterial({ map: leafTex[f], alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
      foliageShading(this.leafMats[f]);
    }
    this.species = [Species.Broadleaf, Species.Ipe, Species.Palm, Species.Eucalyptus].map((k) => {
      const geo = speciesGeometry(k, quality.leafCards);
      geo.leaves.computeBoundingBox();
      const bb = geo.leaves.boundingBox!;
      const size = bb.getSize(new THREE.Vector3());
      const center = bb.getCenter(new THREE.Vector3());
      const proxy = new THREE.IcosahedronGeometry(0.5, 0)
        .scale(size.x * 0.85, size.y * (k === Species.Palm ? 0.35 : 0.8), size.z * 0.85)
        .translate(center.x, center.y, center.z);
      const width = Math.max(size.x, size.z);
      const height = bb.max.y;
      const impostorMat = new THREE.MeshStandardMaterial({
        map: impostorTexture(leafTex[geo.foliage], k, bb.min.y / height),
        alphaTest: 0.4,
        side: THREE.DoubleSide,
        roughness: 0.9,
      });
      foliageShading(impostorMat, 0.8);
      return { geo, proxy, impostor: impostorGeometry(width, height, center.y, k === Species.Palm), impostorMat };
    });
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
      // sombras só perto da cidade (morros distantes não projetam)
      const nearTown = cx > b.minX - cell && cx < b.maxX + cell && cz > b.minZ - cell && cz < b.maxZ + cell;
      const lod = new THREE.LOD();
      lod.position.set(cx, cy, cz);
      const near = new THREE.Group();
      const far = new THREE.Group();
      for (let kind = 0; kind < this.species.length; kind++) {
        const sl = list.filter((t) => t.kind === kind);
        if (!sl.length) continue;
        const sp = this.species[kind];
        const trunk = new THREE.InstancedMesh(sp.geo.trunk, this.barkMat, sl.length);
        const leaves = new THREE.InstancedMesh(sp.geo.leaves, this.leafMats[sp.geo.foliage], sl.length);
        const imp = new THREE.InstancedMesh(sp.impostor, sp.impostorMat, sl.length);
        const proxy = new THREE.InstancedMesh(sp.proxy, this.proxyMat, sl.length);
        const tints = LEAF_TINTS[kind as Species];
        sl.forEach((t, i) => {
          q.setFromAxisAngle(axis, t.rot);
          s.setScalar(t.scale);
          p.set(t.x - cx, t.y - cy, t.z - cz);
          m.compose(p, q, s);
          trunk.setMatrixAt(i, m);
          leaves.setMatrixAt(i, m);
          imp.setMatrixAt(i, m);
          proxy.setMatrixAt(i, m);
          col.set(tints[Math.floor(t.tint * tints.length) % tints.length]);
          leaves.setColorAt(i, col);
          imp.setColorAt(i, col);
        });
        // tronco não projeta (a copa/proxy já dá a sombra): passe de sombra mais leve
        trunk.castShadow = false;
        trunk.receiveShadow = true;
        // folhas não recebem sombra: o proxy da própria copa as escureceria
        leaves.receiveShadow = false;
        leaves.castShadow = false;
        proxy.castShadow = nearTown;
        proxy.layers.set(SHADOW_ONLY_LAYER);
        imp.castShadow = false;
        for (const im of [trunk, leaves, imp, proxy]) im.computeBoundingSphere();
        near.add(trunk, leaves);
        if (nearTown) near.add(proxy);
        far.add(imp);
      }
      lod.addLevel(near, 0);
      lod.addLevel(far, TREE_LOD_DISTANCE);
      out.push(lod);
    }
    return out;
  }
}
