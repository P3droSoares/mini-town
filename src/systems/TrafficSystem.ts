import * as THREE from 'three';
import type { Game, System } from '../core/Game';
import { busGeometry, carGeometry, carLightsGeometry, pedestrianClothesGeometry, pedestrianSkinGeometry } from '../entities/npcGeometry';
import { type GraphEdge, RoadGraph } from '../world/RoadGraph';
import { SIDEWALK_WIDTH } from '../world/render/roadGeometry';
import { mulberry32 } from '../world/geo';
import type { DayNightSystem } from './DayNightSystem';
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
  type: number;
}

const CAR_COLORS = ['#e8e8e8', '#c0392b', '#2c3e50', '#7f8c8d', '#f1c40f', '#2e86c1', '#dfe3e6', '#1e1e1e', '#a04000', '#5d6d7e', '#ffffff', '#943126'];
const BUS_COLORS = ['#f0b429', '#2e7d32', '#1565c0'];
const CLOTHES = ['#c0392b', '#2e86c1', '#27ae60', '#f39c12', '#8e44ad', '#ecf0f1', '#34495e', '#d35400', '#16a085', '#e84393', '#f6e58d'];
const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#a5694f'];

const tmpPos = { x: 0, z: 0, dx: 0, dz: 1 };
const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const up = new THREE.Vector3(0, 1, 0);
const pos = new THREE.Vector3();
const scl = new THREE.Vector3(1, 1, 1);
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Tráfego: carros percorrem o grafo viário (faixa da direita, respeitando
 * mão única) com distância de seguimento; pedestres andam nas calçadas.
 * Quantidade ativa varia com o horário e a densidade do menu.
 */
export class TrafficSystem implements System {
  private cars: Agent[] = [];
  private peds: Agent[] = [];
  private carMeshes: THREE.InstancedMesh[];
  private carLights: THREE.InstancedMesh;
  private pedClothes: THREE.InstancedMesh;
  private pedSkin: THREE.InstancedMesh;
  private driveEdges: GraphEdge[];
  private walkEdges: GraphEdge[];
  private rng = mulberry32(42);
  density = 1;
  private readonly maxCars: number;
  private readonly maxPeds: number;
  private occupancy = new Map<number, Agent[]>();

