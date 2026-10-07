import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../geo';
import { Species } from './vegetation';

/**
 * Árvores low-poly: copas de icosaedros "amassados" e cones, facetadas.
 * Cor de vértice = só luminosidade (base mais escura, topo claro, variação
 * por face); o tom (verde, ipê amarelo/rosa) vem da cor da instância.
 * `detail` 1 = perto, 0 = longe (20 faces por copa).
 */
export interface LowpolyTree {
  /** tronco + copa numa geometria só (vertex color: tronco marrom fixo) */
  whole: THREE.BufferGeometry;
  /** só a copa (tingida por instância) */
  crown: THREE.BufferGeometry;
  /** só o tronco (cor fixa) */
  trunk: THREE.BufferGeometry;
}

const TRUNK = new THREE.Color('#6b4a33');

/** icosaedro com vértices deslocados (mesma posição = mesmo deslocamento: sem rachaduras) */
function blob(r: number, sx: number, sy: number, sz: number, detail: number, rng: () => number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.attributes.position as THREE.BufferAttribute;
  const jit = new Map<string, [number, number, number]>();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let j = jit.get(key);
    if (!j) {
      const k = 1 + (rng() - 0.5) * 0.28;
      j = [k, k * (1 + (rng() - 0.5) * 0.1), k];
      jit.set(key, j);
    }
    p.setXYZ(i, p.getX(i) * j[0] * sx, p.getY(i) * j[1] * sy, p.getZ(i) * j[2] * sz);
  }
  // base achatada: copa não termina em ponta embaixo
  for (let i = 0; i < p.count; i++) if (p.getY(i) < -r * sy * 0.55) p.setY(i, -r * sy * 0.55);
  return g;
}

/** cor de vértice por face: claro em cima, escuro embaixo, ruído por face */
function shadeCrown(g: THREE.BufferGeometry, yMin: number, yMax: number, rng: () => number) {
  const p = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i += 3) {
    const y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
    const t = THREE.MathUtils.clamp((y - yMin) / Math.max(0.01, yMax - yMin), 0, 1);
    const v = (0.72 + 0.34 * t) * (0.93 + rng() * 0.14);
    for (let k = 0; k < 3; k++) col.set([v, v, v], (i + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

function solid(g: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  const n = ng.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return ng;
}

function trunkGeo(h: number, r0: number, r1: number, seg: number, lean = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, h, seg, 1, true);
  g.translate(0, h / 2 - 0.2, 0);
  if (lean) g.applyMatrix4(new THREE.Matrix4().makeShear(0, 0, lean, 0, 0, 0));
  return solid(g, TRUNK);
}

function prep(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  return ng;
}

export function lowpolyTree(kind: Species, detail: 0 | 1): LowpolyTree {
  const rng = mulberry32(500 + kind * 17 + detail);
  const seg = detail ? 6 : 4;
  let trunk: THREE.BufferGeometry;
  const crowns: THREE.BufferGeometry[] = [];

  if (kind === Species.Palm) {
    trunk = trunkGeo(10.4, 0.3, 0.2, seg);
    // folhas: cones finos e achatados irradiando do topo, caídos
    const n = detail ? 8 : 5;
    for (let i = 0; i < n; i++) {
      const f = new THREE.ConeGeometry(0.55, 4.6, 3, 1);
      f.scale(1, 1, 0.25);
      f.translate(0, 2.3, 0);
      f.rotateZ(-1.15 - rng() * 0.35); // inclina para fora e para baixo
      f.rotateY((i / n) * Math.PI * 2 + rng() * 0.3);
      f.translate(0, 10.2, 0);
      crowns.push(prep(f));
    }
    crowns.push(prep(blob(0.55, 1, 1, 1, 0, rng).translate(0, 10.2, 0)));
  } else if (kind === Species.Eucalyptus) {
    trunk = trunkGeo(9.5, 0.26, 0.12, seg, 0.02);
    crowns.push(prep(blob(1.9, 1, 1.7, 1, detail, rng).translate(0.2, 9.4, 0.1)));
    if (detail) crowns.push(prep(blob(1.2, 1, 1.3, 1, 1, rng).translate(0.9, 7.4, 0.5)));
  } else {
    // copa larga (e ipê): 1 copa central + 2-3 menores em volta
    trunk = trunkGeo(3.6, 0.28, 0.18, seg);
    crowns.push(prep(blob(2.5, 1.05, 0.82, 1.05, detail, rng).translate(0, 4.9, 0)));
    const extra = detail ? 3 : 1;
    for (let i = 0; i < extra; i++) {
      const a = (i / extra) * Math.PI * 2 + rng();
      crowns.push(prep(blob(1.5 + rng() * 0.4, 1, 0.85, 1, detail, rng).translate(Math.cos(a) * 1.9, 4.2 + rng() * 0.9, Math.sin(a) * 1.9)));
    }
  }
  const crown = mergeGeometries(crowns)!;
  crown.computeBoundingBox();
  shadeCrown(crown, crown.boundingBox!.min.y, crown.boundingBox!.max.y, rng);
  crown.computeVertexNormals();
  trunk.computeVertexNormals();
  return { whole: mergeGeometries([trunk, crown])!, crown, trunk };
}

/**
 * Tons por espécie, na ordem de Species (Broadleaf, Ipe, Palm, Eucalyptus).
 * Índice numérico: evita depender do enum na carga do módulo (import circular).
 */
export const LOWPOLY_TINTS: string[][] = [
  ['#5f9a3c', '#6aa843', '#4f8c36', '#78b04a', '#58933a', '#86b84f'],
  ['#f2c230', '#f5b82a', '#d877c8', '#e58fd2', '#f7d046'],
  ['#6aa346', '#5c9640', '#76ae4c'],
  ['#7ea05a', '#6f9452', '#89a866'],
];
