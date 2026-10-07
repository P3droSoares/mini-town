import { N8AOPass } from 'n8ao';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { worldUniforms } from '../world/render/materials';
import type { Game } from './Game';

/**
 * Pós-processamento conforme a qualidade:
 *  - SSAO (N8AO) — oclusão de ambiente nos cantos, sob beirais, entre casas
 *  - Bloom — luzes de janelas, postes e faróis "brilham" à noite
 *  - Tilt-shift (opcional, menu) — efeito maquete
 * Sem nenhum efeito ligado, renderiza direto (custo zero).
 */
const TiltShiftShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uDir: { value: new THREE.Vector2(1, 0) },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uFocus: { value: 0.5 },
    uBand: { value: 0.16 },
    uStrength: { value: 3.2 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform vec2 uDir; uniform vec2 uResolution;
    uniform float uFocus; uniform float uBand; uniform float uStrength;
    varying vec2 vUv;
    void main() {
      float d = max(abs(vUv.y - uFocus) - uBand, 0.0);
      float r = clamp(d * 3.0, 0.0, 1.0) * uStrength;
      vec2 o = uDir / uResolution * r;
      vec4 c = texture2D(tDiffuse, vUv) * 0.2270270270;
      c += texture2D(tDiffuse, vUv + o * 1.3846153846) * 0.3162162162;
      c += texture2D(tDiffuse, vUv - o * 1.3846153846) * 0.3162162162;
      c += texture2D(tDiffuse, vUv + o * 3.2307692308) * 0.0702702703;
      c += texture2D(tDiffuse, vUv - o * 3.2307692308) * 0.0702702703;
      gl_FragColor = c;
    }`,
};

const GradeShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null }, uSat: { value: 1.05 }, uVignette: { value: 0.18 } },
  vertexShader: TiltShiftShader.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uSat; uniform float uVignette; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, uSat);
      float v = smoothstep(0.85, 0.25, length(vUv - 0.5));
      c.rgb *= mix(1.0 - uVignette, 1.0, v);
      gl_FragColor = c;
    }`,
};

export class PostFX {
  private composer: EffectComposer | null = null;
  private tilt: ShaderPass[] = [];
  private grade: ShaderPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private ao: N8AOPass | null = null;
  tiltShift = false;

  constructor(private readonly game: Game) {
    game.onResizeHooks.push(() => this.resize());
  }

  private resize() {
    if (!this.composer) return;
    const { renderer } = this.game;
    const size = renderer.getSize(new THREE.Vector2());
    this.composer.setPixelRatio(renderer.getPixelRatio());
    this.composer.setSize(size.x, size.y);
    this.tilt.forEach((p) => p.uniforms.uResolution.value.set(size.x * renderer.getPixelRatio(), size.y * renderer.getPixelRatio()));
  }

  /** (re)monta a cadeia conforme qualidade + tilt-shift */
  rebuild() {
    const { renderer, scene, camera, quality } = this.game;
    this.composer?.dispose();
    this.composer = null;
    this.tilt = [];
    this.bloom = null;
    this.ao = null;
    const any = quality.ssao || quality.bloom || this.tiltShift;
    if (!any) {
      this.game.renderOverride = null;
      return;
    }
    const size = renderer.getSize(new THREE.Vector2());
    const pr = renderer.getPixelRatio();
    // MSAA no alvo só sem SSAO (o N8AO pede SMAA no lugar)
    const rt = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, {
      type: THREE.HalfFloatType,
      samples: quality.ssao || !quality.antialias ? 0 : 4,
    });
    const c = new EffectComposer(renderer, rt);
    if (quality.ssao) {
      const ao = new N8AOPass(scene, camera, size.x * pr, size.y * pr);
      ao.configuration.aoRadius = 4;
      ao.configuration.distanceFalloff = 1.2;
      ao.configuration.intensity = 2.2;
      ao.configuration.gammaCorrection = false;
      ao.configuration.halfRes = true;
      ao.setQualityMode('Medium');
      c.addPass(ao);
      this.ao = ao;
    } else c.addPass(new RenderPass(scene, camera));
    if (quality.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.4, 0.5, 0.92);
      c.addPass(this.bloom);
    }
    if (this.tiltShift)
      for (let i = 0; i < 2; i++)
        for (const dir of [new THREE.Vector2(1, 0), new THREE.Vector2(0, 1)]) {
          const p = new ShaderPass(TiltShiftShader);
          p.uniforms.uDir.value = dir;
          p.uniforms.uResolution.value.set(size.x * pr, size.y * pr);
          p.uniforms.uStrength.value = i === 0 ? 2.2 : 1.4;
          this.tilt.push(p);
          c.addPass(p);
        }
    this.grade = new ShaderPass(GradeShader);
    if (this.tiltShift) {
      this.grade.uniforms.uSat.value = 1.18;
      this.grade.uniforms.uVignette.value = 0.28;
    }
    c.addPass(this.grade);
    c.addPass(new OutputPass());
    if (quality.ssao) c.addPass(new SMAAPass(size.x * pr, size.y * pr));
    this.composer = c;
    this.game.renderOverride = () => this.render();
  }

  setTiltShift(v: boolean) {
    this.tiltShift = v;
    this.rebuild();
  }

  private render() {
    const night = worldUniforms.uNight.value;
    if (this.bloom) {
      // de dia só reflexos fortes; à noite as luzes ganham halo
      this.bloom.strength = 0.12 + night * 0.65;
      this.bloom.threshold = night > 0.5 ? 0.75 : 0.95;
    }
    if (this.ao) this.ao.configuration.intensity = 2.2 * (1 - night * 0.6);
    const walk = this.game.mode === 'walk';
    for (const p of this.tilt) {
      p.uniforms.uFocus.value = walk ? 0.42 : 0.47;
      p.uniforms.uBand.value = walk ? 0.22 : 0.14;
    }
    this.composer!.render();
  }
}
