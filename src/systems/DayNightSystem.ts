import * as THREE from 'three';
import type { Game, System } from '../core/Game';
import { worldUniforms } from '../world/render/materials';
import { Sky } from '../world/render/Sky';
import { directionFrom, sunPosition } from './solar';
import type { TimeSystem } from './TimeSystem';

interface Key {
  /** elevação do sol em graus */
  elev: number;
  top: string;
  horizon: string;
  sun: string;
  sunI: number;
  hemiSky: string;
  hemiGround: string;
  hemiI: number;
}

// paleta por elevação solar (interpolada)
const KEYS: Key[] = [
  { elev: -18, top: '#081029', horizon: '#1a2746', sun: '#a9bcff', sunI: 0.55, hemiSky: '#4a5f9a', hemiGround: '#1c1f2a', hemiI: 0.75 },
  { elev: -8, top: '#16244a', horizon: '#3a3f63', sun: '#a9bcff', sunI: 0.5, hemiSky: '#5a6a9a', hemiGround: '#24242c', hemiI: 0.8 },
  { elev: -2, top: '#3a5488', horizon: '#e48a62', sun: '#ff9a5c', sunI: 0.4, hemiSky: '#8a8fb0', hemiGround: '#4a3a33', hemiI: 0.7 },
  { elev: 4, top: '#5e8cc4', horizon: '#f4b98c', sun: '#ffb27a', sunI: 1.3, hemiSky: '#b8c8e0', hemiGround: '#7a6650', hemiI: 0.9 },
  { elev: 15, top: '#6a9fd2', horizon: '#d8dcd6', sun: '#ffcf96', sunI: 2.3, hemiSky: '#cfe0f5', hemiGround: '#8a7a5a', hemiI: 1.05 },
  { elev: 40, top: '#5f9bd6', horizon: '#cfdde3', sun: '#ffe6c4', sunI: 2.7, hemiSky: '#d4e8ff', hemiGround: '#8d7f60', hemiI: 1.15 },
];

const ca = new THREE.Color();
const cb = new THREE.Color();
function lerpHex(a: string, b: string, t: number, out: THREE.Color) {
  ca.set(a);
  cb.set(b);
  return out.copy(ca).lerp(cb, t);
}

/**
 * Aplica a hora do dia à cena: sol/lua (luz direcional com sombra),
 * hemisférica, céu, névoa, janelas (uNight) e postes.
 */
export class DayNightSystem implements System {
  readonly sky = new Sky();
  /** 0 = dia, 1 = noite (para outros sistemas, ex.: tráfego) */
  night = 0;
  elevationDeg = 0;
  private sunV = { x: 0, y: 1, z: 0 };
  private acc = 1;
  // iluminação de ambiente gerada do próprio céu (cubemap filtrado)
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private envRT: THREE.WebGLRenderTarget | null = null;
  private lastEnvSun = new THREE.Vector3(0, -2, 0);
  private envAge = 999;

  constructor(
    private readonly game: Game,
    private readonly time: TimeSystem,
  ) {
    game.scene.add(this.sky.mesh);
    game.scene.background = null;
    this.pmrem = new THREE.PMREMGenerator(game.renderer);
    const envSky = new THREE.Mesh(this.sky.mesh.geometry, this.sky.envMaterial());
    envSky.scale.setScalar(100);
    this.envScene.add(envSky);
    time.onChange(() => (this.acc = 1)); // reaplica na hora
    this.apply();
    // enquadramento inicial com luz lateral
    game.cityCam.reset(game.sunDir);
  }

  update(dt: number) {
    this.time.update(dt);
    this.sky.uniforms.uTime.value += dt;
    this.envAge += dt;
    this.sky.follow(this.game.camera);
    // a posição do sol muda devagar: recalcula 4x/s
    this.acc += dt;
    if (this.acc < 0.25) return;
    this.acc = 0;
    this.apply();
  }

