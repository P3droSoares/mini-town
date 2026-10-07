import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import type { Building } from '../data/types';
import type { WorldState } from './WorldState';
import { GeometryWriter } from './render/GeometryWriter';
import { writeDrapedPolygon } from './render/areaGeometry';
import { writeBuilding } from './render/buildingGeometry';
import { createBuildingMaterial, createVertexColorMaterial, worldUniforms } from './render/materials';
import { PALETTE, color } from './render/palette';
import { writeStreet, writeWaterLine } from './render/roadGeometry';
import { StreetLights } from './render/StreetLights';
import { buildTerrainMesh } from './render/terrainMesh';
import { createTreeGeometries, leafColors, scatterTrees, type TreeInstance } from './render/vegetation';

// BVH para raycast rápido nos prédios mesclados
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export const CHUNK_SIZE = 250;

/** perfil de construção (ms acumulados), exibido no console */
const prof: Record<string, number> = {};
let pt = 0;
const mark = (k?: string) => {
  const n = performance.now();
  if (k) prof[k] = Math.round(((prof[k] ?? 0) + n - pt) * 10) / 10;
  pt = n;
};

interface Span {
  building: Building;
  start: number;
  count: number;
}

export interface Chunk {
  key: string;
  cx: number;
  cz: number;
  center: THREE.Vector3;
  group: THREE.Group;
  lod: THREE.LOD;
  high: THREE.Mesh | null;
  low: THREE.Mesh | null;
  /** intervalos de vértices -> prédio, ordenados por start (picking) */
  spans: Span[];
  buildings: Building[];
  streets: WorldState['data']['streets'];
  greens: WorldState['data']['greens'];
  trees: TreeInstance[];
}

export interface BuildOptions {
  mobile: boolean;
  onProgress?: (fraction: number, label: string) => void;
}

/**
 * Cede a thread para a UI (barra de progresso) só quando o orçamento de
 * tempo estoura. setTimeout em vez de rAF: rAF é estrangulado em abas ocultas.
 */
let sliceStart = performance.now();
const channel = new MessageChannel();
const waiting: (() => void)[] = [];
channel.port1.onmessage = () => waiting.shift()?.();
const nextFrame = (force = false) => {
  if (!force && performance.now() - sliceStart < 40) return Promise.resolve();
  return new Promise<void>((r) => {
    waiting.push(() => {
      sliceStart = performance.now();
      r();
    });
    channel.port2.postMessage(0);
  });
};

/**
 * Representação 3D da cidade (somente renderização). Lê `WorldState` e
 * monta malhas por chunk, com LOD e geometrias mescladas.
 */
