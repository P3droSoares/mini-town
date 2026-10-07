import * as THREE from 'three';
import { Player } from '../entities/Player';
import { CityView } from '../world/CityView';
import type { WorldState } from '../world/WorldState';
import { CityCamera } from './CityCamera';
import { Input } from './Input';
import { WalkCamera } from './WalkCamera';

export interface GameOptions {
  canvas: HTMLCanvasElement;
  world: WorldState;
  mobile: boolean;
  onProgress?: (fraction: number, label: string) => void;
}

/** Sistemas atualizados a cada frame (tempo, tráfego, UI...). */
export interface System {
  update(dt: number): void;
}

export type CameraMode = 'city' | 'walk';

/**
 * Orquestra renderer, cena, câmeras e sistemas. Não guarda estado do mundo
 * (isso é do `WorldState`) — só apresentação e entrada.
 */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly world: WorldState;
  readonly view: CityView;
  readonly cityCam: CityCamera;
  readonly walkCam: WalkCamera;
  readonly player: Player;
  readonly input = new Input();
  readonly mobile: boolean;
  readonly sun = new THREE.DirectionalLight('#fff4e0', 2.6);
  readonly hemi = new THREE.HemisphereLight('#cfe6ff', '#8a7a5a', 1.1);
  mode: CameraMode = 'city';
  /** ponto de interesse atual (centro da sombra, NPCs, minimapa) */
  readonly focus = new THREE.Vector3();
  /** direção do sol (unitária, do chão para o sol) */
  readonly sunDir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
  /** callback opcional que substitui a renderização direta (pós-processamento) */
  renderOverride: (() => void) | null = null;
  readonly onModeChange: ((m: CameraMode) => void)[] = [];
  readonly onResizeHooks: ((w: number, h: number) => void)[] = [];

  private readonly systems: System[] = [];
  private readonly clock = new THREE.Clock();
  private running = false;
  private shadowExtent: number;

  constructor(private readonly opts: GameOptions) {
    this.world = opts.world;
    this.mobile = opts.mobile;
    const r = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: !opts.mobile,
      powerPreference: 'high-performance',
      stencil: false,
    });
    r.setPixelRatio(Math.min(window.devicePixelRatio, opts.mobile ? 1.5 : 2));
    r.setSize(window.innerWidth, window.innerHeight, false);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = r;

    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 2, 9000);
    this.scene.background = new THREE.Color('#a9c7d8');
    this.scene.fog = new THREE.Fog('#b9d3e0', 500, 1700);

    // sol com sombras suaves que seguem o foco
    const s = this.sun;
    s.castShadow = true;
    const size = opts.mobile ? 1024 : 2048;
    s.shadow.mapSize.set(size, size);
    this.shadowExtent = opts.mobile ? 200 : 260;
    const ext = this.shadowExtent;
    Object.assign(s.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 10, far: 1600 });
    s.shadow.bias = -0.0004;
    s.shadow.normalBias = 0.6;
    this.scene.add(s, s.target, this.hemi);

    this.view = new CityView(this.world);
    this.scene.add(this.view.root);
    this.cityCam = new CityCamera(this.camera, opts.canvas, this.world);
    this.player = new Player(this.world);
    this.scene.add(this.player.mesh);
    this.walkCam = new WalkCamera(this.camera, opts.canvas, this.player, this.world, () => this.view.pickMeshes);

    this.input.on('KeyC', () => this.toggleMode());
    window.addEventListener('resize', this.onResize);
  }

  async init() {
    await this.view.build({ mobile: this.mobile, onProgress: this.opts.onProgress });
    // compila shaders antes do primeiro frame (evita travadas)
    this.renderer.compile(this.scene, this.camera);
  }

  addSystem(s: System) {
    this.systems.push(s);
  }

  toggleMode() {
    this.setMode(this.mode === 'city' ? 'walk' : 'city');
  }

  setMode(m: CameraMode) {
    if (m === this.mode) return;
    this.mode = m;
    if (m === 'walk') {
      const t = this.cityCam.target;
      this.player.spawn(t.x, t.z);
      this.player.mesh.visible = true;
      this.cityCam.enabled = false;
      this.walkCam.enabled = true;
      // olha na mesma direção que a câmera de cidade olhava
      const d = t.clone().sub(this.camera.position);
      this.walkCam.yaw = Math.atan2(-d.x, -d.z);
      this.walkCam.pitch = 0.3;
      this.camera.near = 0.3;
      this.camera.fov = 60;
      this.setShadowExtent(80); // sombras mais nítidas perto do personagem
    } else {
      const s = this.player.state;
      this.player.mesh.visible = false;
      this.walkCam.enabled = false;
      this.cityCam.enabled = true;
      this.camera.near = 2;
      this.camera.fov = 45;
      this.setShadowExtent(this.mobile ? 200 : 260);
      this.cityCam.jumpTo(s.x, s.z, 110);
    }
    this.camera.updateProjectionMatrix();
    this.onModeChange.forEach((f) => f(m));
  }

  private setShadowExtent(ext: number) {
    this.shadowExtent = ext;
    const c = this.sun.shadow.camera;
    c.left = c.bottom = -ext;
    c.right = c.top = ext;
    c.updateProjectionMatrix();
  }

  /** teleporta o jogador (modo a pé) ou voa a câmera (modo cidade) */
  goTo(x: number, z: number, distance = 160) {
    if (this.mode === 'walk') {
      this.player.spawn(x, z);
    } else {
      this.cityCam.flyTo(x, z, distance);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.renderer.setAnimationLoop(this.frame);
  }

  private frame = () => {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.mode === 'walk') {
      this.player.update(dt, this.input.move, this.input.run, this.walkCam.yaw);
      this.walkCam.update(dt);
      const s = this.player.state;
      this.focus.set(s.x, s.y, s.z);
    } else {
      this.cityCam.update(dt);
      this.focus.copy(this.cityCam.target);
    }
    for (const s of this.systems) s.update(dt);
    this.view.update(dt);
    this.updateShadowCamera();
    if (this.renderOverride) this.renderOverride();
    else this.renderer.render(this.scene, this.camera);
  };

  /** centraliza a câmera de sombra no foco, com "snap" ao texel (sem tremido) */
  private updateShadowCamera() {
    const s = this.sun;
    const f = this.focus;
    const texel = (2 * this.shadowExtent) / s.shadow.mapSize.x;
    const q = new THREE.Vector3(Math.round(f.x / texel) * texel, f.y, Math.round(f.z / texel) * texel);
    s.target.position.copy(q);
    s.position.copy(q).addScaledVector(this.sunDir, 700);
    s.target.updateMatrixWorld();
  }

  private onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.onResizeHooks.forEach((f) => f(w, h));
  };
}
