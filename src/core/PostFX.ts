import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { Game } from './Game';

/**
 * Tilt-shift (efeito maquete): desfoque gaussiano separável cuja força
 * cresce com a distância vertical da faixa de foco + leve saturação e
 * vinheta. Só ativo quando ligado no menu (custo zero quando desligado).
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
  uniforms: { tDiffuse: { value: null as THREE.Texture | null }, uSat: { value: 1.18 }, uVignette: { value: 0.28 } },
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
  private passes: ShaderPass[] = [];
  enabled = false;

  constructor(private readonly game: Game) {
    game.onResizeHooks.push((w, h) => {
      this.composer?.setSize(w, h);
      this.passes.forEach((p) => p.uniforms.uResolution?.value.set(w, h));
    });
  }

  private ensure() {
    if (this.composer) return;
    const { renderer, scene, camera } = this.game;
    const size = renderer.getSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: this.game.mobile ? 0 : 4 });
    const c = new EffectComposer(renderer, rt);
    c.addPass(new RenderPass(scene, camera));
    // 2 iterações H+V = desfoque mais largo e suave
    for (let i = 0; i < 2; i++)
      for (const dir of [new THREE.Vector2(1, 0), new THREE.Vector2(0, 1)]) {
        const p = new ShaderPass(TiltShiftShader);
        p.uniforms.uDir.value = dir;
        p.uniforms.uResolution.value.set(size.x, size.y);
        p.uniforms.uStrength.value = i === 0 ? 2.2 : 1.4;
        this.passes.push(p);
        c.addPass(p);
      }
    c.addPass(new ShaderPass(GradeShader));
    c.addPass(new OutputPass());
    this.composer = c;
  }

  setEnabled(v: boolean) {
    this.enabled = v;
    if (v) {
      this.ensure();
      this.game.renderOverride = () => {
        // no modo a pé o foco é o personagem (um pouco abaixo do centro)
        const focus = this.game.mode === 'walk' ? 0.42 : 0.47;
        this.passes.forEach((p) => {
          p.uniforms.uFocus.value = focus;
          p.uniforms.uBand.value = this.game.mode === 'walk' ? 0.22 : 0.14;
        });
        this.composer!.render();
      };
    } else {
      this.game.renderOverride = null;
    }
  }
}
