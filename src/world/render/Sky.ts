import * as THREE from 'three';
import { Sky as PreethamSky } from 'three/examples/jsm/objects/Sky.js';
import { MONO_SKY_GLSL } from './mono';
import { MONO } from './style';

/**
 * Céu realista: atmosfera física (Preetham — espalhamento Rayleigh/Mie,
 * disco solar) + camada de nuvens procedural (fbm com distorção de domínio,
 * auto-sombreamento na direção do sol, borda prateada contra a luz), vento,
 * estrelas e lua à noite. Também alimenta a iluminação de ambiente (IBL).
 */
const CLOUDS = /* glsl */ `
uniform float uTime;
uniform float uNight;
uniform float uCoverage;
uniform vec2 uWind;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform float uEnvMode;
float h12(vec2 p){ p = fract(p * vec2(234.34, 435.345)); p += dot(p, p + 34.23); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h12(i), h12(i + vec2(1.0, 0.0)), u.x), mix(h12(i + vec2(0.0, 1.0)), h12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p){
  float a = 0.5; float s = 0.0;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = m * p; a *= 0.5; }
  return s;
}
float cloudDensity(vec2 p){
  // distorção de domínio: formas de cúmulos "fofas"
  vec2 q = vec2(fbm(p + vec2(0.0, uTime * 0.01)), fbm(p + vec2(5.2, 1.3)));
  // fbm fica concentrado em ~0,5: estica o contraste para formar nuvens isoladas
  float base = (fbm(p + 1.6 * q) - 0.5) * 2.4 + 0.5;
  float d = smoothstep(1.0 - uCoverage, 1.0 - uCoverage + 0.16, base);
  // erosão de alta frequência nas bordas
  d *= 0.75 + 0.25 * vnoise(p * 7.0 + uTime * 0.03);
  return d;
}
float hs(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
`;

const COMPOSITE = /* glsl */ `
// HDR do Preetham é alto para o tone mapping AgX: escala para ficar azul
vec3 col = retColor * mix(0.36, 0.7, uEnvMode);
// ---- noite: base azul profunda, estrelas, lua
float nightK = uNight;
col += vec3(0.003, 0.006, 0.016) * nightK * (1.0 - direction.y * 0.5);
if (nightK > 0.01 && direction.y > 0.0) {
  vec3 sp = direction * 260.0;
  vec3 id = floor(sp);
  float s = hs(id);
  float star = step(0.987, s) * smoothstep(0.22, 0.0, length(fract(sp) - 0.5));
  float tw = 0.6 + 0.4 * sin(uTime * (1.3 + s * 3.0) + s * 60.0);
  col += vec3(star * tw * nightK * smoothstep(0.0, 0.3, direction.y)) * 0.6;
}
float md = dot(direction, uMoonDir);
col += vec3(0.85, 0.9, 1.0) * smoothstep(0.99935, 0.9996, md) * nightK * 1.4;
col += vec3(0.08, 0.1, 0.16) * pow(max(md, 0.0), 30.0) * nightK * 0.25;

// ---- nuvens (plano a ~1,6 km)
if (direction.y > 0.0) {
  float t = 1600.0 / max(direction.y, 0.035);
  vec2 p = (direction.xz * t) * 0.0003 + uWind * uTime;
  float dens = cloudDensity(p);
  if (dens > 0.001) {
    vec3 sd = normalize(vSunDirection);
    vec2 toSun = sd.xz / max(sd.y, 0.12) * 0.06;
    float shade = cloudDensity(p + toSun) + 0.5 * cloudDensity(p + toSun * 2.2);
    float light = exp(-shade * 1.8);
    float cosT = dot(direction, sd);
    float silver = pow(max(cosT, 0.0), 12.0) * 2.5 + pow(max(cosT, 0.0), 3.0) * 0.4;
    vec3 ambient = mix(vec3(0.5, 0.56, 0.66), col * 1.6 + 0.06, 0.35) * (1.0 - nightK * 0.92);
    vec3 lit = uSunColor * (1.35 + silver * (1.0 - dens * 0.7));
    vec3 cc = mix(ambient, lit, light);
    // pôr do sol: base das nuvens tinge de laranja
    cc += uSunColor * vec3(1.0, 0.55, 0.25) * (1.0 - smoothstep(-0.02, 0.25, sd.y)) * 0.35 * (1.0 - light);
    float fade = smoothstep(0.0, 0.12, direction.y);
    col = mix(col, cc, clamp(dens * 1.3, 0.0, 1.0) * fade);
  }
}
// no cubemap de iluminação: sem disco solar e valores limitados (evita IBL estourada)
if (uEnvMode > 0.5) col = min(col, vec3(1.2));
#ifdef MONO
${MONO_SKY_GLSL()}
#endif
gl_FragColor = vec4(col, 1.0);
`;

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly uniforms: Record<string, THREE.IUniform>;

  constructor() {
    const base = PreethamSky.SkyShader as unknown as { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string };
    this.uniforms = {
      ...THREE.UniformsUtils.clone(base.uniforms),
      uTime: { value: 0 },
      uNight: { value: 0 },
      uCoverage: { value: 0.5 },
      uWind: { value: new THREE.Vector2(0.004, 0.0015) },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uEnvMode: { value: 0 },
    };
    this.uniforms.turbidity.value = 3.2;
    this.uniforms.rayleigh.value = 2.4;
    this.uniforms.mieCoefficient.value = 0.006;
    this.uniforms.mieDirectionalG.value = 0.82;
    const frag = base.fragmentShader
      .replace('void main() {', `${CLOUDS}\nvoid main() {`)
      .replace('L0 += ( vSunE * 19000.0 * Fex ) * sundisk;', 'L0 += ( vSunE * 19000.0 * Fex ) * sundisk * ( 1.0 - uEnvMode );')
      .replace('gl_FragColor = vec4( retColor, 1.0 );', COMPOSITE);
    this.material = new THREE.ShaderMaterial({
      name: 'CloudSky',
      uniforms: this.uniforms,
      vertexShader: base.vertexShader,
      fragmentShader: frag,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      defines: MONO ? { MONO: '' } : {},
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.material);
    this.mesh.scale.setScalar(4500);
    this.mesh.name = 'sky';
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
  }

  /** direção do sol (unitária) */
  setSun(dir: THREE.Vector3) {
    (this.uniforms.sunPosition.value as THREE.Vector3).copy(dir).multiplyScalar(450000);
  }

  /** material para gerar o cubemap de iluminação (mesmos uniforms, sem sol) */
  envMaterial(): THREE.ShaderMaterial {
    const m = this.material.clone();
    m.uniforms = { ...this.uniforms, uEnvMode: { value: 1 } };
    return m;
  }

  follow(camera: THREE.Camera) {
    this.mesh.position.copy(camera.position);
  }
}
