import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../geo';
import { Species } from './vegetation';

/**
 * Árvores estilizadas de formas suaves (sem quinas): copas em "nuvem" de
 * esferas lisas levemente onduladas, tronco cônico, palmeira com tronco
 * curvo e folhas arqueadas, cipreste em cone arredondado.
 * Cor de vértice = luminosidade (base escura, topo claro); o tom vem da cor
 * da instância. `detail` 1 = perto, 0 = longe.
 */
export interface LowpolyTree {
  /** tronco + copa numa geometria só (longe) */
  whole: THREE.BufferGeometry;
  /** só a copa (tingida por instância) */
  crown: THREE.BufferGeometry;
  /** só o tronco (cor fixa) */
  trunk: THREE.BufferGeometry;
}

const TRUNK = new THREE.Color('#7a5638');

/** prepara para mesclar: sem índice, sem uv, com cor */
function flat(g: THREE.BufferGeometry, color?: THREE.Color): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  if (ng.attributes.uv) ng.deleteAttribute('uv');
  if (color) {
    const n = ng.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([color.r, color.g, color.b], i * 3);
    ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  return ng;
}

/** esfera lisa com ondulação suave (copa "fofa") */
function puff(r: number, sx: number, sy: number, sz: number, detail: number, seed: number): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(r, detail ? 3 : 1);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = v.clone().normalize();
    const wob = 1 + 0.07 * Math.sin(n.x * 5.1 + seed) * Math.cos(n.z * 4.3 - seed * 0.7) + 0.05 * Math.sin(n.y * 6.7 + seed * 1.3);
    v.multiplyScalar(wob);
    // base levemente achatada
    if (v.y < -r * 0.45) v.y = -r * 0.45 + (v.y + r * 0.45) * 0.35;
    p.setXYZ(i, v.x * sx, v.y * sy, v.z * sz);
  }
  g.computeVertexNormals();
  return g;
}

/** luminosidade por vértice: base mais escura, topo claro */
function shade(g: THREE.BufferGeometry, yMin: number, yMax: number) {
  const p = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const t = THREE.MathUtils.clamp((p.getY(i) - yMin) / Math.max(0.01, yMax - yMin), 0, 1);
    const v = 0.68 + 0.4 * t * t * (3 - 2 * t);
    col.set([v, v, v], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

/** tronco cônico liso, opcionalmente curvo (tubo ao longo de uma curva) */
function trunkTube(points: THREE.Vector3[], r0: number, r1: number, radial: number, segs: number): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points);
  const g = new THREE.TubeGeometry(curve, segs, 1, radial, false);
  // afina do pé ao topo
  const p = g.attributes.position as THREE.BufferAttribute;
  const pts = curve.getSpacedPoints(segs);
  for (let s = 0; s <= segs; s++) {
    const r = r0 + (r1 - r0) * (s / segs);
    const c = pts[s];
    for (let k = 0; k <= radial; k++) {
      const i = s * (radial + 1) + k;
      p.setXYZ(i, c.x + (p.getX(i) - c.x) * r, c.y + (p.getY(i) - c.y) * r, c.z + (p.getZ(i) - c.z) * r);
    }
  }
  g.computeVertexNormals();
  return flat(g, TRUNK);
}

/** folha de palmeira: fita arqueada, larga no meio, com as duas faces */
function frond(len: number, width: number, droop: number, segs: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const x = t * len;
    const y = Math.sin(t * Math.PI * 0.55) * len * 0.28 - t * t * droop;
    const w = width * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (1 - t * 0.3);
    // leve "V" no meio da folha (vinco central)
    pos.push(x, y, -w, x, y + w * 0.25, 0, x, y, w);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 3;
    const b = (i + 1) * 3;
    for (const [p, q] of [
      [0, 1],
      [1, 2],
    ]) {
      idx.push(a + p, b + p, b + q, a + p, b + q, a + q);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // verso com vértices próprios (normais opostas)
  const back = g.clone();
  const bi = back.index!.array as Uint16Array | Uint32Array;
  for (let i = 0; i < bi.length; i += 3) [bi[i + 1], bi[i + 2]] = [bi[i + 2], bi[i + 1]];
  const bn = back.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < bn.count; i++) bn.setXYZ(i, -bn.getX(i), -bn.getY(i), -bn.getZ(i));
  return mergeGeometries([g, back])!;
}

