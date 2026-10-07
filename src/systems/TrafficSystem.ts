import * as THREE from 'three';
import type { Game, System } from '../core/Game';
import { type VehicleModel, createPedestrianMaterial, pedestrianGeometry, vehicleModels } from '../entities/npcGeometry';
import { type GraphEdge, RoadGraph } from '../world/RoadGraph';
import { SIDEWALK_WIDTH } from '../world/render/roadGeometry';
import { mulberry32 } from '../world/geo';
import type { DayNightSystem } from './DayNightSystem';
import { MONO, MONO_LIGHT } from '../world/render/style';
import type { TimeSystem } from './TimeSystem';

/** Agente NPC (estado puro; a renderização só lê). */
interface Agent {
  active: boolean;
  edge: GraphEdge;
  dist: number;
  speed: number;
  maxSpeed: number;
  /** deslocamento lateral (direita +) */
  lateral: number;
  yaw: number;
  x: number;
  y: number;
  z: number;
  phase: number;
  /** modelo de veículo e posição (slot) dentro das instâncias desse modelo */
  model: number;
  slot: number;
  /** cor da carroceria (carros) */
  color: THREE.Color;
  /** pele, camisa, calça, fase/frequência do passo (pedestres) */
  looks: Float32Array;
}

// frota brasileira: muito branco, prata, cinza e preto
const CAR_COLORS = ['#f2f2f0', '#f2f2f0', '#f2f2f0', '#b8bcc0', '#b8bcc0', '#6f7478', '#1c1d20', '#1c1d20', '#9b1c1c', '#1f3b6e', '#c9b48a', '#2f5d3a'];
const BUS_COLORS = ['#f0b429', '#1f6f3a', '#1565c0', '#d9d9d9'];
const SHIRTS = ['#c0392b', '#2e86c1', '#27ae60', '#f39c12', '#8e44ad', '#ecf0f1', '#34495e', '#d35400', '#16a085', '#e84393', '#f6e58d', '#1b1b1b', '#ffffff'];
const PANTS = ['#2c3e50', '#1f2a44', '#3b3b3b', '#5d4e37', '#7f8c8d', '#1b1b1b', '#3d5a80'];
const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#a5694f', '#6b4226'];

const tmpPos = { x: 0, z: 0, dx: 0, dz: 1 };
const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const up = new THREE.Vector3(0, 1, 0);
const pos = new THREE.Vector3();
const scl = new THREE.Vector3(1, 1, 1);
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const FOOT = ['footway', 'path', 'steps', 'pedestrian', 'cycleway', 'track'];

interface ModelMeshes {
  model: VehicleModel;
  meshes: THREE.InstancedMesh[];
  glow: THREE.InstancedMesh;
}

/**
 * Tráfego: carros percorrem o grafo viário (faixa da direita, respeitando
 * mão única) com distância de seguimento; pedestres andam nas calçadas.
 * Quantidade ativa varia com o horário e a densidade do menu.
 */
export class TrafficSystem implements System {
  private cars: Agent[] = [];
  private peds: Agent[] = [];
  private models: ModelMeshes[] = [];
  private pedMesh: THREE.InstancedMesh;
  private pedAttrs: THREE.InstancedBufferAttribute[] = [];
  private packed: number[] = [];
  private driveEdges: GraphEdge[];
  private walkEdges: GraphEdge[];
  private rng = mulberry32(42);
  density = 1;
  private readonly maxCars: number;
  private readonly maxPeds: number;
  private occupancy = new Map<number, Agent[]>();
  readonly stats = { cars: 0 };
  private boundsAcc = 1;

