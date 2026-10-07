import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import type { QualityPreset } from '../core/quality';
import type { Building } from '../data/types';
import type { WorldState } from './WorldState';
import { GeometryWriter } from './render/GeometryWriter';
import { writeDrapedPolygon } from './render/areaGeometry';
import { type BuildingWriters, type FrontTest, WRITER_KEYS, type WindowInstance, type WriterKey, createWriters, writeBuilding } from './render/buildingGeometry';
import { createBuildingMaterial, createSignMaterial, createTexturedMaterial, worldUniforms } from './render/materials';
import { SignAtlas } from './render/signAtlas';
import { writeYard } from './render/yards';
import { createGroundMaterial } from './render/terrainMesh';
import { PALETTE, color } from './render/palette';
import { writeStreet, writeWaterLine } from './render/roadGeometry';
import { StreetLights } from './render/StreetLights';
import { buildTerrainMesh } from './render/terrainMesh';
import type { TextureLibrary } from './render/textures';
import { TreeRenderer, scatterTrees } from './render/vegetation';
import { LOWPOLY, SOFT } from './render/style';

// BVH para raycast rápido nos prédios
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export const CHUNK_SIZE = 250;

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
  buildings: Building[];
  streets: WorldState['data']['streets'];
  greens: WorldState['data']['greens'];
  lots: WorldState['data']['lots'];
}

export interface BuildOptions {
  onProgress?: (fraction: number, label: string) => void;
}

/**
 * Cede a thread para a UI (barra de progresso) só quando o orçamento de
 * tempo estoura. MessageChannel em vez de rAF/setTimeout: não é estrangulado
 * em abas ocultas.
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
 * monta, por chunk de 250 m, uma geometria por material (paredes, telhas,
 * concreto...) com LOD e frustum culling.
 */
