import * as THREE from 'three';
import type { HeightField } from '../HeightField';
import type { Route } from '../routing';
import { densify } from './roadGeometry';
import { MONO, MONO_LIGHT } from './style';

/** cor do GPS no mundo (monocromático: o mesmo amarelo das luzes) */
export const ROUTE_COLOR = MONO ? MONO_LIGHT : '#ff5a36';

const routeVert = /* glsl */ `
attribute vec2 aRoute;
varying vec2 vRoute;
#include <fog_pars_vertex>
void main() {
  vRoute = aRoute;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const routeFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uStart;
uniform float uOpacity;
varying vec2 vRoute;
#include <fog_pars_fragment>
void main() {
  float d = vRoute.y - uStart;
  if (d < 0.0) discard;
  float across = abs(vRoute.x);
  float edge = 1.0 - smoothstep(0.75, 1.0, across);
  // setas ">" andando no sentido da rota
  float s = fract((vRoute.y - uTime * 6.0) / 4.0 + across * 0.3);
  float chev = smoothstep(0.0, 0.04, s) * (1.0 - smoothstep(0.26, 0.3, s));
  float a = mix(0.32, 1.0, chev) * edge * smoothstep(0.0, 5.0, d) * uOpacity;
  gl_FragColor = vec4(uColor * mix(1.0, 1.8, chev), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/**
 * Faixa de GPS sobre as ruas: fita com setas animadas que some atrás do
 * jogador (`progress`) — a geometria só é refeita quando a rota muda.
 */
export class RouteLine {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;

  constructor(private readonly hf: HeightField) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uColor: { value: new THREE.Color(ROUTE_COLOR) }, uTime: { value: 0 }, uStart: { value: 0 }, uOpacity: { value: 1 } },
      ]),
      vertexShader: routeVert,
      fragmentShader: routeFrag,
      transparent: true,
      depthWrite: false,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
  }

  set(route: Route | null, width = 1.6) {
    this.mesh.visible = !!route;
    if (!route) return;
    const pts = densify(route.points, 2.5);
    const n = pts.length;
    const pos = new Float32Array(n * 6);
    const uv = new Float32Array(n * 4);
    const idx: number[] = [];
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const [x, z] = pts[i];
      if (i > 0) acc += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
      // normal com esquadria (limitada nas curvas fechadas)
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[Math.min(n - 1, i + 1)];
      let tx = p1[0] - p0[0];
      let tz = p1[1] - p0[1];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      let miter = 1;
      if (i > 0 && i < n - 1) {
        const ax = x - p0[0];
        const az = z - p0[1];
        const al = Math.hypot(ax, az) || 1;
        miter = Math.min(2, 1 / Math.max(0.5, (ax / al) * tx + (az / al) * tz));
      }
      const hw = (width / 2) * miter;
      const nx = -tz * hw;
      const nz = tx * hw;
      const y = this.hf.sample(x, z) + 0.22;
      pos.set([x + nx, y, z + nz, x - nx, y, z - nz], i * 6);
      uv.set([-1, acc, 1, acc], i * 4);
      if (i < n - 1) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aRoute', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    this.mat.uniforms.uStart.value = 0;
  }

  /** metros já percorridos (o trecho de trás some) */
  set progress(m: number) {
    this.mat.uniforms.uStart.value = m;
  }

  update(dt: number) {
    if (this.mesh.visible) this.mat.uniforms.uTime.value += dt;
  }
}

const beamVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const beamFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  float a = pow(1.0 - vUv.y, 2.2) * uOpacity;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

/**
 * Marcador de destino: feixe de luz vertical (visível por cima dos telhados),
 * anel pulsando no chão e um losango girando.
 */
export class Beacon {
  readonly group = new THREE.Group();
  private readonly beamMat: THREE.ShaderMaterial;
  private readonly ring: THREE.Mesh;
  private readonly icon: THREE.Mesh;
  private t = 0;

  constructor(private readonly hf: HeightField) {
    const color = new THREE.Color(ROUTE_COLOR);
    this.beamMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color }, uOpacity: { value: 0.6 } },
      vertexShader: beamVert,
      fragmentShader: beamFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 40, 24, 1, true).translate(0, 20, 0), this.beamMat);
    const glow = (opacity: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.2, 40).rotateX(-Math.PI / 2), glow(0.9));
    this.ring.position.y = 0.25;
    this.icon = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0).scale(1, 1.5, 1), new THREE.MeshBasicMaterial({ color, fog: false }));
    this.icon.position.y = 3.4;
    for (const m of [beam, this.ring, this.icon]) {
      m.frustumCulled = false;
      m.renderOrder = 4;
    }
    this.group.add(beam, this.ring, this.icon);
    this.group.visible = false;
  }

  show(x: number, z: number) {
    this.group.position.set(x, this.hf.sample(x, z), z);
    this.group.visible = true;
    this.t = 0;
  }

  hide() {
    this.group.visible = false;
  }

  update(dt: number) {
    if (!this.group.visible) return;
    this.t += dt;
    const k = (this.t * 0.8) % 1;
    this.ring.scale.setScalar(0.7 + k * 0.8);
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
    this.icon.rotation.y += dt * 2;
    this.icon.position.y = 3.4 + Math.sin(this.t * 2.5) * 0.25;
  }
}
