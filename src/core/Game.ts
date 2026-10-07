import * as THREE from 'three';
import type { WorldState } from '../world/WorldState';
import { CityView } from '../world/CityView';
import { CityCamera } from './CityCamera';

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
  readonly mobile: boolean;
  readonly sun = new THREE.DirectionalLight('#fff4e0', 2.6);
  readonly hemi = new THREE.HemisphereLight('#cfe6ff', '#8a7a5a', 1.1);
  private readonly systems: System[] = [];
  private readonly clock = new THREE.Clock();
  private running = false;
  /** callback opcional que substitui a renderização direta (pós-processamento) */
  renderOverride: (() => void) | null = null;

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

    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 9000);
    this.scene.background = new THREE.Color('#a9c7d8');
    this.scene.fog = new THREE.Fog('#b9d3e0', 500, 1700);

    // luz do sol com sombras suaves que seguem a câmera
    const s = this.sun;
    s.castShadow = true;
    const size = opts.mobile ? 1024 : 2048;
    s.shadow.mapSize.set(size, size);
    const ext = 260;
    Object.assign(s.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 10, far: 1600 });
    s.shadow.bias = -0.0004;
    s.shadow.normalBias = 0.6;
    s.shadow.radius = 3;
    this.scene.add(s, s.target, this.hemi);

    this.view = new CityView(this.world);
    this.scene.add(this.view.root);
    this.cityCam = new CityCamera(this.camera, opts.canvas, this.world);

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

  /** câmera/foco atual (centro da sombra, LOD, NPCs) */
  focus = new THREE.Vector3();
  /** direção do sol (unitária, do chão para o sol) */
  sunDir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.renderer.setAnimationLoop(this.frame);
  }

  private frame = () => {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.cityCam.update(dt);
    this.focus.copy(this.cityCam.target);
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
    const texel = (2 * 260) / s.shadow.mapSize.x;
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
  readonly onResizeHooks: ((w: number, h: number) => void)[] = [];
}