export class CityView {
  readonly root = new THREE.Group();
  readonly chunks = new Map<string, Chunk>();
  /** malhas de alto detalhe usadas no raycast (não precisam estar visíveis) */
  readonly pickMeshes: THREE.Mesh[] = [];
  terrain!: THREE.Mesh;
  streetLights!: StreetLights;
  trees!: TreeRenderer;
  readonly materials: Record<WriterKey, THREE.Material>;
  readonly signs: SignAtlas;
  private readonly windowMeshes: THREE.InstancedMesh[] = [];
  private readonly windowGeometry = windowFrameGeometry();
  private readonly windowMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.55, metalness: 0.05 });
  readonly roadMaterial: THREE.MeshStandardMaterial;
  readonly walkMaterial: THREE.MeshStandardMaterial;
  readonly areaMaterial: THREE.MeshStandardMaterial;
  readonly waterMaterial: THREE.MeshStandardMaterial;
  readonly poolMaterial = new THREE.MeshStandardMaterial({ color: '#2aa4d8', roughness: 0.04, metalness: 0.1, emissive: '#0b3a52', emissiveIntensity: 0.4 });
  private frontTest: FrontTest;

  constructor(
    private readonly world: WorldState,
    private readonly tex: TextureLibrary,
    private readonly quality: QualityPreset,
  ) {
    this.root.name = 'city';
    // letreiros: nomes reais dos estabelecimentos + marcas genéricas
    this.signs = new SignAtlas(world.data.buildings.flatMap((b) => [b.name, ...(b.pois?.map((p) => p.name) ?? [])]).filter((n): n is string => !!n && n.length < 28));
    const buildingMat = createBuildingMaterial(tex.atlas);
    this.materials = {
      walls: buildingMat,
      detail: buildingMat,
      signs: createSignMaterial(this.signs.texture),
    };
    const off = (f: number) => ({ polygonOffset: true, polygonOffsetFactor: f, polygonOffsetUnits: f });
    this.roadMaterial = createTexturedMaterial(tex, 'asphalt', 0.8, off(-2));
    this.walkMaterial = createTexturedMaterial(tex, 'pavement', 0.7, off(-1));
    this.areaMaterial = createGroundMaterial(tex, off(-1));
    this.waterMaterial = createWaterMaterial(off(-3));
    this.frontTest = (mx, mz, ox, oz) => {
      const dOut = world.distanceToStreet(mx + ox * 3, mz + oz * 3, 30);
      const dIn = world.distanceToStreet(mx - ox * 3, mz - oz * 3, 30);
      return dOut < 22 && dOut < dIn - 1;
    };
  }

  private chunkFor(x: number, z: number): Chunk {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const key = `${cx},${cz}`;
    let c = this.chunks.get(key);
    if (!c) {
      const center = new THREE.Vector3((cx + 0.5) * CHUNK_SIZE, 0, (cz + 0.5) * CHUNK_SIZE);
      center.y = this.world.height.sample(center.x, center.z);
      const group = new THREE.Group();
      group.name = `chunk:${key}`;
      const lod = new THREE.LOD();
      lod.position.copy(center);
      group.add(lod);
      c = { key, cx, cz, center, group, lod, buildings: [], streets: [], greens: [], lots: [] };
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
    this.terrain = buildTerrainMesh(hf, world.data, this.tex);
    this.terrain.geometry.computeBoundsTree();
    this.root.add(this.terrain);
    lap('terreno');
    await nextFrame();

    for (const b of world.data.buildings) this.chunkFor(b.centroid[0], b.centroid[1]).buildings.push(b);
    for (const s of world.data.streets) {
      const m = s.points[Math.floor(s.points.length / 2)];
      this.chunkFor(m[0], m[1]).streets.push(s);
    }
    for (const g of world.data.greens) this.chunkFor(g.outer[0][0], g.outer[0][1]).greens.push(g);
    for (const l of world.data.lots) if (l.outer && !l.vacant) this.chunkFor(l.centroid[0], l.centroid[1]).lots.push(l);

    report(0.08, 'Plantando árvores…');
    await nextFrame();
    const trees = scatterTrees(world, this.quality.trees);
    // (árvores usam grade própria de 500 m — ver TreeRenderer)
    this.trees = new TreeRenderer(this.tex, this.quality, world.data.bounds);
    lap('arvores');

    // água (global, poucas feições)
    const water = new GeometryWriter();
    const bank = new GeometryWriter();
    const canal = new GeometryWriter();
    for (const wl of world.data.waterLines) writeWaterLine(water, bank, wl, hf, canal, (x, z) => world.isInsideBounds(x, z, 30));
    if (canal.vertexCount) {
      const cm = new THREE.Mesh(canal.toGeometry(), this.walkMaterial);
      cm.receiveShadow = cm.castShadow = true;
      this.root.add(cm);
    }
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

    const list = [...this.chunks.values()];
    let done = 0;
    for (const chunk of list) {
      t0 = performance.now();
      this.buildChunk(chunk);
      lap('chunks');
      this.root.add(chunk.group);
      done++;
      report(0.12 + 0.8 * (done / list.length), `Construindo quadras… ${done}/${list.length}`);
      await nextFrame();
    }

    for (const im of this.trees.build(trees)) this.root.add(im);

    // terrenos vagos reservados: terra batida + cerca baixa + placa "à venda"
    const lotGround = new GeometryWriter();
    const lotProps = new GeometryWriter();
    const soil = new THREE.Color('#6f7448');
    const fence = new THREE.Color('#d8d2c4');
    const sign = new THREE.Color('#e8743b');
    for (const lot of world.vacantLots) {
      const ring = lot.outer!;
      writeDrapedPolygon(lotGround, ring, undefined, hf, soil, 0.09);
      for (let i = 0; i < ring.length; i++) {
        const [ax, az] = ring[i];
        const [bx, bz] = ring[(i + 1) % ring.length];
        const len = Math.hypot(bx - ax, bz - az);
        const ux = (bx - ax) / len;
        const uz = (bz - az) / len;
        // mourões a cada 2 m + régua
        for (let t = 0; t <= len; t += 2) {
          const x = ax + ux * t;
          const z = az + uz * t;
          const y = hf.sample(x, z);
          lotProps.box(x, z, y, y + 0.7, ux, uz, 0.05, 0.05, fence);
        }
        const mx = (ax + bx) / 2;
        const mz = (az + bz) / 2;
        const my = hf.sample(mx, mz);
        lotProps.box(mx, mz, my + 0.45, my + 0.55, ux, uz, len / 2, 0.03, fence);
      }
      const [cx, cz] = lot.centroid;
      const cy = hf.sample(cx, cz);
      lotProps.box(cx, cz, cy, cy + 1.6, 1, 0, 0.05, 0.05, fence);
      lotProps.box(cx, cz, cy + 1.1, cy + 1.9, 1, 0, 0.7, 0.04, sign);
    }
    if (lotGround.vertexCount) {
      const g = new THREE.Mesh(lotGround.toGeometry(), this.areaMaterial);
      g.receiveShadow = true;
      const p = new THREE.Mesh(lotProps.toGeometry(), this.materials.detail);
      p.castShadow = p.receiveShadow = true;
      this.root.add(g, p);
    }
    report(0.94, 'Acendendo os postes…');
    this.streetLights = new StreetLights(world);
    this.root.add(this.streetLights.group);
    lap('postes');
    console.info('[CityView] tempos de construção (ms)', tm, `árvores: ${trees.length}, postes: ${this.streetLights.count}`);
    await nextFrame();
    report(1, 'Pronto');
  }

  /** escreve todos os prédios do chunk; retorna malhas por material + spans */
  private buildBuildings(chunk: Chunk, detail: 'high' | 'low') {
    const ws = createWriters();
    const spans: Record<WriterKey, Span[]> = { walls: [], detail: [], signs: [] };
    for (const b of chunk.buildings) {
      const before = WRITER_KEYS.map((k) => ws[k].vertexCount);
      writeBuilding(ws, b, this.world.height, detail, detail === 'high' ? this.frontTest : undefined, this.signs);
      WRITER_KEYS.forEach((k, i) => {
        const count = ws[k].vertexCount - before[i];
        if (count) spans[k].push({ building: b, start: before[i], count });
      });
    }
    const group = new THREE.Group();
    const o = chunk.center;
    const meshes: THREE.Mesh[] = [];
    for (const k of WRITER_KEYS) {
      if (!ws[k].vertexCount) continue;
      const g = ws[k].toGeometry();
      g.translate(-o.x, -o.y, -o.z);
      const m = new THREE.Mesh(g, this.materials[k]);
      m.receiveShadow = true;
      m.castShadow = detail === 'high';
      m.userData = { chunk, spans: spans[k] };
      group.add(m);
      meshes.push(m);
    }
    return { group, meshes, ws: ws as BuildingWriters };
  }

  private buildChunk(chunk: Chunk) {
    const hf = this.world.height;

    // ---- prédios: alto detalhe (LOD0) e baixo (LOD1)
    if (chunk.buildings.length) {
      const high = this.buildBuildings(chunk, 'high');
      const low = this.buildBuildings(chunk, 'low');
      for (const m of high.meshes) {
        m.geometry.computeBoundsTree();
        this.pickMeshes.push(m);
      }
      chunk.lod.addLevel(high.group, 0);
      chunk.lod.addLevel(low.group, this.quality.lodDistance);
      // molduras de janela instanciadas (só perto da câmera — ver update)
      if (high.ws.windows.length && this.quality.level !== 'low' && !LOWPOLY) {
        const im = buildWindowMesh(high.ws.windows, this.windowGeometry, this.windowMaterial);
        im.userData.center = chunk.center;
        this.windowMeshes.push(im);
        chunk.group.add(im);
      }
    }

    // ---- ruas e calçadas
    const asphalt = new GeometryWriter();
    const walk = new GeometryWriter();
    for (const s of chunk.streets) writeStreet(asphalt, walk, s, hf, this.world);
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

    // ---- quintais (muro, portão, grama/piso, piscina)
    if (chunk.lots.length) {
      const yw = { grass: new GeometryWriter(), detail: new GeometryWriter(), pool: new GeometryWriter() };
      const dist = (x: number, z: number) => this.world.distanceToStreet(x, z, 40);
      for (const l of chunk.lots) writeYard(yw, l, l.buildingId ? this.world.buildingsById.get(l.buildingId) : undefined, hf, dist);
      if (yw.grass.vertexCount) {
        const m = new THREE.Mesh(yw.grass.toGeometry(), this.areaMaterial);
        m.receiveShadow = true;
        chunk.group.add(m);
      }
      if (yw.detail.vertexCount) {
        const m = new THREE.Mesh(yw.detail.toGeometry(), this.materials.detail);
        // muros baixos: recebem sombra mas não projetam (passe de sombra mais leve)
        m.receiveShadow = true;
        chunk.group.add(m);
      }
      if (yw.pool.vertexCount) chunk.group.add(new THREE.Mesh(yw.pool.toGeometry(), this.poolMaterial));
    }

    // ---- áreas verdes (grama texturizada, tom pelo vertex color)
    const areas = new GeometryWriter();
    for (const g of chunk.greens) {
      const c = new THREE.Color(
        g.kind === 'wood' ? PALETTE.wood : g.kind === 'pitch' ? PALETTE.pitch : g.kind === 'cemetery' ? PALETTE.cemetery : g.kind === 'park' || g.kind === 'garden' ? PALETTE.park : PALETTE.grass,
      );
      writeDrapedPolygon(areas, g.outer, g.holes, hf, c, 0.06);
    }
    if (areas.vertexCount) {
      const m = new THREE.Mesh(areas.toGeometry(), this.areaMaterial);
      m.receiveShadow = true;
      chunk.group.add(m);
    }

    // ---- árvores (InstancedMesh por espécie, por chunk => frustum culling)

  }

  /** Converte um hit de raycast em prédio (via intervalo de vértices da malha). */
  buildingFromHit(hit: THREE.Intersection): Building | undefined {
    const spans = hit.object.userData.spans as Span[] | undefined;
    if (!spans || !hit.face) return undefined;
    const v = hit.face.a;
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
    const ws = createWriters();
    writeBuilding(ws, b, this.world.height, 'high');
    // só posições, expandidas pelos índices (contorno/destaque)
    const pos: number[] = [];
    for (const k of WRITER_KEYS) {
      const w = ws[k];
      for (const i of w.idx) pos.push(w.pos[i * 3], w.pos[i * 3 + 1], w.pos[i * 3 + 2]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return g;
  }

  update(dt: number, camera?: THREE.Camera) {
    worldUniforms.uTime.value += dt;
    if (camera) {
      // relevo das molduras só com a câmera baixa e perto (rua / zoom próximo);
      // na vista aérea o shader já desenha a moldura e o custo seria alto
      const ground = this.world.height.sample(camera.position.x, camera.position.z);
      const low = camera.position.y - ground < 70;
      const lim = this.quality.level === 'high' ? 200 : 140;
      for (const im of this.windowMeshes) im.visible = low && (im.userData.center as THREE.Vector3).distanceTo(camera.position) < lim;
    }
  }
}

/** Água: lâmina reflexiva (IBL) com ondulação animada na normal. */
function createWaterMaterial(extra: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  // low-poly: água turquesa chapada, facetada, levemente brilhante
  if (LOWPOLY) return new THREE.MeshStandardMaterial({ color: '#4aa8c6', roughness: 0.22, metalness: 0, flatShading: !SOFT, ...extra });
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.45, metalness: 0.0, ...extra });
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
float edge = vFlow.w < 0.0 ? smoothstep(0.0, 0.2, min(vFlow.y, 1.0 - vFlow.y)) : 1.0;
// água do rio: margem barrenta, centro verde-azulado escuro
diffuseColor.rgb = mix(vec3(0.2, 0.2, 0.15), vec3(0.05, 0.09, 0.09), edge);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  vec2 p = vec2(along, across * 8.0);
  float t = uTime;
  vec2 g = vec2(
    cos(p.x * 1.3 - t * 1.7) * 0.5 + cos(p.x * 3.1 + p.y * 0.7 - t * 2.6) * 0.3 + cos(vWPos.x * 2.3 + vWPos.z * 1.7 + t * 1.1) * 0.2,
    sin(p.y * 1.1 + t * 1.3) * 0.4 + sin(vWPos.z * 2.9 - vWPos.x * 1.3 - t * 1.9) * 0.25
  ) * 0.12;
  vec3 nW = normalize(vec3(-g.x, 1.0, -g.y));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}`,
      );
  };
  m.customProgramCacheKey = () => 'water-v2';
  return m;
}

/**
 * Moldura de janela unitária (1 x 1, virada para +z): batentes, travessa,
 * montante central, peitoril saliente e cimalha. Escalada por instância
 * para a largura/altura de cada janela.
 */
function windowFrameGeometry(): THREE.BufferGeometry {
  const t = 0.08;
  const pos: number[] = [];
  const nor: number[] = [];
  // quad helper (normal constante)
  const quad = (p: number[][], n: number[]) => {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      pos.push(...p[i]);
      nor.push(...n);
    }
  };
  // caixa aberta atrás (encostada na parede): frente, topo, base, laterais
  const box = (x0: number, x1: number, y0: number, y1: number, z1: number) => {
    const z0 = 0;
    quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]);
    quad([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [0, 1, 0]);
    quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]);
    quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0]);
    quad([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0]);
  };
  box(-0.5, -0.5 + t, -0.5 + t, 0.5 - t, 0.06); // batente esq.
  box(0.5 - t, 0.5, -0.5 + t, 0.5 - t, 0.06); // batente dir.
  box(-0.5, 0.5, 0.5 - t, 0.5, 0.06); // verga
  box(-0.025, 0.025, -0.5 + t, 0.5 - t, 0.035); // montante
  box(-0.6, 0.6, -0.57, -0.5 + t, 0.17); // peitoril (inclui travessa inferior)
  box(-0.57, 0.57, 0.5, 0.57, 0.1); // cimalha
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

function buildWindowMesh(list: WindowInstance[], geo: THREE.BufferGeometry, mat: THREE.Material): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(geo, mat, list.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  list.forEach((w, i) => {
    q.setFromAxisAngle(up, w.yaw);
    p.set(w.x, w.y, w.z);
    sc.set(w.w, w.h, 1);
    m.compose(p, q, sc);
    im.setMatrixAt(i, m);
    im.setColorAt(i, w.color);
  });
  im.castShadow = false;
  im.receiveShadow = true;
  im.computeBoundingSphere();
  return im;
}
