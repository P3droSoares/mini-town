import * as THREE from 'three';
import type { TexKey, TextureLibrary } from './textures';

/** Uniforms globais compartilhados (atualizados pelo ciclo dia/noite). */
export const worldUniforms = {
  uNight: { value: 0 },
  uLitRatio: { value: 0.5 },
  uTime: { value: 0 },
};

/**
 * Elementos de fachada gerados no shader a partir do atributo `facade`
 * (u, v em metros) e `style` (cor de acabamento + tipo). Nenhuma geometria
 * extra por janela: o relevo vem da normal perturbada e o vidro reflete o
 * céu (IBL) por ter rugosidade baixa.
 */
const FACADE_PARS = /* glsl */ `
varying vec4 vFacade;
varying vec4 vStyle;
uniform float uNight;
uniform float uLitRatio;
float hash21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
// x = dentro (0/1), y = distância à borda (m, positiva dentro)
vec2 rectSd(vec2 p, vec4 r){ vec2 d = min(p - r.xy, r.zw - p); float e = min(d.x, d.y); return vec2(step(0.0, e), e); }
`;

const FACADE_MAIN = /* glsl */ `
if (vFacade.w > 0.0) {
  float u = vFacade.x;
  float v = vFacade.y;
  float topV = vFacade.z;
  float seed = vFacade.w;
  float code = vStyle.w + 0.01;
  float styleId = floor(code * 0.5);
  float isFront = step(0.5, mod(code, 2.0));
  vec3 trim = vStyle.rgb;
  vec3 frameCol = vec3(0.95, 0.93, 0.88);
  vec2 bump = vec2(0.0);
  float glass = 0.0;
  float litBoost = 0.0;

  float bayW = styleId == 2.0 ? 3.0 : styleId == 3.0 ? 4.0 : 2.6;
  float floorH = 3.0;
  vec2 cell = vec2(u / bayW, v / floorH);
  vec2 id = floor(cell);
  vec2 lp = fract(cell) * vec2(bayW, floorH);
  float h = hash21(id + vec2(seed * 97.0, seed * 31.0));
  float floorsOk = step(0.0, v) * step((id.y + 1.0) * floorH, topV + 0.3);

  vec4 win = vec4(0.75, 0.95, 1.85, 2.35);     // casa colonial
  if (styleId == 2.0) win = vec4(0.45, 0.9, 2.55, 2.35);   // apartamento: janela larga
  if (styleId == 1.0) win = vec4(0.55, 0.95, 2.05, 2.4);
  if (styleId == 3.0) win = vec4(0.4, 1.8, 3.6, 2.5);      // galpão: faixa alta

  bool groundFloor = id.y < 0.5;
  bool shopFront = styleId == 1.0 && isFront > 0.5 && groundFloor;
  bool door = !shopFront && isFront > 0.5 && groundFloor && h < (styleId == 0.0 ? 0.28 : 0.18) && styleId != 3.0;
  bool gate = styleId == 3.0 && isFront > 0.5 && groundFloor && h < 0.5;

  if (floorsOk > 0.5) {
    if (shopFront) {
      // vitrine + letreiro
      vec2 r = rectSd(lp, vec4(0.2, 0.15, bayW - 0.2, 2.65));
      if (r.x > 0.5) {
        float mull = 1.0 - step(0.05, abs(lp.x - bayW * 0.5));
        if (r.y < 0.07 || mull > 0.5) { diffuseColor.rgb = vec3(0.18, 0.19, 0.2); roughnessFactor = 0.4; metalnessFactor = 0.6; }
        else { glass = 1.0; litBoost = 0.6; }
      }
      vec2 sgn = rectSd(lp, vec4(0.0, 2.8, bayW, 3.4));
      if (sgn.x > 0.5) {
        float hs = hash21(vec2(floor(u / 9.0), seed * 13.0));
        vec3 sc = 0.5 + 0.5 * cos(6.2831 * (hs + vec3(0.0, 0.33, 0.67)));
        diffuseColor.rgb = mix(sc, vec3(0.96), step(0.6, hash21(vec2(hs, 3.0)))) ;
        roughnessFactor = 0.45;
        bump.y = sgn.y < 0.05 ? (lp.y < 3.1 ? -0.6 : 0.6) : 0.0;
        totalEmissiveRadiance += diffuseColor.rgb * uNight * 0.35;
      }
    } else if (door) {
      vec2 r = rectSd(lp, vec4(0.75, 0.0, 1.85, 2.45));
      if (r.x > 0.5) {
        diffuseColor.rgb = r.y < 0.08 ? frameCol : mix(trim, vec3(0.32, 0.2, 0.12), 0.45);
        // almofadas da porta
        vec2 pr = rectSd(lp, vec4(0.92, 0.2, 1.68, 2.25));
        if (r.y > 0.08 && pr.y < 0.05 && pr.y > -0.02) bump = normalize(lp - vec2(1.3, 1.2)) * 0.5;
        if (r.y < 0.14 && r.y > 0.08) bump = normalize(vec2(1.3, 1.2) - lp) * 0.7;
        roughnessFactor = 0.6;
      }
    } else if (gate) {
      vec2 r = rectSd(lp, vec4(0.4, 0.0, 3.6, 3.0));
      if (r.x > 0.5) {
        diffuseColor.rgb = vec3(0.55, 0.57, 0.58);
        bump.y = sin(lp.y * 31.4) * 0.35;
        metalnessFactor = 0.5; roughnessFactor = 0.5;
      }
    } else {
      vec2 r = rectSd(lp, win);
      // peitoril
      vec2 sill = rectSd(lp, vec4(win.x - 0.1, win.y - 0.12, win.z + 0.1, win.y));
      if (sill.x > 0.5 && styleId != 3.0) { diffuseColor.rgb = frameCol; bump.y = sill.y < 0.03 ? -0.6 : 0.5; }
      // venezianas abertas (casas)
      bool openSh = styleId == 0.0 && h > 0.55;
      vec2 sl = rectSd(lp, vec4(win.x - 0.55, win.y, win.x, win.w));
      vec2 sr = rectSd(lp, vec4(win.z, win.y, win.z + 0.55, win.w));
      if (openSh && (sl.x > 0.5 || sr.x > 0.5)) {
        diffuseColor.rgb = trim * 0.9;
        bump.y = sin(lp.y * 60.0) * 0.35;
        roughnessFactor = 0.7;
      }
      if (r.x > 0.5) {
        float fw = styleId == 3.0 ? 0.05 : 0.08;
        if (r.y < fw) {
          diffuseColor.rgb = styleId == 0.0 ? frameCol : vec3(0.75, 0.76, 0.78);
          roughnessFactor = 0.5;
        } else if (r.y < fw + 0.07) {
          // recuo da janela (vão na parede)
          vec2 c = (win.xy + win.zw) * 0.5;
          bump = normalize(c - lp) * 0.75;
          diffuseColor.rgb *= 0.7;
        } else {
          bool closedSh = styleId == 0.0 && h > 0.4 && h < 0.5;
          if (closedSh) {
            diffuseColor.rgb = trim * 0.85;
            bump.y = sin(lp.y * 60.0) * 0.35;
          } else {
            glass = 1.0;
            // caixilho no meio (janelas de 2 folhas)
            float mid = (win.x + win.z) * 0.5;
            if (abs(lp.x - mid) < 0.03 || (styleId == 0.0 && abs(lp.y - (win.y + win.w) * 0.5) < 0.025)) {
              glass = 0.0;
              diffuseColor.rgb = styleId == 0.0 ? frameCol : vec3(0.7);
            }
          }
        }
      }
    }
  }

  // barrado colonial e cornija
  if (styleId == 0.0 && v < 0.75 && v > -0.5 && glass < 0.5) {
    diffuseColor.rgb = mix(diffuseColor.rgb, trim * 0.85, 0.85);
    if (v > 0.68) bump.y = 0.6;
  }
  if ((styleId == 0.0 || styleId == 1.0 || styleId == 2.0) && v > topV - 0.4) {
    diffuseColor.rgb = mix(diffuseColor.rgb, frameCol, 0.8);
    bump.y = v > topV - 0.15 ? 0.5 : -0.55;
  }
  // lajes aparentes em prédios
  if (styleId == 2.0 && glass < 0.5 && mod(v, floorH) < 0.2 && v > 2.0) {
    diffuseColor.rgb *= 1.06;
    bump.y = mod(v, floorH) < 0.04 ? -0.6 : 0.0;
  }
  // embasamento abaixo do solo (terrenos inclinados)
  if (v < 0.0) diffuseColor.rgb *= vec3(0.78, 0.76, 0.74);

  if (glass > 0.5) {
    float cur = hash21(id + 7.13 + seed);
    diffuseColor.rgb = mix(vec3(0.04, 0.05, 0.06), vec3(0.42, 0.36, 0.3), step(0.7, cur) * 0.5);
    roughnessFactor = 0.05;
    metalnessFactor = 0.55;
    float on = step(1.0 - min(1.0, uLitRatio + litBoost), hash21(id + vec2(seed * 97.0, seed * 31.0) + 0.37));
    totalEmissiveRadiance += on * uNight * mix(vec3(1.0, 0.58, 0.24), vec3(1.0, 0.82, 0.55), cur) * (0.85 + litBoost);
  }

  // sombra de contato perto do chão
  diffuseColor.rgb *= clamp(v * 0.3 + 0.75, 0.7, 1.0);

  #ifdef USE_NORMALMAP_TANGENTSPACE
  if (dot(bump, bump) > 0.0001) {
    mat3 tbnF = getTangentFrame(-vViewPosition, nonPerturbedNormal, vFacade.xy);
    normal = normalize(tbnF * normalize(vec3(bump, 1.0)));
  }
  #endif
}
`;

/** Paredes: reboco PBR tingido pelo vertex color + fachada procedural. */
export function createWallMaterial(tex: TextureLibrary): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  tex.apply(m, 'plaster', 0.6, true);
  m.aoMapIntensity = 0.4;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = worldUniforms.uNight;
    shader.uniforms.uLitRatio = worldUniforms.uLitRatio;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 facade;\nattribute vec4 style;\nvarying vec4 vFacade;\nvarying vec4 vStyle;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFacade = facade;\nvStyle = style;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FACADE_PARS}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FACADE_MAIN}`);
  };
  m.customProgramCacheKey = () => 'wall-facade-v2';
  return m;
}

/** Telhados/superfícies texturizadas simples (telha, concreto...). */
export function createTexturedMaterial(tex: TextureLibrary, key: TexKey, normalScale = 1, extra: THREE.MeshStandardMaterialParameters = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, ...extra });
  return tex.apply(m, key, normalScale, true);
}

export function createVertexColorMaterial(opts: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, ...opts });
}