  private apply() {
    const { game } = this;
    const o = game.world.data.origin;
    const { altitude, azimuth } = sunPosition(this.time.now(), o.lat, o.lon);
    directionFrom(altitude, azimuth, this.sunV);
    const elev = (altitude * 180) / Math.PI;
    this.elevationDeg = elev;

    // keyframes
    let i = 0;
    while (i < KEYS.length - 2 && elev > KEYS[i + 1].elev) i++;
    const k0 = KEYS[i];
    const k1 = KEYS[i + 1];
    const t = THREE.MathUtils.clamp((elev - k0.elev) / (k1.elev - k0.elev), 0, 1);

    const u = this.sky.uniforms;
    const fog = game.scene.fog as THREE.Fog;
    lerpHex(k0.horizon, k1.horizon, t, fog.color);

    this.night = THREE.MathUtils.smoothstep(-elev, -6, 6); // 0 dia .. 1 noite
    const sunUp = elev > -3;
    const sunDir = new THREE.Vector3(this.sunV.x, this.sunV.y, this.sunV.z);
    this.sky.setSun(sunDir);
    lerpHex(k0.sun, k1.sun, t, u.uSunColor.value);
    (u.uSunColor.value as THREE.Color).multiplyScalar(THREE.MathUtils.lerp(0.25, 1.0, 1 - this.night));
    // céu mais "denso" (turbidez) perto do horizonte = pôr do sol mais quente
    u.turbidity.value = THREE.MathUtils.lerp(5, 2.2, THREE.MathUtils.smoothstep(elev, 0, 25));
    // lua: aproximadamente oposta ao sol, sempre um pouco acima do horizonte
    const moon = new THREE.Vector3(-sunDir.x * 0.8 + 0.2, Math.max(0.45, -sunDir.y), -sunDir.z * 0.8 + 0.3).normalize();
    u.uMoonDir.value.copy(moon);
    u.uNight.value = this.night;

    // luz direcional = sol de dia, lua de noite (mantém sombras suaves)
    const light = game.sun;
    lerpHex(k0.sun, k1.sun, t, light.color);
    // sol direto bem mais forte que o céu (contraste de sombra realista)
    light.intensity = THREE.MathUtils.lerp(k0.sunI, k1.sunI, t) * 2.6;
    if (sunUp) game.sunDir.copy(sunDir.y < 0.06 ? sunDir.setY(0.06).normalize() : sunDir);
    else game.sunDir.copy(moon);

    lerpHex(k0.hemiSky, k1.hemiSky, t, game.hemi.color);
    lerpHex(k0.hemiGround, k1.hemiGround, t, game.hemi.groundColor);
    game.hemi.intensity = THREE.MathUtils.lerp(k0.hemiI, k1.hemiI, t);
    // com HDRI (IBL) a hemisférica vira só complemento; reflexos somem à noite
    game.hemi.intensity *= 0.35;
    game.scene.environmentIntensity = 0.27;
    // regenera o cubemap do céu quando o sol anda ~1° (ou a cada 30 s, nuvens)
    if (sunDir.distanceTo(this.lastEnvSun) > 0.018 || this.envAge > 30) {
      this.lastEnvSun.copy(sunDir);
      this.envAge = 0;
      const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 1000);
      game.scene.environment = rt.texture;
      this.envRT?.dispose();
      this.envRT = rt;
    }

    // névoa um pouco mais fechada à noite
    fog.near = THREE.MathUtils.lerp(650, 350, this.night);
    fog.far = THREE.MathUtils.lerp(2100, 1300, this.night);

    // janelas acesas: mais no começo da noite, poucas de madrugada
    const h = this.time.hours();
    const lit = h >= 17 || h < 1 ? 0.6 : h < 5 ? 0.18 : h < 8 ? 0.35 : 0.4;
    worldUniforms.uNight.value = this.night;
    worldUniforms.uLitRatio.value = lit;
    worldUniforms.uSunDirW.value.copy(game.sunDir);
    worldUniforms.uSunCol.value.copy(light.color).multiplyScalar(light.intensity);
    game.view.streetLights?.setNight(this.night);
  }
}
