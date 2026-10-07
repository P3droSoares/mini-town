import * as THREE from 'three';
import type { Ring } from '../../data/types';
import type { HeightField } from '../HeightField';
import { GeometryWriter, UP } from './GeometryWriter';

/**
 * Polígono "drapeado" no relevo: triangula e subdivide até arestas < maxEdge,
 * amostrando a altura do terreno em cada vértice.
 */
export function writeDrapedPolygon(
  w: GeometryWriter,
  outer: Ring,
  holes: Ring[] | undefined,
  hf: HeightField,
  c: THREE.Color,
  lift: number,
  maxEdge = 9,
  flatY?: number,
) {
  const contour = outer.map(([x, z]) => new THREE.Vector2(x, z));
  const hs = (holes ?? []).map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
  let tris: number[][];
  try {
    tris = THREE.ShapeUtils.triangulateShape(contour, hs);
  } catch {
    return;
  }
  const all = contour.concat(...hs);
  const h = (x: number, z: number) => (flatY !== undefined ? flatY : hf.sample(x, z) + lift);
  const maxE2 = maxEdge * maxEdge;
  const emit = (a: THREE.Vector2, b: THREE.Vector2, d: THREE.Vector2, depth: number) => {
    const ab = a.distanceToSquared(b);
    const bd = b.distanceToSquared(d);
    const da = d.distanceToSquared(a);
    if (depth < 7 && !hf.isFlat && flatY === undefined && Math.max(ab, bd, da) > maxE2) {
      const m1 = a.clone().add(b).multiplyScalar(0.5);
      const m2 = b.clone().add(d).multiplyScalar(0.5);
      const m3 = d.clone().add(a).multiplyScalar(0.5);
      emit(a, m1, m3, depth + 1);
      emit(m1, b, m2, depth + 1);
      emit(m3, m2, d, depth + 1);
      emit(m1, m2, m3, depth + 1);
      return;
    }
    w.tri(new THREE.Vector3(a.x, h(a.x, a.y), a.y), new THREE.Vector3(b.x, h(b.x, b.y), b.y), new THREE.Vector3(d.x, h(d.x, d.y), d.y), c, UP);
  };
  for (const [i0, i1, i2] of tris) emit(all[i0], all[i1], all[i2], 0);
}
