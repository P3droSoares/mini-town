import * as THREE from 'three';
import type { VehicleKind } from '../economy/catalog';
import type { WorldState } from '../world/WorldState';
import { distSqToSegment } from '../world/geo';
import { createPedestrianDepthMaterial, createPedestrianMaterial, pedestrianGeometry } from './npcGeometry';
import { type RideModel, VEHICLES, type VehicleSpec, buildBag, buildRideModel } from './vehicles';

const RADIUS = 0.35;
const WALK = 4.2;
const RUN = 9.5;

/** Estado do jogador (puro) — no multiplayer será sincronizado com o servidor. */
export interface PlayerState {
  x: number;
  z: number;
  y: number;
  heading: number;
  /** m/s (negativo = de ré) */
  speed: number;
  /** veículo em uso (null = a pé) */
  vehicle: VehicleKind | null;
}

/** Obstáculo móvel (carro): centro, rumo e meias dimensões. */
export interface Obstacle {
  x: number;
  z: number;
  yaw: number;
  /** meia largura e meio comprimento */
  hw: number;
  hl: number;
}

interface Parked {
  kind: VehicleKind;
  x: number;
  z: number;
  heading: number;
}

const tmp = { x: 0, z: 0 };

/**
 * Personagem a pé ou montado (bicicleta/moto): boneco low-poly com animação
 * procedural, colisão 2D contra footprints dos prédios (e carros) e altura
 * pelo relevo.
 */
export class Player {
  readonly state: PlayerState = { x: 0, z: 0, y: 0, heading: 0, speed: 0, vehicle: null };
  readonly mesh = new THREE.Group();
  /** veículo estacionado (na cena mesmo com a câmera de cidade) */
  readonly parked = new THREE.Group();
  /** carros próximos (preenchido pelo tráfego) */
  obstacles: ((x: number, z: number, r: number) => Obstacle[]) | null = null;
  readonly onRideChange: ((v: VehicleKind | null) => void)[] = [];
  private body: THREE.InstancedMesh;
  private walkAttr: THREE.InstancedBufferAttribute;
  private poseAttr: THREE.InstancedBufferAttribute;
  private ring: THREE.Mesh;
  private bag: THREE.Group;
  /** inclinação do conjunto (ladeira e curva) */
  private tilt = new THREE.Group();
  /** quadril do boneco (assento) */
  private seat = new THREE.Group();
  private figure = new THREE.Group();
  private models = new Map<VehicleKind, RideModel>();
  private parkedModels = new Map<VehicleKind, RideModel>();
  private parkedAt: Parked | null = null;
  private phase = 0;
  private steer = 0;
  private lean = 0;
  private pitch = 0;
  private crank = 0;
  private pedaling = false;
  /** batida (0..1) — para a câmera tremer */
  bump = 0;

