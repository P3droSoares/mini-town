import * as THREE from 'three';
import type { CityData } from '../../data/types';
import type { HeightField } from '../HeightField';
import { PALETTE, color } from './palette';

/**
 * Malha do terreno a partir do heightmap. As bordas são "esticadas" para
 * longe (anel externo) — com a névoa, o limite do mapa some no horizonte.
 * Sem heightmap: plano grande (estrutura igual, TODO: nada a fazer).
 */
export function buildTerrainMesh(hf: HeightField, data: CityData): THREE.Mesh {
  // passo 1 = mesma triangulação do HeightField (ruas/prédios assentam exatamente)
  const step = 1;
  let nx: number;
  let minX: number;
  let minZ: number;
  let cell: number;
  if (hf.isFlat) {
    nx = 3;
    cell = 1600;
    minX = minZ = -1600;
  } else {
    nx = Math.floor((hf.size - 1) / step) + 1;
    cell = hf.cell * step;
    minX = hf.minX;
    minZ = hf.minZ;
  }
  const n = nx + 2; // +1 anel de "saia" em cada lado
  const FAR = 7000;
  const positions = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const b = data.bounds;
  const low = color(PALETTE.terrainLow);
  const high = color(PALETTE.terrainHigh);
  const soil = color(PALETTE.terrainSoil);
  const urban = color(PALETTE.terrainUrban);
  const tmp = new THREE.Color();
  const maxX = minX + (nx - 1) * cell;
  const maxZ = minZ + (nx - 1) * cell;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const ii = Math.min(Math.max(i - 1, 0), nx - 1);
      const jj = Math.min(Math.max(j - 1, 0), nx - 1);
      let x = minX + ii * cell;
      let z = minZ + jj * cell;
      const y = hf.isFlat ? 0 : hf.at(ii * step, jj * step);
      if (i === 0) x = -FAR;
      if (i === n - 1) x = FAR;
      if (j === 0) z = -FAR;
      if (j === n - 1) z = FAR;
      const k = (j * n + i) * 3;
      positions[k] = x;
      positions[k + 1] = i === 0 || j === 0 || i === n - 1 || j === n - 1 ? y - 15 : y;
      positions[k + 2] = z;

      // cor: verde por altitude, terra vermelha (minério!) nas encostas, bege na área urbana
      const sx = Math.min(Math.max(x, minX), maxX);
      const sz = Math.min(Math.max(z, minZ), maxZ);
      const slope = hf.slope(sx, sz);
      const hn = THREE.MathUtils.clamp((y + 10) / 160, 0, 1);
      tmp.copy(low).lerp(high, hn);
      tmp.lerp(soil, THREE.MathUtils.smoothstep(slope, 0.18, 0.45) * 0.75);
      const dx = Math.max(b.minX - x, 0, x - b.maxX);
      const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
      const outside = Math.hypot(dx, dz);
      tmp.lerp(urban, (1 - THREE.MathUtils.smoothstep(outside, 0, 160)) * 0.45);
      // ruído leve por vértice
      const nse = (Math.sin(x * 0.091 + z * 0.057) * Math.cos(z * 0.083 - x * 0.031)) * 0.04;
      colors[k] = tmp.r + nse;
      colors[k + 1] = tmp.g + nse;
      colors[k + 2] = tmp.b + nse * 0.5;
    }
  }

  const index: number[] = [];
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b2 = (j + 1) * n + i;
      const c = (j + 1) * n + i + 1;
      const d = j * n + i + 1;
      // mesma diagonal do HeightField.sample
      index.push(a, b2, d, b2, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, flatShading: false });
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  return mesh;
}