/** cone arredondado em camadas (cipreste/pinheiro) por revolução */
function roundCone(h: number, r: number, tiers: number, radial: number): THREE.BufferGeometry {
  const prof: THREE.Vector2[] = [new THREE.Vector2(0.001, 0)];
  for (let t = 0; t < tiers; t++) {
    const y0 = (t / tiers) * h * 0.92;
    const rr = r * (1 - (t / tiers) * 0.72);
    const steps = 6;
    for (let k = 0; k <= steps; k++) {
      const a = (k / steps) * Math.PI;
      // cada camada é um "pneu" arredondado que se afunila
      prof.push(new THREE.Vector2(Math.max(0.05, rr * (0.55 + 0.45 * Math.sin(a))), y0 + (k / steps) * (h / tiers) * 1.1));
    }
  }
  prof.push(new THREE.Vector2(0.001, h));
  const g = new THREE.LatheGeometry(prof, radial);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  const m = mergeVertices(g);
  m.computeVertexNormals();
  return m;
}

export function lowpolyTree(kind: Species, detail: 0 | 1): LowpolyTree {
  const rng = mulberry32(900 + kind * 17 + detail);
  const radial = detail ? 8 : 5;
  let trunk: THREE.BufferGeometry;
  const crowns: THREE.BufferGeometry[] = [];
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  if (kind === Species.Palm) {
    trunk = trunkTube([V(0, -0.3, 0), V(0.15, 2.5, 0), V(0.55, 5, 0.1), V(0.9, 7.2, 0.15)], 0.32, 0.2, radial, detail ? 8 : 4);
    const top = V(0.9, 7.2, 0.15);
    const n = detail ? 9 : 6;
    for (let i = 0; i < n; i++) {
      const f = frond(4.2 + rng() * 0.8, 0.55, 1.6 + rng() * 0.8, detail ? 8 : 4);
      f.rotateZ(0.15 + rng() * 0.25);
      f.rotateY((i / n) * Math.PI * 2 + rng() * 0.3);
      f.translate(top.x, top.y, top.z);
      crowns.push(flat(f));
    }
    crowns.push(flat(puff(0.6, 1, 0.8, 1, detail, 3).translate(top.x, top.y - 0.1, top.z)));
  } else if (kind === Species.Eucalyptus) {
    // cipreste: cone arredondado em camadas
    trunk = trunkTube([V(0, -0.3, 0), V(0, 2.2, 0)], 0.24, 0.18, radial, 1);
    crowns.push(flat(roundCone(8.5, 2.3, 4, detail ? 14 : 7).translate(0, 1.4, 0)));
  } else if (kind === Species.Ipe) {
    trunk = trunkTube([V(0, -0.3, 0), V(0.1, 2, 0), V(-0.1, 3.4, 0.1)], 0.26, 0.16, radial, detail ? 4 : 2);
    crowns.push(flat(puff(2.6, 1.15, 0.78, 1.15, detail, 1.7).translate(0, 4.6, 0)));
    crowns.push(flat(puff(1.5, 1, 0.85, 1, detail, 4.1).translate(1.2, 5.5, -0.6)));
  } else {
    // copa larga: nuvem de 4-5 esferas lisas sobre tronco com galhos
    trunk = mergeGeometries([
      trunkTube([V(0, -0.3, 0), V(0.05, 1.8, 0), V(0, 3.4, 0)], 0.3, 0.17, radial, detail ? 3 : 1),
      ...(detail ? [trunkTube([V(0, 2.4, 0), V(0.9, 3.4, 0.3), V(1.4, 4.1, 0.5)], 0.12, 0.06, 5, 3), trunkTube([V(0, 2.6, 0), V(-0.8, 3.6, -0.4), V(-1.3, 4.3, -0.6)], 0.11, 0.05, 5, 3)] : []),
    ])!;
    crowns.push(flat(puff(2.3, 1.05, 0.9, 1.05, detail, 0.3).translate(0, 5.0, 0)));
    const extra = detail ? 4 : 2;
    for (let i = 0; i < extra; i++) {
      const a = (i / extra) * Math.PI * 2 + rng() * 0.6;
      const rr = 1.5 + rng() * 0.4;
      crowns.push(flat(puff(rr, 1, 0.88, 1, detail, i * 2.3 + 1).translate(Math.cos(a) * 1.75, 4.3 + rng() * 0.9, Math.sin(a) * 1.75)));
    }
  }
  const crown = mergeGeometries(crowns)!;
  crown.computeBoundingBox();
  shade(crown, crown.boundingBox!.min.y, crown.boundingBox!.max.y);
  return { whole: mergeGeometries([trunk, crown])!, crown, trunk };
}

/**
 * Tons por espécie, na ordem de Species (copa larga, ipê, palmeira, cipreste).
 * Índice numérico: evita depender do enum na carga do módulo (import circular).
 */
export const LOWPOLY_TINTS: string[][] = [
  ['#6aa843', '#78b34c', '#5c9a3c', '#86bd55', '#63a142', '#93c35e'],
  ['#f4c43a', '#f7b833', '#e389d0', '#ee9fd9', '#f9d457', '#ffffff'],
  ['#74ad4c', '#68a246', '#80b656'],
  ['#4f8a46', '#5a944c', '#46803f'],
];
