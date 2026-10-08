import * as THREE from 'three';
import type { Player } from '../entities/Player';
import type { WorldState } from '../world/WorldState';

/**
 * Câmera em 3ª pessoa para o modo a pé. Arrastar (mouse ou toque) gira;
 * roda/pinça aproxima. Faz raycast contra os prédios para não atravessar
 * paredes.
 */
export class WalkCamera {
  yaw = 0;
  pitch = 0.32;
  distance = 7;
  enabled = false;
  /** montado: volta sozinha para trás do veículo quando não está sendo arrastada */
  follow = false;
  private lastLook = 0;
  private drag: { id: number; x: number; y: number; moved: number } | null = null;
  private pinch = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private readonly ray = new THREE.Raycaster();
  private readonly target = new THREE.Vector3();
  /** retorna true quando o último ponteiro foi um arraste (não um clique) */
  lastWasDrag = false;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
    private readonly player: Player,
    private readonly world: WorldState,
    private readonly colliders: () => THREE.Object3D[],
  ) {
    dom.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    this.ray.firstHitOnly = true;
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.pinch.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch.size === 2) {
      const [a, b] = [...this.pinch.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.drag = null;
      return;
    }
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 };
    this.lastWasDrag = false;
  };

  private onMove = (e: PointerEvent) => {
    if (!this.enabled) return;
    if (this.pinch.has(e.pointerId)) this.pinch.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch.size === 2) {
      const [a, b] = [...this.pinch.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDist > 0) this.distance = THREE.MathUtils.clamp(this.distance * (this.pinchDist / d), 3, 22);
      this.pinchDist = d;
      return;
    }
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
    this.drag.moved += Math.abs(dx) + Math.abs(dy);
    this.lastLook = performance.now();
    const k = e.pointerType === 'touch' ? 0.006 : 0.0045;
    this.yaw -= dx * k;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * k, -0.15, 1.25);
  };

  private onUp = (e: PointerEvent) => {
    this.pinch.delete(e.pointerId);
    if (this.pinch.size < 2) this.pinchDist = 0;
    if (this.drag && e.pointerId === this.drag.id) {
      this.lastWasDrag = this.drag.moved > 6;
      this.drag = null;
    }
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    this.distance = THREE.MathUtils.clamp(this.distance * (1 + Math.sign(e.deltaY) * 0.12), 3, 22);
  };

  /** alinha atrás do jogador a partir da câmera atual (transição suave entre modos) */
  alignBehind() {
    this.yaw = this.player.state.heading + Math.PI;
  }

  update(dt: number) {
    const s = this.player.state;
    if (this.follow && !this.drag && Math.abs(s.speed) > 0.8 && performance.now() - this.lastLook > 1200) {
      const d = Math.atan2(Math.sin(s.heading + Math.PI - this.yaw), Math.cos(s.heading + Math.PI - this.yaw));
      this.yaw += d * Math.min(1, dt * 2.2);
      this.pitch += (0.26 - this.pitch) * Math.min(1, dt * 1.2);
    }
    this.target.set(s.x, s.y + 1.6, s.z);
    // colisão da câmera com prédios (BVH) — só chunks próximos
    const near = this.colliders().filter((o) => o.userData.chunk && o.userData.chunk.center.distanceTo(this.target) < 400);
    const castAt = (pitch: number) => {
      const cp = Math.cos(pitch);
      const dir = new THREE.Vector3(Math.sin(this.yaw) * cp, Math.sin(pitch), Math.cos(this.yaw) * cp);
      this.ray.set(this.target, dir);
      this.ray.far = this.distance;
      const hits = this.ray.intersectObjects(near, false);
      let d = this.distance;
      for (const h of hits) d = Math.min(d, h.distance - 0.35);
      return { dir, dist: Math.max(0.8, d) };
    };
    let best = castAt(this.pitch);
    // obstruído (beco/parede atrás): tenta ângulos mais altos, "por cima do ombro"
    if (best.dist < this.distance * 0.6) {
      for (const p of [0.7, 1.0, 1.3]) {
        if (p <= this.pitch) continue;
        const alt = castAt(p);
        if (alt.dist > best.dist + 0.5) best = alt;
        if (alt.dist >= this.distance * 0.8) break;
      }
    }
    this.player.mesh.visible = best.dist > 1.3;
    const desired = this.target.clone().addScaledVector(best.dir, best.dist);
    const ground = this.world.height.sample(desired.x, desired.z) + 0.6;
    if (desired.y < ground) desired.y = ground;
    // batida: tremida curta
    const b = this.player.bump;
    if (b > 0) desired.add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(b * 0.35));
    // suaviza só a aproximação para não "pular"
    this.camera.position.lerp(desired, Math.min(1, dt * 14));
    this.camera.lookAt(this.target);
  }
}
