import * as THREE from 'three';
import type { WorldState } from '../world/WorldState';
import { distSqToSegment } from '../world/geo';

const RADIUS = 0.35;
const WALK = 4.2;
const RUN = 9.5;

/** Estado do jogador (puro) — no multiplayer será sincronizado com o servidor. */
export interface PlayerState {
  x: number;
  z: number;
  y: number;
  heading: number;
  speed: number;
}

/**
 * Personagem a pé: boneco low-poly com animação de caminhada procedural,
 * colisão 2D contra footprints dos prédios e altura pelo relevo.
 */
export class Player {
  readonly state: PlayerState = { x: 0, z: 0, y: 0, heading: 0, speed: 0 };
  readonly mesh = new THREE.Group();
  private legs: THREE.Mesh[] = [];
  private arms: THREE.Mesh[] = [];
  private body: THREE.Group;
  private phase = 0;

  constructor(private readonly world: WorldState) {
    const skin = new THREE.MeshStandardMaterial({ color: '#d9a27a', roughness: 0.8, flatShading: true });
    const shirt = new THREE.MeshStandardMaterial({ color: '#c2633a', roughness: 0.85, flatShading: true });
    const pants = new THREE.MeshStandardMaterial({ color: '#34495e', roughness: 0.9, flatShading: true });
    const hair = new THREE.MeshStandardMaterial({ color: '#3b2a20', roughness: 0.9, flatShading: true });
    this.body = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.62, 0.3), shirt);
    torso.position.y = 1.12;
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 1), skin);
    head.position.y = 1.62;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.21, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), hair);
    cap.position.y = 1.65;
    this.body.add(torso, head, cap);
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.78, 0.2).translate(0, -0.39, 0), pants);
      leg.position.set(0.13 * side, 0.82, 0);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.58, 0.14).translate(0, -0.28, 0), shirt);
      arm.position.set(0.33 * side, 1.4, 0);
      this.legs.push(leg);
      this.arms.push(arm);
      this.body.add(leg, arm);
    }
    this.body.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    // marcador no chão (ajuda a achar o boneco de longe)
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.45, 0.6, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthWrite: false }),
    );
    ring.position.y = 0.06;
    this.mesh.add(this.body, ring);
    this.mesh.visible = false;
  }

  /** posiciona num ponto livre próximo de (x, z) */
  spawn(x: number, z: number) {
    const p = this.findFree(x, z);
    this.state.x = p.x;
    this.state.z = p.z;
    this.state.y = this.world.height.sample(p.x, p.z);
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
    if (!this.world.buildingAt(x, z)) return { x, z };
    for (let r = 2; r < 80; r += 2)
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        if (!this.world.buildingAt(px, pz)) return { x: px, z: pz };
      }
    return { x, z };
  }

  /**
   * @param move entrada (x = direita, y = frente), relativa à câmera
   * @param yaw yaw da câmera
   */
  update(dt: number, move: { x: number; y: number }, run: boolean, yaw: number) {
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
      this.collide();
    }
    // limites do terreno jogável
    const b = this.world.data.bounds;
    const m = 300;
    s.x = THREE.MathUtils.clamp(s.x, b.minX - m, b.maxX + m);
    s.z = THREE.MathUtils.clamp(s.z, b.minZ - m, b.maxZ + m);
    const gy = this.world.height.sample(s.x, s.z);
    s.y += (gy - s.y) * Math.min(1, dt * 18);

    // animação procedural de caminhada
    const k = s.speed / WALK;
    this.phase += dt * (4 + s.speed * 1.6) * (k > 0.05 ? 1 : 0);
    const swing = Math.sin(this.phase) * Math.min(1, k) * 0.7;
    this.legs[0].rotation.x = swing;
    this.legs[1].rotation.x = -swing;
    this.arms[0].rotation.x = -swing * 0.8;
    this.arms[1].rotation.x = swing * 0.8;
    this.body.position.y = Math.abs(Math.sin(this.phase)) * 0.06 * Math.min(1, k);
    this.syncMesh();
  }

  private collide() {
    const s = this.state;
    for (let iter = 0; iter < 2; iter++) {
      for (const b of this.world.buildingsNear(s.x, s.z, 2)) {
        for (const ring of [b.outer, ...(b.holes ?? [])]) {
          let inside = false;
          let bestD2 = Infinity;
          let bx = 0;
          let bz = 0;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [x1, z1] = ring[j];
            const [x2, z2] = ring[i];
            if (z2 > s.z !== z1 > s.z && s.x < ((x1 - x2) * (s.z - z2)) / (z1 - z2) + x2) inside = !inside;
            const ex = x2 - x1;
            const ez = z2 - z1;
            const l2 = ex * ex + ez * ez || 1;
            let t = ((s.x - x1) * ex + (s.z - z1) * ez) / l2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const cx = x1 + ex * t;
            const cz = z1 + ez * t;
            const d2 = (s.x - cx) ** 2 + (s.z - cz) ** 2;
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
            const nx = (bx - s.x) / (d || 1);
            const nz = (bz - s.z) / (d || 1);
            s.x = bx + nx * RADIUS;
            s.z = bz + nz * RADIUS;
          } else if (d < RADIUS && d > 1e-6) {
            s.x = bx + ((s.x - bx) / d) * RADIUS;
            s.z = bz + ((s.z - bz) / d) * RADIUS;
          }
        }
      }
    }
  }

  private syncMesh() {
    const s = this.state;
    this.mesh.position.set(s.x, s.y, s.z);
    this.mesh.rotation.y = s.heading;
  }
}
