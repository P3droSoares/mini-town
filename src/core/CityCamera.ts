import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import type { WorldState } from '../world/WorldState';

/**
 * Câmera estilo city builder: arrastar = mover, botão direito/2 dedos =
 * girar, roda/pinça = zoom. Alvo preso aos limites do mapa e ao relevo.
 */
export class CityCamera {
  readonly controls: MapControls;
  private fly: { from: THREE.Vector3; to: THREE.Vector3; camFrom: THREE.Vector3; camTo: THREE.Vector3; t: number; dur: number } | null =
    null;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
    private readonly world: WorldState,
  ) {
    const c = new MapControls(camera, dom);
    c.enableDamping = true;
    c.dampingFactor = 0.09;
    c.screenSpacePanning = false;
    c.minDistance = 22;
    c.maxDistance = 900;
    c.minPolarAngle = 0.12;
    c.maxPolarAngle = 1.3;
    c.zoomSpeed = 1.1;
    c.panSpeed = 1.0;
    c.rotateSpeed = 0.6;
    c.zoomToCursor = true;
    c.keyPanSpeed = 22;
    c.listenToKeyEvents(window);
    this.controls = c;
    this.reset();
  }

  /**
   * Vista aérea oblíqua olhando o centro e o rio. Com `sunDir`, a câmera fica
   * de lado para o sol (~110°): luz lateral revela sombras longas e volume —
   * com o sol atrás da câmera as sombras ficam escondidas atrás dos objetos.
   */
  reset(sunDir?: THREE.Vector3) {
    const y = this.world.height.sample(0, 0);
    this.controls.target.set(-40, y, 40);
    let az = Math.atan2(-330, -250);
    if (sunDir && sunDir.y > 0.02) az = Math.atan2(sunDir.z, sunDir.x) + Math.PI * 0.62;
    this.camera.position.set(-40 + Math.cos(az) * 410, y + 300, 40 + Math.sin(az) * 410);
    this.controls.update();
  }

  set enabled(v: boolean) {
    this.controls.enabled = v;
  }
  get enabled() {
    return this.controls.enabled;
  }

  get target() {
    return this.controls.target;
  }

  /** voa suavemente até (x, z) mantendo a direção atual */
  flyTo(x: number, z: number, distance = 160) {
    const y = this.world.height.sample(x, z);
    const to = new THREE.Vector3(x, y, z);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.y < 0.45) dir.setY(0.45).normalize();
    this.fly = {
      from: this.controls.target.clone(),
      to,
      camFrom: this.camera.position.clone(),
      camTo: to.clone().addScaledVector(dir, distance),
      t: 0,
      dur: 1.4,
    };
  }

  /** move o alvo para (x, z) sem animação (ex.: ao sair do modo a pé) */
  jumpTo(x: number, z: number, distance = 90) {
    this.fly = null;
    const y = this.world.height.sample(x, z);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.y < 0.5) dir.setY(0.5).normalize();
    this.controls.target.set(x, y, z);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, distance);
    this.controls.update();
  }

  update(dt: number) {
    if (this.fly) {
      const f = this.fly;
      f.t = Math.min(1, f.t + dt / f.dur);
      const e = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2;
      this.controls.target.lerpVectors(f.from, f.to, e);
      this.camera.position.lerpVectors(f.camFrom, f.camTo, e);
      if (f.t >= 1) this.fly = null;
    }
    this.controls.update(dt);

    const t = this.controls.target;
    const b = this.world.data.bounds;
    const m = 120;
    const cx = THREE.MathUtils.clamp(t.x, b.minX - m, b.maxX + m);
    const cz = THREE.MathUtils.clamp(t.z, b.minZ - m, b.maxZ + m);
    const dx = cx - t.x;
    const dz = cz - t.z;
    // alvo acompanha o relevo
    const dy = (this.world.height.sample(cx, cz) - t.y) * Math.min(1, dt * 6);
    if (dx || dz || dy) {
      t.x += dx;
      t.z += dz;
      t.y += dy;
      this.camera.position.x += dx;
      this.camera.position.z += dz;
      this.camera.position.y += dy;
    }
    // nunca abaixo do chão
    const ground = this.world.height.sample(this.camera.position.x, this.camera.position.z) + 6;
    if (this.camera.position.y < ground) this.camera.position.y = ground;
  }

  dispose() {
    this.controls.dispose();
  }
}
