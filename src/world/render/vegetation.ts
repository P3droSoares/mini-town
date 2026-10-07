import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { QualityPreset } from '../../core/quality';
import type { GreenKind } from '../../data/types';
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
    const parts = [limb(V(0, -0.3, 0), V(0.2, 9, 0.1), 0.26, 0.1, 6), limb(V(0.1, 5, 0), V(1.2, 8, 0.5), 0.09, 0.04, 4)];
    const leaves = mergeGeometries([
      crown(V(0.2, 9.5, 0.1), 2.0, 3.0, Math.ceil(cards * 0.7), 2.8, rng, -0.2),
      crown(V(0.9, 7.6, 0.4), 1.4, 1.6, Math.ceil(cards * 0.4), 2.2, rng, -0.2),
    ])!;
    return { trunk: mergeGeometries(parts)!, leaves, foliage: 'euca' };
  }
  // copa larga: tronco + 3 galhos principais
  const parts = [limb(V(0, -0.3, 0), V(0, 2.6, 0), 0.26, 0.19, 7)];
  const ends: THREE.Vector3[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    const end = V(Math.cos(a) * 1.4, 4.1 + rng() * 0.6, Math.sin(a) * 1.4);
    parts.push(limb(V(0, 2.4, 0), end, 0.14, 0.06, 5));
    ends.push(end);
  }
  const leaves = mergeGeometries([
    crown(V(0, 4.6, 0), 2.6, 1.8, cards, 2.9, rng),
    ...ends.map((e) => crown(e.clone().add(V(0, 0.4, 0)), 1.3, 1.0, Math.ceil(cards / 3), 2.2, rng)),
  ])!;
  return { trunk: mergeGeometries(parts)!, leaves, foliage: 'broad' };
}

// --------------------------------------------------------------- distribuição

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
 * residenciais e morros fora da área urbana (eucaliptais e mata).
 */
export function scatterTrees(world: WorldState, density: number): TreeInstance[] {
  const out: TreeInstance[] = [];
  const hf = world.height;
  const factor = density;

  const blocked = (x: number, z: number) => {
    for (const b of world.buildingsNear(x, z, 3)) if (pointInPolygon(x, z, b.outer)) return true;
    return false;
  };
  const roadCell = 30;
  const roadGrid = new Map<string, { a: [number, number]; b: [number, number]; r: number }[]>();
  for (const s of world.data.streets)
    for (let i = 0; i < s.points.length - 1; i++) {
      const a = s.points[i];
      const b = s.points[i + 1];
      const r = s.width / 2 + (['footway', 'path', 'steps', 'track'].includes(s.kind) ? 1 : 2.2);
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
        if (distSqToSegment(x, z, a[0], a[1], b[0], b[1]).d2 < (w.width / 2 + 3) ** 2) return true;
      }
    return false;
  };
  const add = (x: number, z: number, rng: () => number, kind: Species, scale = 1) => {
    out.push({ x, z, y: hf.sample(x, z) - 0.1, scale: scale * (0.8 + rng() * 0.45), rot: rng() * Math.PI * 2, kind, tint: rng() });
  };

  // 1) áreas verdes: praças com palmeiras e ipês, matas com copa larga
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
      if (!pointInPolygon(x, z, g.outer, g.holes) || blocked(x, z) || onRoad(x, z)) continue;
      const r = rng();
      const kind =
        g.kind === 'wood' ? (r < 0.25 ? Species.Eucalyptus : Species.Broadleaf) : g.kind === 'park' || g.kind === 'garden' ? (r < 0.2 ? Species.Palm : r < 0.32 ? Species.Ipe : Species.Broadleaf) : Species.Broadleaf;
      add(x, z, rng, kind, g.kind === 'wood' ? 1.15 : 1);
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
      for (let t = 6 + rng() * 10; t < len - 4; t += (16 + rng() * 22) / Math.max(0.3, factor)) {
        if (rng() > 0.45) continue;
        const side = rng() < 0.5 ? 1 : -1;
        const off = s.width / 2 + 1.25;
        const x = ax + ux * t - uz * off * side;
        const z = az + uz * t + ux * off * side;
        if (!world.isInsideBounds(x, z) || blocked(x, z)) continue;
        add(x, z, rng, rng() < 0.15 ? Species.Ipe : Species.Broadleaf, 0.75);
      }
    }
  }

  // 3) morros ao redor: manchas de mata nativa e eucaliptais
  const b = world.data.bounds;
  const hm = world.data.heightmap;
  const ext = hm ? hm.minX + (hm.size - 1) * hm.cellSize : b.maxX + 400;
  const rng = mulberry32(1234567);
  const spacing = 12 / Math.sqrt(Math.max(0.2, factor));
  for (let x = -ext + 5; x < ext - 5; x += spacing)
    for (let z = -ext + 5; z < ext - 5; z += spacing) {
      const px = x + (rng() - 0.5) * spacing;
      const pz = z + (rng() - 0.5) * spacing;
      if (world.isInsideBounds(px, pz, -10)) continue;
      const noise = Math.sin(px * 0.013) * Math.cos(pz * 0.011) + Math.sin((px + pz) * 0.021) * 0.5;
      const plantation = Math.sin(px * 0.004 + 1.3) * Math.cos(pz * 0.005 - 0.7) > 0.55;
      const edge = world.isInsideBounds(px, pz, 60);
      const slope = hf.slope(px, pz);
      const p = (plantation ? 0.85 : noise > 0.15 ? 0.55 : 0.07) + Math.min(slope, 0.4) * 0.6 - (edge ? 0.3 : 0);
      if (rng() > p) continue;
      if (onRoad(px, pz) || onWater(px, pz)) continue;
      add(px, pz, rng, plantation ? Species.Eucalyptus : Species.Broadleaf, plantation ? 1.25 : 1.1);
    }
  return out;
}

