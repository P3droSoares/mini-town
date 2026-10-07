import { BlendFunction, Effect } from 'postprocessing';
import * as THREE from 'three';

/**
 * Gradação de cor "cinematográfica" (aplicada depois do tone mapping):
 * split toning (sombras frias, luzes quentes douradas), curva S suave,
 * verdes menos saturados e leve "haze" quente nos médios — o visual de
 * fim de tarde dos city builders AAA.
 */
const FRAG = /* glsl */ `
uniform float uWarmth;
uniform float uContrast;
uniform float uGreenDesat;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // split toning
  vec3 shadowTint = vec3(0.93, 0.98, 1.05);
  vec3 highTint = vec3(1.0 + 0.09 * uWarmth, 1.0 + 0.015 * uWarmth, 1.0 - 0.11 * uWarmth);
  c *= mix(shadowTint, highTint, smoothstep(0.12, 0.8, l));
  // verdes muito vivos ficam oliva
  float green = clamp((c.g - max(c.r, c.b)) * 4.0, 0.0, 1.0);
  c = mix(c, vec3(l) * vec3(1.02, 1.0, 0.92), green * uGreenDesat);
  // curva S (contraste nos médios, preserva extremos)
  vec3 s = c * c * (3.0 - 2.0 * c);
  c = mix(c, s, uContrast);
  outputColor = vec4(clamp(c, 0.0, 1.0), inputColor.a);
}
`;

export class GradeEffect extends Effect {
  constructor({ warmth = 1, contrast = 0.35, greenDesat = 0.35 } = {}) {
    super('GradeEffect', FRAG, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['uWarmth', new THREE.Uniform(warmth)],
        ['uContrast', new THREE.Uniform(contrast)],
        ['uGreenDesat', new THREE.Uniform(greenDesat)],
      ]),
    });
  }

  set warmth(v: number) {
    this.uniforms.get('uWarmth')!.value = v;
  }
}
