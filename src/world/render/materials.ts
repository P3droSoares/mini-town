import * as THREE from 'three';

/** Uniforms globais compartilhados (atualizados pelo ciclo dia/noite). */
export const worldUniforms = {
  uNight: { value: 0 },
  uLitRatio: { value: 0.5 },
  uTime: { value: 0 },
};

/**
 * Fachada estilo diorama gerada no shader. O layout (vãos de largura fixa
 * centralizados na parede, andares de 3 m) é o mesmo usado em
 * buildingGeometry.ts para posicionar toldos, sacadas e floreiras.
 *
 * Atributos: facade (u, v, altura, seed), style (acabamento rgb, código),
 * aux (comprimento da parede, margem, nº de vãos).
 */
const FACADE_PARS = /* glsl */ `
varying vec4 vFacade;
varying vec4 vStyle;
varying vec4 vAux;
uniform float uNight;
uniform float uLitRatio;
float hash21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
// x = dentro (0/1), y = distância à borda (m, positiva dentro)
vec2 rectSd(vec2 p, vec4 r){ vec2 d = min(p - r.xy, r.zw - p); float e = min(d.x, d.y); return vec2(step(0.0, e), e); }
`;

const FACADE_MAIN = /* glsl */ `
if (vFacade.w > 0.0 && vAux.z > 0.5) {
  float v = vFacade.y;
  float topV = vFacade.z;
  float seed = vFacade.w;
  float code = vStyle.w + 0.01;
  float styleId = floor(code * 0.5);
  float isFront = step(0.5, mod(code, 2.0));
  vec3 trim = vStyle.rgb;
  vec3 frameCol = vec3(0.97, 0.96, 0.93);
  vec2 bump = vec2(0.0);
  float glass = 0.0;
  float litBoost = 0.0;

  float bayW = styleId == 2.0 ? 3.0 : styleId == 3.0 ? 4.0 : styleId == 5.0 ? 3.2 : 2.6;
  float floorH = 3.0;
  float local = vFacade.x - vAux.y;
  float bay = floor(local / bayW);
  float inBays = step(0.0, local) * step(local, vAux.z * bayW - 0.001);
  float fl = floor(v / floorH);
  vec2 lp = vec2(local - bay * bayW, v - fl * floorH);
  vec2 id = vec2(bay, fl);
  float h = hash21(id + vec2(seed * 97.0, seed * 31.0));
  float floorsOk = inBays * step(0.0, v) * step((fl + 1.0) * floorH, topV + 0.3);
  float midBay = floor(vAux.z * 0.5);

  vec4 win = vec4(0.72, 0.95, 1.88, 2.35);                    // casa
  if (styleId == 1.0) win = vec4(0.5, 0.9, 2.1, 2.4);          // comércio (andares)
  if (styleId == 2.0) win = vec4(0.45, 0.8, 2.55, 2.4);        // apartamento
  if (styleId == 5.0) win = vec4(0.35, 0.6, 2.85, 2.6);        // institucional
  if (styleId == 3.0) win = vec4(0.3, 0.0, 3.7, 0.0);          // galpão (faixa no topo)

  bool ground = fl < 0.5;
  bool shop = styleId == 1.0 && isFront > 0.5 && ground;
  bool door = isFront > 0.5 && ground && bay == midBay && (styleId == 0.0 || styleId == 2.0 || styleId == 5.0);
  bool gate = styleId == 3.0 && isFront > 0.5 && ground && mod(bay, 2.0) < 0.5;

  if (floorsOk > 0.5 || (styleId == 3.0 && inBays > 0.5)) {
    if (shop) {
      vec2 r = rectSd(lp, vec4(0.15, 0.12, bayW - 0.15, 2.5));
      if (r.x > 0.5) {
        float mull = 1.0 - step(0.04, abs(lp.x - bayW * 0.5));
        if (r.y < 0.07 || mull > 0.5) diffuseColor.rgb = vec3(0.22, 0.24, 0.27);
        else { glass = 1.0; litBoost = 0.7; }
        if (r.y > 0.07 && r.y < 0.13) bump = normalize(vec2(bayW * 0.5, 1.3) - lp) * 0.7;
      }
    } else if (door) {
      vec2 r = rectSd(lp, vec4(bayW * 0.5 - 0.55, 0.0, bayW * 0.5 + 0.55, 2.3));
      if (r.x > 0.5) {
        diffuseColor.rgb = r.y < 0.08 ? frameCol : trim * 0.85;
        if (r.y > 0.08 && r.y < 0.14) bump = normalize(vec2(bayW * 0.5, 1.15) - lp) * 0.7;
        vec2 pr = rectSd(lp, vec4(bayW * 0.5 - 0.4, 0.25, bayW * 0.5 + 0.4, 2.1));
        if (pr.y > -0.02 && pr.y < 0.04 && r.y > 0.14) bump = normalize(lp - vec2(bayW * 0.5, 1.15)) * 0.5;
      }
    } else if (gate) {
      vec2 r = rectSd(lp, vec4(0.4, 0.0, 3.6, min(3.4, topV - 0.8)));
      if (r.x > 0.5) {
        diffuseColor.rgb = r.y < 0.1 ? vec3(0.95, 0.75, 0.25) : vec3(0.74, 0.77, 0.8);
        bump.y = sin(lp.y * 31.4) * 0.3;
        roughnessFactor = 0.45; metalnessFactor = 0.3;
      }
    } else if (styleId == 3.0) {
      // faixa de janelas altas do galpão
      vec2 r = rectSd(vec2(lp.x, v), vec4(win.x, topV - 1.9, win.z, topV - 0.8));
      if (r.x > 0.5) {
        if (r.y < 0.06 || abs(fract(lp.x / 0.85) - 0.5) > 0.47) diffuseColor.rgb = vec3(0.92);
        else { glass = 1.0; litBoost = -0.2; }
      }
    } else {
      vec2 r = rectSd(lp, win);
      // peitoril
      vec2 sill = rectSd(lp, vec4(win.x - 0.1, win.y - 0.1, win.z + 0.1, win.y));
      if (sill.x > 0.5) { diffuseColor.rgb = frameCol; bump.y = sill.y < 0.03 ? -0.6 : 0.6; }
      // venezianas (casas)
      bool openSh = styleId == 0.0 && h > 0.5;
      vec2 sl = rectSd(lp, vec4(win.x - 0.52, win.y, win.x - 0.02, win.w));
      vec2 sr = rectSd(lp, vec4(win.z + 0.02, win.y, win.z + 0.52, win.w));
      if (openSh && (sl.x > 0.5 || sr.x > 0.5)) {
        diffuseColor.rgb = trim;
        bump.y = sin(lp.y * 50.0) * 0.3;
      }
      if (r.x > 0.5) {
        float fw = styleId == 2.0 ? 0.07 : 0.1;
        if (r.y < fw) {
          diffuseColor.rgb = styleId == 2.0 ? vec3(0.42, 0.46, 0.5) : frameCol;
          if (r.y < 0.03) bump = normalize(lp - (win.xy + win.zw) * 0.5) * 0.6;
        } else if (r.y < fw + 0.07) {
          bump = normalize((win.xy + win.zw) * 0.5 - lp) * 0.8;
          diffuseColor.rgb *= 0.75;
        } else {
          glass = 1.0;
          float mid = (win.x + win.z) * 0.5;
          bool mull = abs(lp.x - mid) < 0.035 || (styleId != 2.0 && abs(lp.y - (win.y + win.w) * 0.5) < 0.03);
          if (styleId == 5.0) mull = mull || abs(fract((lp.x - win.x) / 0.82) - 0.5) > 0.46;
          if (mull) { glass = 0.0; diffuseColor.rgb = styleId == 2.0 ? vec3(0.42, 0.46, 0.5) : frameCol; }
        }
      }
    }
  }

  // barrado colorido das casas
  if (styleId == 0.0 && v < 0.7 && v > -1.5 && glass < 0.5 && !door) {
    diffuseColor.rgb = mix(diffuseColor.rgb, trim, 0.75);
    if (v > 0.64) bump.y = 0.6;
  }
  if (v < 0.0) diffuseColor.rgb *= 0.86;

  if (glass > 0.5) {
    // vidro estilizado: azul-acinzentado com degradê e "cortina" em parte
    float cur = hash21(id + 7.13 + seed);
    vec3 g = mix(vec3(0.24, 0.33, 0.42), vec3(0.47, 0.6, 0.7), smoothstep(0.0, 2.5, lp.y));
    g = mix(g, vec3(0.86, 0.82, 0.74), step(0.78, cur) * 0.6);
    diffuseColor.rgb = g;
    roughnessFactor = 0.12;
    metalnessFactor = 0.35;
    float on = step(1.0 - clamp(uLitRatio + litBoost, 0.0, 1.0), hash21(id + vec2(seed * 97.0, seed * 31.0) + 0.37));
    totalEmissiveRadiance += on * uNight * mix(vec3(1.0, 0.62, 0.28), vec3(1.0, 0.84, 0.58), cur) * (1.1 + max(litBoost, 0.0));
  }

  #ifdef USE_NORMALMAP_TANGENTSPACE
  if (dot(bump, bump) > 0.0001) {
    mat3 tbnF = getTangentFrame(-vViewPosition, nonPerturbedNormal, vFacade.xy);
    normal = normalize(tbnF * normalize(vec3(bump, 1.0)));
  }
  #else
  // sem normal map: perturba com derivadas da posição
  if (dot(bump, bump) > 0.0001) {
    vec3 dpx = dFdx(-vViewPosition);
    vec3 dpy = dFdy(-vViewPosition);
    vec2 dux = dFdx(vFacade.xy);
    vec2 duy = dFdy(vFacade.xy);
    vec3 T = normalize(dpx * duy.y - dpy * dux.y);
    vec3 B = normalize(-dpx * duy.x + dpy * dux.x);
    normal = normalize(T * bump.x + B * bump.y + normal);
  }
  #endif
}
// sombra de contato perto do chão (todas as paredes)
diffuseColor.rgb *= clamp(vFacade.y * 0.25 + 0.8, 0.8, 1.0);
`;

/** Paredes: cor sólida (vertex color) + fachada procedural. */
export function createWallMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = worldUniforms.uNight;
    shader.uniforms.uLitRatio = worldUniforms.uLitRatio;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec4 facade;\nattribute vec4 style;\nattribute vec4 aux;\nvarying vec4 vFacade;\nvarying vec4 vStyle;\nvarying vec4 vAux;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFacade = facade;\nvStyle = style;\nvAux = aux;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FACADE_PARS}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FACADE_MAIN}`);
  };
  m.customProgramCacheKey = () => 'wall-diorama-v1';
  return m;
}

/** Superfícies de cor sólida (telhados, peças, ruas...). */
export function createVertexColorMaterial(opts: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, ...opts });
}