export class CityView {
  readonly root = new THREE.Group();
  readonly chunks = new Map<string, Chunk>();
  /** malhas de alto detalhe usadas no raycast (não precisam estar visíveis) */
  readonly pickMeshes: THREE.Mesh[] = [];
  terrain!: THREE.Mesh;
  streetLights!: StreetLights;
  readonly buildingMaterial = createBuildingMaterial();
  readonly roadMaterial = createVertexColorMaterial({ polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  readonly walkMaterial = createVertexColorMaterial({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  readonly areaMaterial = createVertexColorMaterial({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  readonly waterMaterial = createWaterMaterial({ polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  readonly treeMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });

  constructor(private readonly world: WorldState) {
    this.root.name = 'city';
  }

  private chunkKey(x: number, z: number) {
    return `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
  }

  private chunkFor(x: number, z: number): Chunk {
    const key = this.chunkKey(x, z);
    let c = this.chunks.get(key);
    if (!c) {
      const cx = Math.floor(x / CHUNK_SIZE);
      const cz = Math.floor(z / CHUNK_SIZE);
      const center = new THREE.Vector3((cx + 0.5) * CHUNK_SIZE, 0, (cz + 0.5) * CHUNK_SIZE);
      center.y = this.world.height.sample(center.x, center.z);
      const group = new THREE.Group();
      group.name = `chunk:${key}`;
      const lod = new THREE.LOD();
      lod.position.copy(center);
      group.add(lod);
      c = { key, cx, cz, center, group, lod, high: null, low: null, spans: [], buildings: [], streets: [], greens: [], trees: [] };
      this.chunks.set(key, c);
    }
    return c;
  }

  async build(opts: BuildOptions) {
    const { world } = this;
    const hf = world.height;
    const report = opts.onProgress ?? (() => {});

    const tm: Record<string, number> = {};
    let t0 = performance.now();
    const lap = (k: string) => {
      const n = performance.now();
      tm[k] = Math.round((tm[k] ?? 0) + n - t0);
      t0 = n;
    };
    report(0.02, 'Modelando o relevo…');
    this.terrain = buildTerrainMesh(hf, world.data);
    this.terrain.geometry.computeBoundsTree();
    this.root.add(this.terrain);
    lap('terreno');
    await nextFrame();

    // distribui entidades por chunk
    for (const b of world.data.buildings) this.chunkFor(b.centroid[0], b.centroid[1]).buildings.push(b);
    for (const s of world.data.streets) {
      const m = s.points[Math.floor(s.points.length / 2)];
      this.chunkFor(m[0], m[1]).streets.push(s);
    }
    for (const g of world.data.greens) {
      const p = g.outer[0];
      this.chunkFor(p[0], p[1]).greens.push(g);
    }
    lap('indices');

    report(0.08, 'Plantando árvores…');
    await nextFrame();
    const trees = scatterTrees(world, opts.mobile);
    for (const t of trees) this.chunkFor(t.x, t.z).trees.push(t);
    lap('arvores');

    // água (global, poucas feições)
    const water = new GeometryWriter();
    const bank = new GeometryWriter();
    for (const wl of world.data.waterLines) writeWaterLine(water, bank, wl, hf);
    for (const wa of world.data.waterAreas) {
      let minH = Infinity;
      for (const [x, z] of wa.outer) minH = Math.min(minH, hf.sample(x, z));
      writeDrapedPolygon(water, wa.outer, wa.holes, hf, color(PALETTE.water), 0, 9, minH + 0.15);
    }
    if (water.vertexCount) {
      const wm = new THREE.Mesh(water.toGeometry(), this.waterMaterial);
      wm.name = 'water';
      wm.receiveShadow = true;
      wm.renderOrder = 1;
      this.root.add(wm);
    }
    if (bank.vertexCount) {
      const bm = new THREE.Mesh(bank.toGeometry(), this.areaMaterial);
      bm.receiveShadow = true;
      this.root.add(bm);
    }

    const treeGeos = createTreeGeometries();
    const leaves = leafColors();
    const list = [...this.chunks.values()];
    let done = 0;
    for (const chunk of list) {
      t0 = performance.now();
      this.buildChunk(chunk, treeGeos, leaves);
      lap('chunks');
      this.root.add(chunk.group);
      done++;
      report(0.12 + 0.8 * (done / list.length), `Construindo quadras… ${done}/${list.length}`);
      await nextFrame();
    }

    report(0.94, 'Acendendo os postes…');
    this.streetLights = new StreetLights(world);
    this.root.add(this.streetLights.group);
    lap('postes');
    console.info('[CityView] tempos de construção (ms)', tm, prof, `árvores: ${trees.length}, postes: ${this.streetLights.count}`);
    await nextFrame();
    report(1, 'Pronto');
  }

  private buildChunk(chunk: Chunk, treeGeos: THREE.BufferGeometry[], leaves: THREE.Color[]) {
    const hf = this.world.height;
    const o = chunk.center;

    // ---- prédios: alto detalhe (LOD0) e baixo (LOD1), mesclados por chunk
    mark();
    if (chunk.buildings.length) {
      const highGeos: THREE.BufferGeometry[] = [];
      const lowGeos: THREE.BufferGeometry[] = [];
      let vertexOffset = 0;
      for (const b of chunk.buildings) {
        const wh = new GeometryWriter();
        writeBuilding(wh, b, hf, 'high');
        const g = wh.toGeometry();
        g.translate(-o.x, -o.y, -o.z);
        highGeos.push(g);
        chunk.spans.push({ building: b, start: vertexOffset, count: wh.vertexCount });
        vertexOffset += wh.vertexCount;
        const wl = new GeometryWriter();
        writeBuilding(wl, b, hf, 'low');
        const gl = wl.toGeometry();
        gl.translate(-o.x, -o.y, -o.z);
        lowGeos.push(gl);
      }
      mark('predios.geo');
      const high = new THREE.Mesh(mergeGeometries(highGeos)!, this.buildingMaterial);
      const low = new THREE.Mesh(mergeGeometries(lowGeos)!, this.buildingMaterial);
      highGeos.forEach((g) => g.dispose());
      lowGeos.forEach((g) => g.dispose());
      high.castShadow = high.receiveShadow = true;
      low.receiveShadow = true;
      high.userData.chunk = chunk;
      mark('predios.merge');
      high.geometry.computeBoundsTree();
      mark('predios.bvh');
      chunk.high = high;
      chunk.low = low;
      chunk.lod.addLevel(high, 0);
      chunk.lod.addLevel(low, 650);
      this.pickMeshes.push(high);
    }

    // ---- ruas e calçadas
    mark();
    const asphalt = new GeometryWriter();
    const walk = new GeometryWriter();
    for (const s of chunk.streets) writeStreet(asphalt, walk, s, hf);
    if (walk.vertexCount) {
      const m = new THREE.Mesh(walk.toGeometry(), this.walkMaterial);
      m.receiveShadow = true;
      chunk.group.add(m);
    }
    if (asphalt.vertexCount) {
      const m = new THREE.Mesh(asphalt.toGeometry(), this.roadMaterial);
      m.receiveShadow = true;
      m.renderOrder = 1;
      chunk.group.add(m);
    }

    mark('ruas');
    // ---- áreas verdes
    const areas = new GeometryWriter();
    for (const g of chunk.greens) {
      const c = color(
        g.kind === 'wood'
          ? PALETTE.wood
          : g.kind === 'pitch'
            ? PALETTE.pitch
            : g.kind === 'cemetery'
              ? PALETTE.cemetery
              : g.kind === 'park' || g.kind === 'garden'
                ? PALETTE.park
                : PALETTE.grass,
      );
      writeDrapedPolygon(areas, g.outer, g.holes, hf, c, 0.06);
    }
    if (areas.vertexCount) {
      const m = new THREE.Mesh(areas.toGeometry(), this.areaMaterial);
      m.receiveShadow = true;
      chunk.group.add(m);
    }

    mark('verdes');
    // ---- árvores (InstancedMesh por tipo, por chunk => frustum culling)
    for (const kind of [0, 1] as const) {
      const list = chunk.trees.filter((t) => t.kind === kind);
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(treeGeos[kind], this.treeMaterial, list.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const p = new THREE.Vector3();
      const axis = new THREE.Vector3(0, 1, 0);
      list.forEach((t, i) => {
        q.setFromAxisAngle(axis, t.rot);
        s.setScalar(t.scale);
        p.set(t.x, t.y, t.z);
        m.compose(p, q, s);
        im.setMatrixAt(i, m);
        im.setColorAt(i, leaves[t.tint]);
      });
      im.castShadow = true;
      im.receiveShadow = false;
      im.computeBoundingSphere();
      chunk.group.add(im);
    }
  }

  /** Converte um hit de raycast em prédio (via intervalo de vértices). */
  buildingFromHit(hit: THREE.Intersection): Building | undefined {
    const chunk = hit.object.userData.chunk as Chunk | undefined;
    if (!chunk || !hit.face) return undefined;
    const v = hit.face.a;
    const spans = chunk.spans;
    let lo = 0;
    let hi = spans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = spans[mid];
      if (v < s.start) hi = mid - 1;
      else if (v >= s.start + s.count) lo = mid + 1;
      else return s.building;
    }
    return undefined;
  }

  /** Geometria isolada de um prédio (para contorno de destaque). */
  buildingGeometry(b: Building): THREE.BufferGeometry {
    const w = new GeometryWriter();
    writeBuilding(w, b, this.world.height, 'high');
    return w.toGeometry();
  }

  update(dt: number) {
    worldUniforms.uTime.value += dt;
  }
}

function createWaterMaterial(extra: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.25, metalness: 0.1, ...extra });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = worldUniforms.uTime;
    shader.uniforms.uNight = worldUniforms.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 facade;\nvarying vec4 vFlow;\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFlow = facade;\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uNight;\nvarying vec4 vFlow;\nvarying vec3 vWPos;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float along = vFlow.w < 0.0 ? vFlow.x : vWPos.x * 0.7 + vWPos.z * 0.3;
float across = vFlow.w < 0.0 ? vFlow.y : vWPos.z * 0.05;
float r = sin(along * 0.55 - uTime * 1.6 + sin(across * 6.0 + uTime) * 1.5) * 0.5 + 0.5;
float r2 = sin(along * 1.7 - uTime * 2.3 + across * 9.0) * 0.5 + 0.5;
float sparkle = smoothstep(0.82, 1.0, r * r2);
diffuseColor.rgb = mix(diffuseColor.rgb * 0.92, diffuseColor.rgb * 1.12, r);
diffuseColor.rgb += sparkle * 0.18 * (1.0 - uNight);
float edge = vFlow.w < 0.0 ? smoothstep(0.0, 0.18, min(vFlow.y, 1.0 - vFlow.y)) : 1.0;
diffuseColor.rgb = mix(vec3(0.55, 0.62, 0.45), diffuseColor.rgb, edge);`,
      );
  };
  m.customProgramCacheKey = () => 'water-v1';
  return m;
}