  constructor(
    private readonly game: Game,
    private readonly time: TimeSystem,
    private readonly dayNight: DayNightSystem,
  ) {
    const g = game.world.graph;
    this.driveEdges = g.edges.filter((e) => e.drivable && e.length > 3);
    this.walkEdges = g.edges.filter((e) => e.length > 3 && e.street.kind !== 'service');
    this.maxCars = game.mobile ? 70 : 150;
    this.maxPeds = game.mobile ? 90 : 200;

    const carMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.15, flatShading: true });
    const types = [carGeometry(), busGeometry()];
    this.carMeshes = types.map((geo) => {
      const im = new THREE.InstancedMesh(geo, carMat, this.maxCars);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = true;
      im.frustumCulled = false;
      for (let i = 0; i < this.maxCars; i++) im.setMatrixAt(i, HIDDEN);
      game.scene.add(im);
      return im;
    });
    this.carLights = new THREE.InstancedMesh(
      carLightsGeometry(),
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      this.maxCars,
    );
    this.carLights.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.carLights.frustumCulled = false;
    game.scene.add(this.carLights);

    const pedMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
    this.pedClothes = new THREE.InstancedMesh(pedestrianClothesGeometry(), pedMat, this.maxPeds);
    this.pedSkin = new THREE.InstancedMesh(pedestrianSkinGeometry(), pedMat, this.maxPeds);
    for (const im of [this.pedClothes, this.pedSkin]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = true;
      im.frustumCulled = false;
      game.scene.add(im);
    }

    // cria os agentes (inativos); cores fixas por índice
    for (let i = 0; i < this.maxCars; i++) {
      const type = this.rng() < 0.05 ? 1 : 0;
      const a = this.newAgent(this.driveEdges, type);
      this.cars.push(a);
      const palette = type === 1 ? BUS_COLORS : CAR_COLORS;
      const c = new THREE.Color(palette[Math.floor(this.rng() * palette.length)]);
      this.carMeshes.forEach((m) => m.setColorAt(i, c));
    }
    for (let i = 0; i < this.maxPeds; i++) {
      this.peds.push(this.newAgent(this.walkEdges, 0));
      this.pedClothes.setColorAt(i, new THREE.Color(CLOTHES[Math.floor(this.rng() * CLOTHES.length)]));
      this.pedSkin.setColorAt(i, new THREE.Color(SKIN[Math.floor(this.rng() * SKIN.length)]));
    }
    for (const m of [...this.carMeshes, this.pedClothes, this.pedSkin]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  private newAgent(edges: GraphEdge[], type: number): Agent {
    return {
      active: false,
      edge: edges[0],
      dist: 0,
      speed: 0,
      maxSpeed: 0,
      lateral: 0,
      yaw: 0,
      x: 0,
      y: 0,
      z: 0,
      phase: this.rng() * 10,
      type,
    };
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
    a.maxSpeed = base * (0.8 + this.rng() * 0.35) * (a.type === 1 ? 0.8 : 1);
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
    const foot = ['footway', 'path', 'steps', 'pedestrian', 'cycleway', 'track'].includes(s.kind);
    a.lateral = foot ? (this.rng() - 0.5) * s.width * 0.6 : (s.width / 2 + SIDEWALK_WIDTH * (0.3 + this.rng() * 0.4)) * (this.rng() < 0.5 ? 1 : -1);
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
    a.y = this.game.world.height.sample(a.x, a.z) + 0.05;
    const yaw = Math.atan2(tmpPos.dx, tmpPos.dz);
    if (snap) a.yaw = yaw;
    else {
      const d = Math.atan2(Math.sin(yaw - a.yaw), Math.cos(yaw - a.yaw));
      a.yaw += d * Math.min(1, dt * 8);
    }
  }

  private placePed(a: Agent, dt: number, snap = false) {
    RoadGraph.pointAt(a.edge, a.dist, tmpPos);
    a.x = tmpPos.x - tmpPos.dz * a.lateral;
    a.z = tmpPos.z + tmpPos.dx * a.lateral;
    a.y = this.game.world.height.sample(a.x, a.z) + 0.1;
    const yaw = Math.atan2(tmpPos.dx, tmpPos.dz);
    if (snap) a.yaw = yaw;
    else a.yaw += Math.atan2(Math.sin(yaw - a.yaw), Math.cos(yaw - a.yaw)) * Math.min(1, dt * 6);
  }

  update(dt: number) {
    const act = this.activity() * this.density;
    const night = this.dayNight.night;
    const wantCars = Math.round(this.maxCars * act);
    const wantPeds = Math.round(this.maxPeds * act * (1 - night * 0.6));
    const f = this.game.focus;
    const recycle2 = 800 * 800;

    // ---- carros
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
          this.hideCar(i);
          continue;
        }
      }
      // desliga excedentes (fora da vista, quando possível)
      if (i >= wantCars && (a.x - f.x) ** 2 + (a.z - f.z) ** 2 > 250 * 250) {
        a.active = false;
        this.hideCar(i);
        continue;
      }
      activeCars++;
      // distância até o carro da frente na mesma aresta
      let gap = Infinity;
      for (const o of this.occupancy.get(a.edge.id) ?? []) if (o !== a && o.dist > a.dist) gap = Math.min(gap, o.dist - a.dist);
      // perto do fim da aresta, olha a próxima (aprox.)
      const len = a.type === 1 ? 11 : 5;
      const target = gap < len + 3 ? 0 : gap < len + 12 ? a.maxSpeed * ((gap - len - 3) / 9) : a.maxSpeed;
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
        this.hideCar(i);
        continue;
      }
      q.setFromAxisAngle(up, a.yaw);
      pos.set(a.x, a.y, a.z);
      m4.compose(pos, q, scl);
      this.carMeshes[a.type].setMatrixAt(i, m4);
      this.carMeshes[1 - a.type].setMatrixAt(i, HIDDEN);
      this.carLights.setMatrixAt(i, a.type === 0 ? m4 : HIDDEN);
    }
    this.carMeshes.forEach((m) => (m.instanceMatrix.needsUpdate = true));
    this.carLights.instanceMatrix.needsUpdate = true;
    this.carLights.visible = night > 0.3;

    // ---- pedestres
    for (let i = 0; i < this.peds.length; i++) {
      const a = this.peds[i];
      if (!a.active) {
        if (i < wantPeds && this.rng() < 0.06) this.spawnPed(a);
        if (!a.active) {
          this.hidePed(i);
          continue;
        }
      }
      if (i >= wantPeds && (a.x - f.x) ** 2 + (a.z - f.z) ** 2 > 200 * 200) {
        a.active = false;
        this.hidePed(i);
        continue;
      }
      a.dist += a.speed * dt;
      let guard = 0;
      while (a.dist > a.edge.length && guard++ < 5) {
        a.dist -= a.edge.length;
        const prevFoot = a.lateral;
        a.edge = this.rng() < 0.12 && a.edge.reverse ? a.edge.reverse : this.nextEdge(a.edge, false);
        const s = a.edge.street;
        const foot = ['footway', 'path', 'steps', 'pedestrian', 'cycleway', 'track'].includes(s.kind);
        // mantém o lado da calçada
        const side = Math.sign(prevFoot) || 1;
        a.lateral = foot ? (this.rng() - 0.5) * s.width * 0.6 : (s.width / 2 + SIDEWALK_WIDTH * 0.5) * side;
      }
      this.placePed(a, dt);
      if ((a.x - f.x) ** 2 + (a.z - f.z) ** 2 > recycle2) {
        a.active = false;
        this.hidePed(i);
        continue;
      }
      a.phase += dt * a.speed * 5.5;
      q.setFromAxisAngle(up, a.yaw + Math.sin(a.phase) * 0.06);
      pos.set(a.x, a.y + Math.abs(Math.sin(a.phase)) * 0.05, a.z);
      m4.compose(pos, q, scl);
      this.pedClothes.setMatrixAt(i, m4);
      this.pedSkin.setMatrixAt(i, m4);
    }
    this.pedClothes.instanceMatrix.needsUpdate = true;
    this.pedSkin.instanceMatrix.needsUpdate = true;
    this.stats.cars = activeCars;
  }

  readonly stats = { cars: 0 };

  private hidePed(i: number) {
    this.pedClothes.setMatrixAt(i, HIDDEN);
    this.pedSkin.setMatrixAt(i, HIDDEN);
  }

  private hideCar(i: number) {
    this.carMeshes[0].setMatrixAt(i, HIDDEN);
    this.carMeshes[1].setMatrixAt(i, HIDDEN);
    this.carLights.setMatrixAt(i, HIDDEN);
  }
}