// -------------------------------------------------------------- renderização

const LEAF_TINTS: Record<Species, string[]> = {
  [Species.Broadleaf]: ['#e8ffd8', '#ffffff', '#d4f0c0', '#f2ffe0', '#c8e6b0'],
  [Species.Ipe]: ['#ffd84a', '#ffcf2e', '#d98ad6', '#e7a6e0', '#ffe066'],
  [Species.Palm]: ['#ffffff', '#e6f5d0'],
  [Species.Eucalyptus]: ['#dfe8d6', '#cfdcc8', '#e9efe0'],
};


/** layer usada só pela câmera de sombra (proxies de copa) */
export const SHADOW_ONLY_LAYER = 1;

/** distância (m) da câmera ao centro da célula para trocar por impostores */
const TREE_LOD_DISTANCE = 300;

/** impostor: 3 quads verticais cruzados com a silhueta da árvore */
function impostorGeometry(width: number, height: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI;
    const dx = Math.cos(a) * (width / 2);
    const dz = Math.sin(a) * (width / 2);
    const quad = [
      [-dx, 0, -dz, 0, 0],
      [dx, 0, dz, 1, 0],
      [dx, height, dz, 1, 1],
      [-dx, height, -dz, 0, 1],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const [x, y, z, u, v] = quad[i];
      pos.push(x, y, z);
      // normais "para cima e para fora": iluminação parecida com a copa real
      nor.push(0, 0.85, 0.5);
      uvs.push(u, v);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return g;
}

/** textura de silhueta (tronco + copa) a partir do atlas de folhas */
function impostorTexture(leaf: THREE.Texture, kind: Species, crownBottom: number): THREE.Texture {
  const W = 128;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
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
    // copa: vários "tufos" do atlas sobrepostos
    const blobs = kind === Species.Eucalyptus ? 7 : 9;
    for (let i = 0; i < blobs; i++) {
      const t = i / blobs;
      const bw = W * (0.55 + 0.35 * Math.sin(Math.PI * t));
      const x = W / 2 - bw / 2 + Math.sin(i * 2.3) * W * 0.12;
      const y = t * (yb - 10) * 0.85;
      g.drawImage(img, x, y, bw, bw * 0.9);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
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
    }
    this.species = [Species.Broadleaf, Species.Ipe, Species.Palm, Species.Eucalyptus].map((k) => {
      const geo = speciesGeometry(k, quality.leafCards);
      geo.leaves.computeBoundingBox();
      const bb = geo.leaves.boundingBox!;
      const size = bb.getSize(new THREE.Vector3());
      const center = bb.getCenter(new THREE.Vector3());
      const proxy = new THREE.IcosahedronGeometry(0.5, 1)
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
      return { geo, proxy, impostor: impostorGeometry(width, height), impostorMat };
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
        trunk.castShadow = nearTown;
        trunk.receiveShadow = true;
        leaves.receiveShadow = true;
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
