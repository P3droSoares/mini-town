import * as THREE from 'three';

/** Uniforms globais compartilhados (atualizados pelo ciclo dia/noite). */
export const worldUniforms = {
  uNight: { value: 0 },
  uLitRatio: { value: 0.5 },
  uTime: { value: 0 },
};

/**
 * Material dos prédios: cor por vértice + janelas procedurais no shader
 * (grade por andar/vão a partir do atributo `facade`). À noite parte das
 * janelas acende (emissivo), sem nenhuma luz real — custo ~zero.
 */
export function createBuildingMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = worldUniforms.uNight;
    shader.uniforms.uLitRatio = worldUniforms.uLitRatio;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 facade;\nvarying vec4 vFacade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFacade = facade;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec4 vFacade;
uniform float uNight;
uniform float uLitRatio;
float hash21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
if (vFacade.w > 0.0) {
  // escurece levemente a base (oclusão barata)
  float ao = clamp(vFacade.y * 0.35 + 0.72, 0.72, 1.0);
  diffuseColor.rgb *= ao;
  vec2 cell = vec2(vFacade.x / 2.9, vFacade.y / 3.0);
  vec2 id = floor(cell);
  vec2 f = fract(cell);
  float inWin = step(0.27, f.x) * step(f.x, 0.73) * step(0.33, f.y) * step(f.y, 0.8);
  inWin *= step(0.0, vFacade.y) * step(vFacade.y, vFacade.z - 0.6);
  float frame = inWin * (1.0 - step(0.31, f.x) * step(f.x, 0.69) * step(0.37, f.y) * step(f.y, 0.76));
  float glass = inWin - frame;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.97, 0.96, 0.92), frame * 0.8);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.20, 0.26, 0.32), glass * 0.9);
  float h = hash21(id + vec2(vFacade.w * 97.0, vFacade.w * 31.0));
  float lit = glass * step(1.0 - uLitRatio, h) * uNight;
  totalEmissiveRadiance += lit * mix(vec3(1.0, 0.72, 0.38), vec3(1.0, 0.92, 0.72), fract(h * 7.0)) * 1.4;
}`,
      );
  };
  m.customProgramCacheKey = () => 'building-facade-v1';
  return m;
}

export function createVertexColorMaterial(opts: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, ...opts });
}