  constructor(
    private readonly game: Game,
    private readonly time: TimeSystem,
    private readonly dayNight: DayNightSystem,
  ) {
    const g = game.world.graph;
    this.driveEdges = g.edges.filter((e) => e.drivable && e.length > 3);
    this.walkEdges = g.edges.filter((e) => e.length > 3 && e.street.kind !== 'service');
    const scale = game.quality.npcScale;
    this.maxCars = Math.round(150 * scale);
    this.maxPeds = Math.round(220 * scale);

    // ---- veículos: sorteia o modelo de cada agente pelo peso na frota
    const models = vehicleModels();
    const totalW = models.reduce((s, m) => s + m.weight, 0);
    const slotsPer = models.map(() => 0);
    for (let i = 0; i < this.maxCars; i++) {
      let r = this.rng() * totalW;
      let mi = 0;
      while (r > models[mi].weight && mi < models.length - 1) r -= models[mi++].weight;
      const a = this.newAgent(this.driveEdges);
      a.model = mi;
      a.slot = slotsPer[mi]++;
      this.cars.push(a);
    }
    const paintMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.45 });
    const glassMat = new THREE.MeshStandardMaterial({ color: '#0e1418', roughness: 0.05, metalness: 0.85 });
    const trimMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.2 });
    // monocromático: faróis e lanternas no mesmo amarelo das luzes
    const glowMat = new THREE.MeshBasicMaterial({ vertexColors: !MONO, color: MONO ? MONO_LIGHT : '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    models.forEach((model, mi) => {
      const n = Math.max(1, slotsPer[mi]);
      const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, shadow: boolean) => {
        const im = new THREE.InstancedMesh(geo, mat, n);
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.castShadow = shadow;
        im.receiveShadow = shadow;
        for (let i = 0; i < n; i++) im.setMatrixAt(i, HIDDEN);
        game.scene.add(im);
        return im;
      };
      const paintMesh = mk(model.paint, paintMat, true);
      const palette = model.bus ? BUS_COLORS : CAR_COLORS;
      for (const a of this.cars) if (a.model === mi) a.color.set(palette[Math.floor(this.rng() * palette.length)]);
      paintMesh.setColorAt(0, new THREE.Color());
      this.models.push({ model, meshes: [paintMesh, mk(model.glass, glassMat, false), mk(model.trim, trimMat, true)], glow: mk(model.glow, glowMat, false) });
    });

    // ---- carros estacionados junto ao meio-fio (estáticos, instanciados)
    this.buildParked(models, paintMat, glassMat, trimMat);

    // ---- pedestres: 1 InstancedMesh, cores e animação por instância no shader
    this.pedMesh = new THREE.InstancedMesh(pedestrianGeometry(), createPedestrianMaterial(), this.maxPeds);
    this.pedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pedMesh.castShadow = true;
    const pick = (arr: string[]) => new THREE.Color(arr[Math.floor(this.rng() * arr.length)]);
    const skin = new Float32Array(this.maxPeds * 3);
    const shirt = new Float32Array(this.maxPeds * 3);
    const pants = new Float32Array(this.maxPeds * 3);
    const walk = new Float32Array(this.maxPeds * 3);
    for (let i = 0; i < this.maxPeds; i++) {
      const a = this.newAgent(this.walkEdges);
      pick(SKIN).toArray(a.looks, 0);
      pick(SHIRTS).toArray(a.looks, 3);
      pick(PANTS).toArray(a.looks, 6);
      a.looks.set([this.rng() * 6.28, 6.5 + this.rng() * 1.5, 1], 9);
      this.peds.push(a);
    }
    this.pedMesh.count = 0;
    const geo = this.pedMesh.geometry;
    this.pedAttrs = ['aSkin', 'aShirt', 'aPants', 'aWalk'].map((k, i) => {
      const attr = new THREE.InstancedBufferAttribute([skin, shirt, pants, walk][i], 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(k, attr);
      return attr;
    });
    game.scene.add(this.pedMesh);
  }

  /** carros parados nas ruas residenciais (só visual: dão vida à vista aérea) */
  private buildParked(models: VehicleModel[], paintMat: THREE.Material, glassMat: THREE.Material, trimMat: THREE.Material) {
    const world = this.game.world;
    const rng = mulberry32(777);
    const spots: { x: number; y: number; z: number; yaw: number; m: number }[] = [];
    const max = Math.round(700 * this.game.quality.npcScale);
    for (const s of world.data.streets) {
      if (!['residential', 'tertiary', 'secondary', 'living_street', 'unclassified'].includes(s.kind) || s.width < 6) continue;
      for (let i = 0; i < s.points.length - 1 && spots.length < max; i++) {
        const [ax, az] = s.points[i];
        const [bx, bz] = s.points[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 20) continue;
        const ux = (bx - ax) / len;
        const uz = (bz - az) / len;
        for (let t = 10; t < len - 10; t += 6.5) {
          if (rng() > 0.3) continue;
          const side = rng() < 0.5 ? 1 : -1;
          const off = s.width / 2 - 1.05;
          const x = ax + ux * t - uz * off * side;
          const z = az + uz * t + ux * off * side;
          if (!world.isInsideBounds(x, z, -20)) continue;
          // mão de direção do lado em que está estacionado
          const yaw = Math.atan2(ux * side, uz * side);
          spots.push({ x, y: world.height.sample(x, z) + 0.06, z, yaw, m: rng() < 0.45 ? 0 : rng() < 0.6 ? 1 : rng() < 0.7 ? 2 : 3 });
        }
      }
    }
    const m4p = new THREE.Matrix4();
    const qq = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    for (let mi = 0; mi < 4; mi++) {
      const list = spots.filter((p) => p.m === mi);
      if (!list.length) continue;
      const parts: [THREE.BufferGeometry, THREE.Material][] = [
        [models[mi].paint, paintMat],
        [models[mi].glass, glassMat],
        [models[mi].trim, trimMat],
      ];
      for (const [geo, mat] of parts) {
        const im = new THREE.InstancedMesh(geo, mat, list.length);
        list.forEach((p, i) => {
          qq.setFromAxisAngle(up, p.yaw);
          m4p.compose(new THREE.Vector3(p.x, p.y, p.z), qq, one);
          im.setMatrixAt(i, m4p);
          if (mat === paintMat) im.setColorAt(i, new THREE.Color(CAR_COLORS[Math.floor(rng() * CAR_COLORS.length)]));
        });
        im.castShadow = mat !== glassMat;
        im.receiveShadow = true;
        im.computeBoundingSphere();
        this.game.scene.add(im);
      }
    }
  }

  private newAgent(edges: GraphEdge[]): Agent {
    return { active: false, edge: edges[0], dist: 0, speed: 0, maxSpeed: 0, lateral: 0, yaw: 0, x: 0, y: 0, z: 0, phase: this.rng() * 10, model: 0, slot: 0, color: new THREE.Color(), looks: new Float32Array(12) };
  }

  /** atividade por hora (0..1): madrugada vazia, picos 7–9h e 17–19h */
  private activity(): number {
    const h = this.time.hours();
    const bump = (c: number, w: number) => Math.exp(-((h - c) ** 2) / (2 * w * w));
    const base = h < 5 ? 0.08 : h < 6.5 ? 0.25 : h < 21 ? 0.7 : h < 23 ? 0.4 : 0.18;
    return Math.min(1, base + 0.3 * bump(8, 1) + 0.3 * bump(18, 1.2) + 0.15 * bump(12.5, 1));
  }

  /** escolhe aresta próxima ao foco (spawn perto do jogador/câmera) */
  private pickEdgeNear(edges: GraphEdge[], radius: number): GraphEdge {
    const f = this.game.focus;
    for (let tries = 0; tries < 30; tries++) {
      const e = edges[Math.floor(this.rng() * edges.length)];
      const dx = e.from.x - f.x;
      const dz = e.from.z - f.z;
      if (dx * dx + dz * dz < radius * radius) return e;
    }
    return edges[Math.floor(this.rng() * edges.length)];
  }

  private spawnCar(a: Agent) {
    a.edge = this.pickEdgeNear(this.driveEdges, 650);
    a.dist = this.rng() * a.edge.length;
    const kind = a.edge.street.kind;
    const base = kind === 'primary' || kind === 'secondary' ? 13 : kind === 'tertiary' ? 11 : 8.5;
    const heavy = this.models[a.model].model.length > 6;
    a.maxSpeed = base * (0.8 + this.rng() * 0.35) * (heavy ? 0.8 : 1);
    a.speed = a.maxSpeed * 0.5;
    a.active = true;
    this.placeCar(a, 0, true);
  }

  private spawnPed(a: Agent) {
    a.edge = this.pickEdgeNear(this.walkEdges, 450);
    a.dist = this.rng() * a.edge.length;
    a.maxSpeed = 1.1 + this.rng() * 0.6;
    a.speed = a.maxSpeed;
    const s = a.edge.street;
    a.lateral = FOOT.includes(s.kind) ? (this.rng() - 0.5) * s.width * 0.6 : (s.width / 2 + SIDEWALK_WIDTH * (0.3 + this.rng() * 0.4)) * (this.rng() < 0.5 ? 1 : -1);
    a.active = true;
    this.placePed(a, 0, true);
  }

  private nextEdge(e: GraphEdge, drivable: boolean): GraphEdge {
    const options = e.to.out.filter((o) => (drivable ? o.drivable : true) && o !== e.reverse && o.length > 1);
    if (!options.length) return e.reverse ?? e;
    return options[Math.floor(this.rng() * options.length)];
  }

  private laneOffset(e: GraphEdge): number {
    const s = e.street;
    return s.oneway ? 0 : Math.min(s.width / 4, 1.8);
  }

  private placeCar(a: Agent, dt: number, snap = false) {
    RoadGraph.pointAt(a.edge, a.dist, tmpPos);
    const off = this.laneOffset(a.edge);
    // direita da direção (dx, dz) = (-dz, dx)
    a.x = tmpPos.x - tmpPos.dz * off;
    a.z = tmpPos.z + tmpPos.dx * off;
    a.y = this.game.world.height.sample(a.x, a.z) + 0.06;
    const yaw = Math.atan2(tmpPos.dx, tmpPos.dz);
    if (snap) a.yaw = yaw;
    else a.yaw += Math.atan2(Math.sin(yaw - a.yaw), Math.cos(yaw - a.yaw)) * Math.min(1, dt * 8);
  }

  private placePed(a: Agent, dt: number, snap = false) {
    RoadGraph.pointAt(a.edge, a.dist, tmpPos);
    a.x = tmpPos.x - tmpPos.dz * a.lateral;
    a.z = tmpPos.z + tmpPos.dx * a.lateral;
    const foot = FOOT.includes(a.edge.street.kind);
    a.y = this.game.world.height.sample(a.x, a.z) + (foot ? 0.12 : 0.22);
    const yaw = Math.atan2(tmpPos.dx, tmpPos.dz);
    if (snap) a.yaw = yaw;
    else a.yaw += Math.atan2(Math.sin(yaw - a.yaw), Math.cos(yaw - a.yaw)) * Math.min(1, dt * 6);
  }

  /** grava o carro na próxima instância livre do modelo (só ativos são desenhados) */
  private setCar(a: Agent, m: THREE.Matrix4 | null) {
    if (!m) return;
    const mm = this.models[a.model];
    const idx = this.packed[a.model]++;
    for (const im of mm.meshes) im.setMatrixAt(idx, m);
    mm.meshes[0].setColorAt(idx, a.color);
    mm.glow.setMatrixAt(idx, m);
  }

  update(dt: number) {
    const act = this.activity() * this.density;
    const night = this.dayNight.night;
    const wantCars = Math.round(this.maxCars * act);
    const wantPeds = Math.round(this.maxPeds * act * (1 - night * 0.6));
    const f = this.game.focus;
    const recycle2 = 800 * 800;

    // ---- carros
    this.packed = this.models.map(() => 0);
    this.occupancy.clear();
    for (const a of this.cars) {
      if (!a.active) continue;
      let list = this.occupancy.get(a.edge.id);
      if (!list) this.occupancy.set(a.edge.id, (list = []));
      list.push(a);
    }
    let activeCars = 0;
    for (let i = 0; i < this.cars.length; i++) {
      const a = this.cars[i];
      if (!a.active) {
        if (i < wantCars && this.rng() < 0.08) this.spawnCar(a);
        if (!a.active) {
          this.setCar(a, null);
          continue;
        }
      }
      if (i >= wantCars && (a.x - f.x) ** 2 + (a.z - f.z) ** 2 > 250 * 250) {
        a.active = false;
        this.setCar(a, null);
        continue;
      }
      activeCars++;
      let gap = Infinity;
      for (const o of this.occupancy.get(a.edge.id) ?? []) if (o !== a && o.dist > a.dist) gap = Math.min(gap, o.dist - a.dist);
      const len = this.models[a.model].model.length + 1.5;
      const target = gap < len + 2 ? 0 : gap < len + 12 ? a.maxSpeed * ((gap - len - 2) / 10) : a.maxSpeed;
      a.speed += (target - a.speed) * Math.min(1, dt * (target < a.speed ? 6 : 1.5));
      a.dist += a.speed * dt;
      let guard = 0;
      while (a.dist > a.edge.length && guard++ < 5) {
        a.dist -= a.edge.length;
        a.edge = this.nextEdge(a.edge, true);
        a.speed *= 0.7; // reduz na esquina
      }
      this.placeCar(a, dt);
      if ((a.x - f.x) ** 2 + (a.z - f.z) ** 2 > recycle2) {
        a.active = false;
        this.setCar(a, null);
        continue;
      }
      q.setFromAxisAngle(up, a.yaw);
      pos.set(a.x, a.y, a.z);
      m4.compose(pos, q, scl);
      this.setCar(a, m4);
    }
    this.models.forEach((mm, mi) => {
      for (const im of mm.meshes) {
        im.count = this.packed[mi];
        im.instanceMatrix.needsUpdate = true;
      }
      if (mm.meshes[0].instanceColor) mm.meshes[0].instanceColor.needsUpdate = true;
      mm.glow.count = this.packed[mi];
      mm.glow.instanceMatrix.needsUpdate = true;
      mm.glow.visible = night > 0.3;
    });

    // ---- pedestres (empacotados: só ativos)
    let np = 0;
    for (let i = 0; i < this.peds.length; i++) {
      const a = this.peds[i];
      if (!a.active) {
        if (i < wantPeds && this.rng() < 0.06) this.spawnPed(a);
        if (!a.active) {
          continue;
        }
      }
      if (i >= wantPeds && (a.x - f.x) ** 2 + (a.z - f.z) ** 2 > 200 * 200) {
        a.active = false;
        continue;
      }
      a.dist += a.speed * dt;
      let guard = 0;
      while (a.dist > a.edge.length && guard++ < 5) {
        a.dist -= a.edge.length;
        const side = Math.sign(a.lateral) || 1;
        a.edge = this.rng() < 0.12 && a.edge.reverse ? a.edge.reverse : this.nextEdge(a.edge, false);
        const s = a.edge.street;
        a.lateral = FOOT.includes(s.kind) ? (this.rng() - 0.5) * s.width * 0.6 : (s.width / 2 + SIDEWALK_WIDTH * 0.5) * side;
      }
      this.placePed(a, dt);
      if ((a.x - f.x) ** 2 + (a.z - f.z) ** 2 > recycle2) {
        a.active = false;
        continue;
      }
      a.phase += dt * a.speed * 5.5;
      q.setFromAxisAngle(up, a.yaw);
      pos.set(a.x, a.y + Math.abs(Math.sin(a.phase)) * 0.03, a.z);
      m4.compose(pos, q, scl);
      this.pedMesh.setMatrixAt(np, m4);
      for (let k = 0; k < 4; k++) (this.pedAttrs[k].array as Float32Array).set(a.looks.subarray(k * 3, k * 3 + 3), np * 3);
      np++;
    }
    this.pedMesh.count = np;
    this.pedMesh.instanceMatrix.needsUpdate = true;
    for (const at of this.pedAttrs) at.needsUpdate = true;
    // culling por frustum com esfera envolvente atualizada 2x/s (instâncias se movem)
    this.boundsAcc += dt;
    if (this.boundsAcc > 0.5) {
      this.boundsAcc = 0;
      for (const mm of this.models) for (const im of [...mm.meshes, mm.glow]) im.computeBoundingSphere();
      this.pedMesh.computeBoundingSphere();
      for (const im of [...this.models.flatMap((m) => [...m.meshes, m.glow]), this.pedMesh]) if (im.boundingSphere) im.boundingSphere.radius += 30;
    }
    this.stats.cars = activeCars;
  }
}