  constructor(private readonly world: WorldState) {
    // mesmo modelo anatômico dos pedestres (animação de membros na GPU) + pose de piloto
    this.body = new THREE.InstancedMesh(pedestrianGeometry(), createPedestrianMaterial(true), 1);
    this.body.customDepthMaterial = createPedestrianDepthMaterial(true);
    this.body.setMatrixAt(0, new THREE.Matrix4());
    const geo = this.body.geometry;
    const attr = (k: string, v: number[]) => geo.setAttribute(k, new THREE.InstancedBufferAttribute(new Float32Array(v), 3));
    attr('aSkin', new THREE.Color('#d9a27a').toArray());
    attr('aShirt', new THREE.Color('#c2633a').toArray());
    attr('aPants', new THREE.Color('#34495e').toArray());
    this.walkAttr = new THREE.InstancedBufferAttribute(new Float32Array([0, 7, 0]), 3);
    this.poseAttr = new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 1, 1]), 4);
    geo.setAttribute('aWalk', this.walkAttr);
    geo.setAttribute('aPose', this.poseAttr);
    this.body.castShadow = true;
    this.body.frustumCulled = false;
    this.bag = buildBag();
    this.bag.visible = false;
    // quadril no pivô do assento: o tronco inclina em torno dele
    this.figure.position.y = -0.93;
    this.figure.add(this.body, this.bag);
    this.seat.position.y = 0.93;
    this.seat.add(this.figure);
    this.tilt.add(this.seat);
    // marcador no chão (ajuda a achar o boneco de longe)
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.45, 0.6, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthWrite: false }),
    );
    this.ring.position.y = 0.06;
    this.mesh.add(this.tilt, this.ring);
    this.mesh.visible = false;
  }

  /** veículo em uso (null = a pé) */
  get riding(): VehicleSpec | null {
    return this.state.vehicle ? VEHICLES[this.state.vehicle] : null;
  }

  set bagVisible(v: boolean) {
    this.bag.visible = v;
  }

  /** posiciona num ponto livre próximo de (x, z) */
  spawn(x: number, z: number) {
    const p = this.findFree(x, z);
    this.state.x = p.x;
    this.state.z = p.z;
    this.state.y = this.world.height.sample(p.x, p.z);
    this.state.speed = 0;
    this.syncMesh();
  }

  private findFree(x: number, z: number) {
    // prefere a calçada da rua mais próxima (lugar aberto, câmera livre)
    let best: { x: number; z: number } | null = null;
    let bestD = 150 * 150;
    for (const s of this.world.data.streets) {
      if (['footway', 'path', 'steps', 'track'].includes(s.kind)) continue;
      for (let i = 0; i < s.points.length - 1; i++) {
        const [ax, az] = s.points[i];
        const [bx, bz] = s.points[i + 1];
        const r = distSqToSegment(x, z, ax, az, bx, bz);
        if (r.d2 < bestD) {
          const len = Math.hypot(bx - ax, bz - az) || 1;
          const off = s.width / 2 + 0.9;
          // lado da calçada voltado para o ponto pedido
          const side = Math.sign((bx - ax) * (z - az) - (bz - az) * (x - ax)) || 1;
          const px = r.cx + (-(bz - az) / len) * off * side;
          const pz = r.cz + ((bx - ax) / len) * off * side;
          if (!this.world.buildingAt(px, pz)) {
            bestD = r.d2;
            best = { x: px, z: pz };
          }
        }
      }
    }
    if (best) return best;
    return this.nearestOpen(x, z);
  }

  /** ponto fora de prédios mais próximo de (x, z) */
  private nearestOpen(x: number, z: number) {
    if (!this.world.buildingAt(x, z)) return { x, z };
    for (let r = 2; r < 80; r += 2)
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        if (!this.world.buildingAt(px, pz)) return { x: px, z: pz };
      }
    return { x, z };
  }

  // ---------------------------------------------------------------- veículo

  /** distância até o veículo estacionado (Infinity se não há) */
  parkedDistance(): number {
    const p = this.parkedAt;
    return p ? Math.hypot(p.x - this.state.x, p.z - this.state.z) : Infinity;
  }

  get parkedKind(): VehicleKind | null {
    return this.parkedAt?.kind ?? null;
  }

  /** sobe no veículo: o estacionado se estiver perto, senão ele "vem" até o jogador */
  mount(kind: VehicleKind) {
    const s = this.state;
    if (s.vehicle === kind) return;
    const p = this.parkedAt;
    if (p && p.kind === kind && this.parkedDistance() < 8) {
      s.x = p.x;
      s.z = p.z;
      s.heading = p.heading;
    }
    this.clearParked();
    if (s.vehicle) this.model(s.vehicle).root.visible = false;
    s.vehicle = kind;
    s.speed = 0;
    this.steer = this.lean = 0;
    const m = this.model(kind);
    m.root.visible = true;
    const v = VEHICLES[kind];
    this.seat.position.set(0, v.seat.y, v.seat.z);
    this.seat.rotation.x = v.seat.lean;
    this.ring.visible = false;
    this.figure.position.y = -0.93;
    this.syncMesh();
    this.onRideChange.forEach((f) => f(kind));
  }

  /** desce e deixa o veículo estacionado ao lado */
  dismount() {
    const s = this.state;
    const kind = s.vehicle;
    if (!kind) return;
    this.model(kind).root.visible = false;
    this.parkedAt = { kind, x: s.x, z: s.z, heading: s.heading };
    const pm = this.parkedModel(kind);
    pm.root.visible = true;
    pm.root.position.set(s.x, this.world.height.sample(s.x, s.z), s.z);
    pm.root.rotation.set(0, s.heading, 0);
    pm.front.rotation.y = 0.35;
    // a pé, à esquerda do veículo
    const p = this.nearestOpen(s.x + Math.cos(s.heading) * 0.9, s.z - Math.sin(s.heading) * 0.9);
    s.x = p.x;
    s.z = p.z;
    s.vehicle = null;
    s.speed = 0;
    this.tilt.rotation.set(0, 0, 0);
    this.seat.position.set(0, 0.93, 0);
    this.seat.rotation.x = 0;
    this.ring.visible = true;
    this.poseAttr.set([0, 0, 1, 1]);
    this.poseAttr.needsUpdate = true;
    this.syncMesh();
    this.onRideChange.forEach((f) => f(null));
  }

  /** recolhe o veículo estacionado (ex.: trocou de veículo no app) */
  clearParked() {
    if (!this.parkedAt) return;
    this.parkedModel(this.parkedAt.kind).root.visible = false;
    this.parkedAt = null;
  }

  private model(kind: VehicleKind): RideModel {
    let m = this.models.get(kind);
    if (!m) {
      m = buildRideModel(kind);
      m.root.visible = false;
      this.models.set(kind, m);
      this.tilt.add(m.root);
    }
    return m;
  }

  private parkedModel(kind: VehicleKind): RideModel {
    let m = this.parkedModels.get(kind);
    if (!m) {
      m = buildRideModel(kind);
      for (const g of m.glow) g.visible = false;
      this.parkedModels.set(kind, m);
      this.parked.add(m.root);
    }
    return m;
  }

  /** farol aceso (noite) */
  setLights(on: boolean) {
    for (const m of this.models.values()) for (const g of m.glow) g.visible = on;
  }

  // ---------------------------------------------------------------- movimento

  /**
   * @param move entrada (x = direita, y = frente); a pé é relativa à câmera,
   *   montado vira acelerador (y) e direção (x)
   * @param yaw yaw da câmera
   * @param brake freio de mão (montado)
   */
  update(dt: number, move: { x: number; y: number }, run: boolean, yaw: number, brake = false) {
    this.bump = Math.max(0, this.bump - dt * 3);
    if (this.state.vehicle) this.ride(dt, move.y, move.x, run, brake);
    else this.walk(dt, move, run, yaw);
    // limites do terreno jogável (bateu na borda: para)
    const s = this.state;
    const b = this.world.data.bounds;
    const m = 300;
    const cx = THREE.MathUtils.clamp(s.x, b.minX - m, b.maxX + m);
    const cz = THREE.MathUtils.clamp(s.z, b.minZ - m, b.maxZ + m);
    if (cx !== s.x || cz !== s.z) s.speed = 0;
    s.x = cx;
    s.z = cz;
    const gy = this.world.height.sample(s.x, s.z);
    s.y += (gy - s.y) * Math.min(1, dt * 18);
    this.syncMesh();
  }

  private walk(dt: number, move: { x: number; y: number }, run: boolean, yaw: number) {
    const s = this.state;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    let dx = fx * move.y + rx * move.x;
    let dz = fz * move.y + rz * move.x;
    const mag = Math.min(1, Math.hypot(dx, dz));
    const target = mag * (run ? RUN : WALK);
    s.speed += (target - s.speed) * Math.min(1, dt * 10);
    if (mag > 0.01) {
      const l = Math.hypot(dx, dz);
      dx /= l;
      dz /= l;
      const want = Math.atan2(dx, dz);
      let diff = want - s.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      s.heading += diff * Math.min(1, dt * 12);
    }
    const step = s.speed * dt;
    // subpassos evitam atravessar paredes finas em velocidade alta
    const n = Math.max(1, Math.ceil(step / 0.25));
    for (let i = 0; i < n; i++) {
      s.x += Math.sin(s.heading) * (step / n);
      s.z += Math.cos(s.heading) * (step / n);
      tmp.x = s.x;
      tmp.z = s.z;
      this.pushOut(tmp, RADIUS);
      s.x = tmp.x;
      s.z = tmp.z;
    }

    // animação de caminhada (amplitude/frequência pelo ritmo)
    const k = s.speed / WALK;
    this.phase += dt * (4 + s.speed * 1.6) * (k > 0.05 ? 1 : 0);
    this.walkAttr.setXYZ(0, 0, s.speed > 6 ? 10 : 7, Math.min(1, k) * (s.speed > 6 ? 1.3 : 1));
    this.walkAttr.needsUpdate = true;
    this.figure.position.y = -0.93 + Math.abs(Math.sin(this.phase)) * 0.04 * Math.min(1, k);
  }

  /** física arcade: acelerador, freio, ré, ladeira, esterço (modelo de bicicleta) */
  private ride(dt: number, throttle: number, steerIn: number, boost: boolean, brake: boolean) {
    const s = this.state;
    const v = this.riding!;
    const hf = this.world.height;
    const max = v.maxSpeed * (boost ? v.boost : 1);
    const fx = Math.sin(s.heading);
    const fz = Math.cos(s.heading);
    let a = 0;
    if (brake) a = -Math.sign(s.speed) * v.brake * 1.3;
    else if (throttle > 0.05) {
      // de ré e acelerando: freia primeiro
      a = s.speed < -0.2 ? v.brake * throttle : v.accel * throttle * Math.max(0, 1 - (s.speed / max) ** 4);
    } else if (throttle < -0.05) {
      a = s.speed > 0.3 ? v.brake * throttle : s.speed > -v.reverse ? v.accel * 0.5 * throttle : 0;
    } else a = -Math.sign(s.speed) * v.coast;
    a -= Math.sign(s.speed) * v.drag * s.speed * s.speed;
    // ladeira: subida segura, descida embala
    const grade = (hf.sample(s.x + fx, s.z + fz) - hf.sample(s.x - fx, s.z - fz)) / 2;
    a -= 9.8 * grade * v.slope;
    const before = s.speed;
    s.speed += a * dt;
    // freio/rolamento não invertem o sentido
    if ((brake || Math.abs(throttle) < 0.05) && Math.sign(s.speed) !== Math.sign(before) && Math.abs(grade) < 0.08) s.speed = 0;
    s.speed = THREE.MathUtils.clamp(s.speed, -v.reverse * 1.2, max * 1.35);

    // esterço sensível à velocidade; taxa de giro do modelo de bicicleta
    const k = Math.min(1, Math.abs(s.speed) / v.maxSpeed);
    const maxSteer = THREE.MathUtils.lerp(v.steerLow, v.steerHigh, k);
    this.steer += (steerIn * maxSteer - this.steer) * Math.min(1, dt * 7);
    const yawRate = (-s.speed * Math.tan(this.steer)) / v.wheelBase;
    s.heading += yawRate * dt;

    // deslocamento com subpassos e colisão (frente, meio e traseira)
    const step = s.speed * dt;
    const n = Math.max(1, Math.ceil(Math.abs(step) / 0.25));
    const x0 = s.x;
    const z0 = s.z;
    const half = v.wheelBase * 0.5;
    for (let i = 0; i < n; i++) {
      s.x += Math.sin(s.heading) * (step / n);
      s.z += Math.cos(s.heading) * (step / n);
      for (const off of [half, 0, -half]) {
        tmp.x = s.x + Math.sin(s.heading) * off;
        tmp.z = s.z + Math.cos(s.heading) * off;
        const bx = tmp.x;
        const bz = tmp.z;
        this.pushOut(tmp, v.radius);
        s.x += tmp.x - bx;
        s.z += tmp.z - bz;
      }
    }
    // bateu: perdeu boa parte do deslocamento pretendido
    const moved = Math.hypot(s.x - x0, s.z - z0);
    if (Math.abs(step) > 0.05 && moved < Math.abs(step) * 0.45 && Math.abs(s.speed) > 2) {
      this.bump = Math.min(1, Math.abs(s.speed) / 10);
      s.speed *= 0.35;
    }

    // visual: inclinação na curva, arfagem na ladeira, rodas e pedivela
    const leanT = THREE.MathUtils.clamp(-Math.atan((s.speed * yawRate) / 9.8), -0.55, 0.55);
    this.lean += (leanT - this.lean) * Math.min(1, dt * 6);
    const hFront = hf.sample(s.x + fx * half, s.z + fz * half);
    const hRear = hf.sample(s.x - fx * half, s.z - fz * half);
    this.pitch += (Math.atan2(hRear - hFront, v.wheelBase) - this.pitch) * Math.min(1, dt * 10);
    const m = this.model(v.kind);
    for (const w of m.wheels) w.rotation.x += (s.speed * dt) / m.wheelRadius;
    m.front.rotation.y = this.steer * 0.9;
    this.pedaling = v.pedals && throttle > 0.05 && s.speed > 0.3;
    if (this.pedaling) this.crank += (s.speed * dt) / 0.85;
    if (m.crank) m.crank.rotation.x = this.crank;
    this.walkAttr.setXYZ(0, this.crank, 0, v.pedals ? 0.6 : 0);
    this.walkAttr.needsUpdate = true;
    this.poseAttr.set([v.pose.legs, v.pose.arms, 0, v.pedals ? 1 : 0]);
    this.poseAttr.needsUpdate = true;
    // em pé nos pedais com Shift (bicicleta)
    this.seat.position.y = v.seat.y + (v.pedals && boost && this.pedaling ? 0.08 : 0);
  }

  /** empurra o ponto para fora de prédios e carros */
  private pushOut(p: { x: number; z: number }, radius: number) {
    for (let iter = 0; iter < 2; iter++) {
      for (const b of this.world.buildingsNear(p.x, p.z, 2)) {
        for (const ring of [b.outer, ...(b.holes ?? [])]) {
          let inside = false;
          let bestD2 = Infinity;
          let bx = 0;
          let bz = 0;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [x1, z1] = ring[j];
            const [x2, z2] = ring[i];
            if (z2 > p.z !== z1 > p.z && p.x < ((x1 - x2) * (p.z - z2)) / (z1 - z2) + x2) inside = !inside;
            const ex = x2 - x1;
            const ez = z2 - z1;
            const l2 = ex * ex + ez * ez || 1;
            let t = ((p.x - x1) * ex + (p.z - z1) * ez) / l2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const cx = x1 + ex * t;
            const cz = z1 + ez * t;
            const d2 = (p.x - cx) ** 2 + (p.z - cz) ** 2;
            if (d2 < bestD2) {
              bestD2 = d2;
              bx = cx;
              bz = cz;
            }
          }
          const isHole = ring !== b.outer;
          const blocked = isHole ? !inside : inside;
          const d = Math.sqrt(bestD2);
          if (blocked) {
            // dentro do prédio: empurra para fora pela aresta mais próxima
            const nx = (bx - p.x) / (d || 1);
            const nz = (bz - p.z) / (d || 1);
            p.x = bx + nx * radius;
            p.z = bz + nz * radius;
          } else if (d < radius && d > 1e-6) {
            p.x = bx + ((p.x - bx) / d) * radius;
            p.z = bz + ((p.z - bz) / d) * radius;
          }
        }
      }
    }
    // carros: caixa orientada
    for (const o of this.obstacles?.(p.x, p.z, radius + 4) ?? []) {
      const dx = p.x - o.x;
      const dz = p.z - o.z;
      const fx = Math.sin(o.yaw);
      const fz = Math.cos(o.yaw);
      const along = dx * fx + dz * fz;
      const side = dx * fz - dz * fx;
      const ca = THREE.MathUtils.clamp(along, -o.hl, o.hl);
      const cs = THREE.MathUtils.clamp(side, -o.hw, o.hw);
      let ex = along - ca;
      let es = side - cs;
      let d = Math.hypot(ex, es);
      if (d >= radius) continue;
      if (d < 1e-6) {
        // centro dentro da caixa: sai pelo lado mais próximo
        const pa = o.hl - Math.abs(along);
        const ps = o.hw - Math.abs(side);
        if (pa < ps) {
          ex = Math.sign(along) || 1;
          es = 0;
        } else {
          ex = 0;
          es = Math.sign(side) || 1;
        }
        d = 0;
      } else {
        ex /= d;
        es /= d;
      }
      const push = radius - d;
      p.x += (ex * fx + es * fz) * push;
      p.z += (ex * fz - es * fx) * push;
    }
  }

  private syncMesh() {
    const s = this.state;
    this.mesh.position.set(s.x, s.y, s.z);
    this.mesh.rotation.y = s.heading;
    if (s.vehicle) this.tilt.rotation.set(this.pitch, 0, this.lean);
  }
}
