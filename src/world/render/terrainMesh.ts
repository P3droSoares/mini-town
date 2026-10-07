import * as THREE from 'three';
import type { CityData } from '../../data/types';
import type { HeightField } from '../HeightField';
import { PALETTE } from './palette';
import type { TextureLibrary } from './textures';

/**
 * Material de chão: grama (textura aérea normalizada x cor da paleta) +
 * solo laterítico vermelho natural, misturados pelo atributo `blend`
 * (x = solo, y = urbano/seco). Sem o atributo (áreas verdes) vira grama pura.
 */
export function createGroundMaterial(tex: TextureLibrary, extra: THREE.MeshStandardMaterialParameters = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, ...extra });
  tex.apply(m, 'grass', 0.8);
  const soil = tex.get('soil');
  const grass = tex.get('grass');
  const norm = grass
    ? new THREE.Vector3(1 / Math.max(0.02, grass.avg.r), 1 / Math.max(0.02, grass.avg.g), 1 / Math.max(0.02, grass.avg.b))
    : new THREE.Vector3(1, 1, 1);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.tSoil = { value: soil?.map ?? null };
    shader.uniforms.uSoilScale = { value: 1 / (soil?.size ?? 2) };
    shader.uniforms.uGrassNorm = { value: norm };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 blend;\nvarying vec2 vBlend;\nvarying vec2 vGroundUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBlend = blend;\nvGroundUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform sampler2D tSoil;\nuniform float uSoilScale;\nuniform vec3 uGrassNorm;\nvarying vec2 vBlend;\nvarying vec2 vGroundUv;',
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
  vec4 g1 = texture2D(map, vMapUv);
  vec4 g2 = texture2D(map, vMapUv * 3.7 + 0.31);
  // grama: textura normalizada (só detalhe) x cor da paleta (vertex color)
  vec3 groundC = mix(vec3(1.0), mix(g1.rgb, g2.rgb, 0.4) * uGrassNorm, 0.55) * vColor.rgb;
  ${soil ? 'vec3 soilC = texture2D(tSoil, vGroundUv * uSoilScale).rgb * 1.3;' : 'vec3 soilC = vec3(0.35, 0.12, 0.06);'}
  groundC = mix(groundC, soilC, clamp(vBlend.x, 0.0, 1.0));
  groundC = mix(groundC, groundC * vec3(1.06, 0.98, 0.86), clamp(vBlend.y, 0.0, 1.0));
  diffuseColor.rgb *= groundC;
#endif`,
      )
      .replace('#include <color_fragment>', '#ifndef USE_MAP\n#include <color_fragment>\n#endif');
  };
  m.customProgramCacheKey = () => `ground-v2-${!!soil}`;
  return m;
}

/**
 * Malha do terreno a partir do heightmap. As bordas são "esticadas" para
 * longe (anel externo) — com a névoa, o limite do mapa some no horizonte.
 */
export function buildTerrainMesh(hf: HeightField, data: CityData, tex: TextureLibrary): THREE.Mesh {
  // passo 1 = mesma triangulação do HeightField (ruas/prédios assentam exatamente)
  let nx: number;
  let minX: number;
  let minZ: number;
  let cell: number;
  if (hf.isFlat) {
    nx = 3;
    cell = 1600;
    minX = minZ = -1600;
  } else {
    nx = hf.size;
    cell = hf.cell;
    minX = hf.minX;
    minZ = hf.minZ;
  }
  const n = nx + 2; // +1 anel de "saia" em cada lado
  const FAR = 7000;
  const positions = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const blends = new Float32Array(n * n * 2);
  const uvs = new Float32Array(n * n * 2);
  const b = data.bounds;
  const low = new THREE.Color(PALETTE.terrainLow);
  const high = new THREE.Color(PALETTE.terrainHigh);
  const tint = new THREE.Color();
  const maxX = minX + (nx - 1) * cell;
  const maxZ = minZ + (nx - 1) * cell;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const ii = Math.min(Math.max(i - 1, 0), nx - 1);
      const jj = Math.min(Math.max(j - 1, 0), nx - 1);
      let x = minX + ii * cell;
      let z = minZ + jj * cell;
      const y = hf.isFlat ? 0 : hf.at(ii, jj);
      if (i === 0) x = -FAR;
      if (i === n - 1) x = FAR;
      if (j === 0) z = -FAR;
      if (j === n - 1) z = FAR;
      const k = j * n + i;
      positions[k * 3] = x;
      positions[k * 3 + 1] = i === 0 || j === 0 || i === n - 1 || j === n - 1 ? y - 15 : y;
      positions[k * 3 + 2] = z;
      uvs[k * 2] = x;
      uvs[k * 2 + 1] = z;

      const sx = Math.min(Math.max(x, minX), maxX);
      const sz = Math.min(Math.max(z, minZ), maxZ);
      const slope = hf.slope(sx, sz);
      // manchas de terra exposta (barrancos, lotes vagos) + encostas íngremes
      const patch = Math.sin(x * 0.021 + Math.sin(z * 0.013) * 2.0) * Math.cos(z * 0.017 - x * 0.006) + Math.sin((x - z) * 0.047) * 0.35;
      const soilW = THREE.MathUtils.smoothstep(slope, 0.22, 0.5) * 0.9 + THREE.MathUtils.smoothstep(patch, 0.75, 1.05) * 0.6;
      const dx = Math.max(b.minX - x, 0, x - b.maxX);
      const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
      const urban = 1 - THREE.MathUtils.smoothstep(Math.hypot(dx, dz), 0, 160);
      blends[k * 2] = Math.min(1, soilW);
      blends[k * 2 + 1] = urban * 0.7;
      // tom macro: encostas altas mais escuras (mata), baixadas mais claras
      const hn = THREE.MathUtils.clamp((y + 10) / 180, 0, 1);
      tint.copy(low).lerp(high, hn);
      const v = 1 + Math.sin(x * 0.009) * Math.cos(z * 0.011) * 0.08;
      colors[k * 3] = tint.r * v;
      colors[k * 3 + 1] = tint.g * v;
      colors[k * 3 + 2] = tint.b * v;
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
  g.setAttribute('blend', new THREE.BufferAttribute(blends, 2));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, createGroundMaterial(tex));
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  return mesh;
}
