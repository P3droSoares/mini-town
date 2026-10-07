import * as THREE from 'three';
import type { LayerAtlas, TexKey, TextureLibrary } from './textures';

/** Uniforms globais compartilhados (atualizados pelo ciclo dia/noite). */
export const worldUniforms = {
  uNight: { value: 0 },
  uLitRatio: { value: 0.5 },
  uTime: { value: 0 },
  /** direção (mundo) para o sol/lua e cor x intensidade da luz direta */
  uSunDirW: { value: new THREE.Vector3(0, 1, 0) },
  uSunCol: { value: new THREE.Color(1, 1, 1) },
};

/** camadas do atlas que recebem a cor do vértice (paredes pintadas etc.) */
export const TINTABLE_LAYERS = [0, 3, 4, 7, 11, 12, 13];

/**
 * Material único dos prédios (paredes e peças):
 *  1) cor do vértice x camada do atlas PBR (aux.w); camadas tingíveis são
 *     normalizadas pela cor média (textura só dá o detalhe)
 *  2) normal da textura (base tangente por derivadas — sem atributo tangent)
 *  3) fachada procedural: janelas, portas, vitrines, portões, cortina de vidro
 *     — layout por vão (mesmo de buildingGeometry.ts)
 *  4) vidro com INTERIOR FALSO (interior mapping): cômodo com paredes, piso,
 *     teto e quadro atrás do vidro, com paralaxe real; acende à noite
 */
const PARS = /* glsl */ `
varying vec4 vFacade;
varying vec4 vStyle;
varying vec4 vAux;
varying vec2 vUvM;
varying vec3 vWPos;
uniform float uNight;
uniform float uLitRatio;
#ifdef USE_ATLAS
uniform highp sampler2DArray uAtlas;
uniform highp sampler2DArray uAtlasN;
uniform vec3 uLayerNorm[${16}];
uniform float uLayerScale[${16}];
uniform float uLayerTint[${16}];
#endif
float hash21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vnoise2(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash21(i), hash21(i+vec2(1,0)), u.x), mix(hash21(i+vec2(0,1)), hash21(i+vec2(1,1)), u.x), u.y); }
float grime(vec3 p){ return vnoise2(p.xz * 0.11 + p.y * 0.21) * 0.6 + vnoise2(p.xz * 0.47 - p.y * 0.9) * 0.4; }
vec2 rectSd(vec2 p, vec4 r){ vec2 d = min(p - r.xy, r.zw - p); float e = min(d.x, d.y); return vec2(step(0.0, e), e); }
// base tangente (T, B, N) por derivadas para um par de coordenadas
mat3 tbnOf(vec2 st, vec3 N) {
  vec3 q0 = dFdx(-vViewPosition);
  vec3 q1 = dFdy(-vViewPosition);
  vec2 st0 = dFdx(st);
  vec2 st1 = dFdy(st);
  vec3 q1p = cross(q1, N);
  vec3 q0p = cross(N, q0);
  vec3 T = q1p * st0.x + q0p * st1.x;
  vec3 B = q1p * st0.y + q0p * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float s = det == 0.0 ? 0.0 : inversesqrt(det);
  return mat3(T * s, B * s, N);
}
`;

const MAIN = /* glsl */ `
vec3 geoN = normalize(nonPerturbedNormal);
{
  // desgaste: manchas grandes em tudo; lajes/telhados encardidos
  vec3 wn = normalize(cross(dFdx(vWPos), dFdy(vWPos)));
  float g = grime(vWPos);
  diffuseColor.rgb *= 0.82 + 0.2 * g;
  if (abs(wn.y) > 0.75) {
    float st = smoothstep(0.25, 0.75, vnoise2(vWPos.xz * 0.35) * 0.7 + vnoise2(vWPos.xz * 1.7) * 0.3);
    diffuseColor.rgb *= mix(0.6, 1.0, st);
  }
}
#ifdef USE_ATLAS
{
  float lay = vAux.w - 1.0;
  if (lay > -0.5) {
    int li = int(lay + 0.5);
    vec2 auv = vUvM * uLayerScale[li];
    vec3 tex = texture(uAtlas, vec3(auv, lay)).rgb;
    if (uLayerTint[li] > 0.5) {
      tex /= max(uLayerNorm[li], vec3(0.02));
      // reboco: textura só dá leve relevo (manchas fortes pareciam sujeira)
      if (li == 0) tex = mix(vec3(1.0), tex, 0.45);
    }
    else tex *= 1.25;
    diffuseColor.rgb *= tex;
    vec3 nt = texture(uAtlasN, vec3(auv, lay)).xyz * 2.0 - 1.0;
    mat3 tb = tbnOf(auv, geoN);
    normal = normalize(tb * vec3(nt.xy * 0.9, nt.z));
  }
}
#endif

if (vFacade.w > 0.0 && vAux.z > 0.5) {
  float v = vFacade.y;
  float topV = vFacade.z;
  float seed = vFacade.w;
  float code = vStyle.w + 0.01;
  float styleId = floor(code * 0.5);
  float isFront = step(0.5, mod(code, 2.0));
  vec3 trim = vStyle.rgb;
  vec3 frameCol = vec3(0.93, 0.92, 0.89);
  vec2 bump = vec2(0.0);
  float glass = 0.0;
  float litBoost = 0.0;
  float curtainWall = 0.0;

  // largura do vão por estilo (igual a BAY em buildingGeometry.ts)
  float bayW = 2.6;
  if (styleId == 2.0 || styleId == 4.0 || styleId == 9.0) bayW = 3.0;
  if (styleId == 3.0 || styleId == 7.0) bayW = 4.0;
  if (styleId == 5.0) bayW = 3.2;
  if (styleId == 6.0) bayW = 1.6;
  if (styleId == 8.0) bayW = 2.4;
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

  vec4 win = vec4(0.72, 0.95, 1.88, 2.35);
  if (styleId == 1.0) win = vec4(0.45, 0.9, 2.15, 2.45);
  if (styleId == 2.0) win = vec4(0.45, 0.8, 2.55, 2.4);
  if (styleId == 5.0) win = vec4(0.35, 0.6, 2.85, 2.6);
  if (styleId == 3.0) win = vec4(0.3, 0.0, 3.7, 0.0);
  if (styleId == 7.0) win = vec4(0.3, 0.6, 3.7, 2.5);
  if (styleId == 8.0) win = vec4(0.62, 0.9, 1.78, 2.4);
  if (styleId == 9.0) win = vec4(0.55, 0.85, 2.45, 2.3);

  bool ground = fl < 0.5;
  bool shop = (styleId == 1.0 || styleId == 6.0) && isFront > 0.5 && ground;
  bool door = isFront > 0.5 && ground && bay == midBay && (styleId == 0.0 || styleId == 2.0 || styleId == 5.0 || styleId == 7.0 || styleId == 8.0 || styleId == 9.0);
  bool gate = styleId == 3.0 && isFront > 0.5 && ground && mod(bay, 2.0) < 0.5;

  if (floorsOk > 0.5 || (styleId == 3.0 && inBays > 0.5)) {
    if (shop) {
      vec2 r = rectSd(lp, vec4(0.1, 0.1, bayW - 0.1, 2.6));
      if (r.x > 0.5) {
        float mull = 1.0 - step(0.035, abs(lp.x - bayW * 0.5));
        if (r.y < 0.06 || mull > 0.5) { diffuseColor.rgb = vec3(0.16, 0.17, 0.19); roughnessFactor = 0.35; metalnessFactor = 0.7; }
        else { glass = 1.0; litBoost = 0.7; }
      }
    } else if (styleId == 6.0) {
      // cortina de vidro: montantes verticais e faixas de laje (spandrel)
      float mv = step(lp.x, 0.07) + step(bayW - 0.07, lp.x);
      float sp = step(lp.y, 0.45);
      if (mv > 0.5) { diffuseColor.rgb = vec3(0.55, 0.58, 0.62); metalnessFactor = 0.7; roughnessFactor = 0.3; }
      else if (sp > 0.5) { diffuseColor.rgb = trim * 0.5 + 0.08; metalnessFactor = 0.4; roughnessFactor = 0.25; }
      else { glass = 1.0; curtainWall = 1.0; }
    } else if (door) {
      vec2 r = rectSd(lp, vec4(bayW * 0.5 - 0.55, 0.0, bayW * 0.5 + 0.55, 2.3));
      if (r.x > 0.5) {
        diffuseColor.rgb = r.y < 0.08 ? frameCol : mix(trim, vec3(0.3, 0.2, 0.13), 0.5);
        if (r.y > 0.08 && r.y < 0.14) bump = normalize(vec2(bayW * 0.5, 1.15) - lp) * 0.7;
        vec2 pr = rectSd(lp, vec4(bayW * 0.5 - 0.4, 0.25, bayW * 0.5 + 0.4, 2.1));
        if (pr.y > -0.02 && pr.y < 0.04 && r.y > 0.14) bump = normalize(lp - vec2(bayW * 0.5, 1.15)) * 0.5;
        roughnessFactor = 0.6;
      }
    } else if (gate) {
      vec2 r = rectSd(lp, vec4(0.4, 0.0, 3.6, min(3.4, topV - 0.8)));
      if (r.x > 0.5) {
        diffuseColor.rgb = r.y < 0.1 ? vec3(0.85, 0.65, 0.2) : vec3(0.62, 0.65, 0.68);
        bump.y = sin(lp.y * 31.4) * 0.3;
        roughnessFactor = 0.45; metalnessFactor = 0.5;
      }
    } else if (styleId == 3.0) {
      vec2 r = rectSd(vec2(lp.x, v), vec4(win.x, topV - 1.9, win.z, topV - 0.8));
      if (r.x > 0.5) {
        if (r.y < 0.06 || abs(fract(lp.x / 0.85) - 0.5) > 0.47) diffuseColor.rgb = vec3(0.7);
        else { glass = 1.0; litBoost = -0.25; }
      }
    } else {
      vec2 r = rectSd(lp, win);
      // verga de pedra (prédios de tijolo) / peitoril
      if (styleId == 8.0) {
        vec2 lin = rectSd(lp, vec4(win.x - 0.12, win.w, win.z + 0.12, win.w + 0.22));
        if (lin.x > 0.5) { diffuseColor.rgb = vec3(0.8, 0.77, 0.7); bump.y = lin.y < 0.03 ? 0.6 : 0.0; }
      }
      vec2 sill = rectSd(lp, vec4(win.x - 0.1, win.y - 0.1, win.z + 0.1, win.y));
      if (sill.x > 0.5 && styleId != 7.0) { diffuseColor.rgb = frameCol; bump.y = sill.y < 0.03 ? -0.6 : 0.6; }
      bool openSh = styleId == 0.0 && h > 0.5;
      vec2 sl = rectSd(lp, vec4(win.x - 0.52, win.y, win.x - 0.02, win.w));
      vec2 sr = rectSd(lp, vec4(win.z + 0.02, win.y, win.z + 0.52, win.w));
      if (openSh && (sl.x > 0.5 || sr.x > 0.5)) {
        diffuseColor.rgb = trim;
        bump.y = sin(lp.y * 50.0) * 0.3;
        roughnessFactor = 0.7;
      }
      if (r.x > 0.5) {
        float fw = styleId == 2.0 || styleId == 9.0 || styleId == 7.0 ? 0.06 : 0.09;
        vec3 fc = styleId == 0.0 ? frameCol : styleId == 7.0 ? vec3(0.12, 0.12, 0.13) : vec3(0.78, 0.79, 0.8);
        if (r.y < fw) {
          diffuseColor.rgb = fc;
          roughnessFactor = 0.45;
          if (r.y < 0.025) bump = normalize(lp - (win.xy + win.zw) * 0.5) * 0.6;
        } else if (r.y < fw + 0.08) {
          bump = normalize((win.xy + win.zw) * 0.5 - lp) * 0.85;
          diffuseColor.rgb *= 0.7;
        } else {
          glass = 1.0;
          float mid = (win.x + win.z) * 0.5;
          bool mull = abs(lp.x - mid) < 0.03 || (styleId == 0.0 && abs(lp.y - (win.y + win.w) * 0.5) < 0.025);
          if (styleId == 5.0) mull = mull || abs(fract((lp.x - win.x) / 0.82) - 0.5) > 0.46;
          bool closedSh = styleId == 0.0 && h > 0.42 && h < 0.5;
          if (closedSh) { glass = 0.0; diffuseColor.rgb = trim * 0.9; bump.y = sin(lp.y * 50.0) * 0.3; }
          else if (mull) { glass = 0.0; diffuseColor.rgb = fc; }
        }
      }
    }
  }

  // escorrimento sob os peitoris e da platibanda (fachadas envelhecidas)
  if (glass < 0.5 && styleId != 6.0) {
    float colN = hash21(vec2(floor(local * 3.0), seed * 11.0));
    float inWinX = step(win.x - 0.05, lp.x) * step(lp.x, win.z + 0.05);
    float below = clamp(1.0 - (win.y - lp.y) / 1.6, 0.0, 1.0) * step(lp.y, win.y);
    float streak = inWinX * below * (0.35 + 0.65 * colN) * floorsOk;
    float drip = smoothstep(topV - 3.2, topV - 0.2, v) * (0.4 + 0.6 * hash21(vec2(floor(local * 2.3), 7.0)));
    diffuseColor.rgb *= 1.0 - 0.24 * streak - 0.16 * drip;
  }
  // barrado das casas coloniais
  if (styleId == 0.0 && v < 0.7 && v > -1.5 && glass < 0.5 && !door) {
    diffuseColor.rgb = mix(diffuseColor.rgb, trim * 0.9, 0.8);
    if (v > 0.64) bump.y = 0.6;
  }
  if (v < 0.0) diffuseColor.rgb *= 0.8;

  mat3 tf = tbnOf(vFacade.xy, geoN);
  if (glass > 0.5) {
    // ---- interior mapping: raio da câmera para dentro de um cômodo
    vec3 T = normalize(tf[0]);
    vec3 B = normalize(tf[1]);
    vec3 vd = normalize(vViewPosition);
    vec3 rd = -vec3(dot(vd, T), dot(vd, B), dot(vd, geoN));
    rd.z = min(rd.z, -0.05);
    float depth = curtainWall > 0.5 ? 5.0 : 3.6;
    vec3 ro = vec3(lp.x, lp.y, 0.0);
    float tx = rd.x > 0.0 ? (bayW - ro.x) / max(rd.x, 1e-4) : -ro.x / min(rd.x, -1e-4);
    float ty = rd.y > 0.0 ? (floorH - ro.y) / max(rd.y, 1e-4) : -ro.y / min(rd.y, -1e-4);
    float tz = -depth / rd.z;
    float t = min(min(tx, ty), tz);
    vec3 hp = ro + rd * t;
    float rh = hash21(id + 7.13 + seed);
    vec3 wallC = mix(vec3(0.86, 0.82, 0.74), vec3(0.72, 0.8, 0.84), step(0.5, rh));
    wallC = mix(wallC, vec3(0.9, 0.78, 0.7), step(0.8, rh));
    vec3 room;
    if (t == tz) {
      room = wallC * 0.92;
      // quadro / estante na parede do fundo
      vec2 q = rectSd(hp.xy, vec4(bayW * 0.3, 1.1, bayW * 0.7, 1.9));
      if (q.x > 0.5 && rh > 0.3) room = mix(vec3(0.3, 0.42, 0.55), vec3(0.6, 0.35, 0.25), fract(rh * 9.0));
      vec2 sofa = rectSd(hp.xy, vec4(bayW * 0.15, 0.0, bayW * 0.85, 0.75));
      if (sofa.x > 0.5 && rh < 0.6) room = mix(vec3(0.35, 0.3, 0.28), vec3(0.25, 0.35, 0.45), fract(rh * 5.0));
    } else if (t == ty) {
      room = rd.y > 0.0 ? vec3(0.92) : mix(vec3(0.42, 0.3, 0.2), vec3(0.6, 0.58, 0.55), step(0.55, rh));
    } else {
      room = wallC * 0.78;
    }
    room *= mix(1.0, 0.55, clamp(-hp.z / depth, 0.0, 1.0));
    // persianas/cortinas descendo do alto
    float blind = (0.15 + 0.6 * fract(rh * 13.0)) * step(0.35, fract(rh * 3.7));
    float wtop = curtainWall > 0.5 ? floorH : win.w;
    float wbot = curtainWall > 0.5 ? 0.45 : win.y;
    bool inBlind = lp.y > wtop - blind * (wtop - wbot);
    if (inBlind) room = mix(vec3(0.82, 0.8, 0.74), vec3(0.6, 0.55, 0.5), step(0.7, rh)) * (0.85 + 0.15 * step(0.5, fract(lp.y * 18.0)));
    float on = step(1.0 - clamp(uLitRatio + litBoost, 0.0, 1.0), hash21(id + vec2(seed * 97.0, seed * 31.0) + 0.37));
    // dia: interior escuro sob o reflexo; noite: luz quente se aceso
    diffuseColor.rgb = room * mix(0.42, 0.06, uNight);
    roughnessFactor = 0.04;
    metalnessFactor = 0.15;
    totalEmissiveRadiance += on * uNight * room * vec3(1.15, 0.86, 0.6) * (1.3 + max(litBoost, 0.0)) * (inBlind ? 0.7 : 1.0);
  }

  if (dot(bump, bump) > 0.0001) normal = normalize(tf * normalize(vec3(bump, 1.0)));
}
// sombra de contato perto do chão
diffuseColor.rgb *= clamp(vFacade.y * 0.25 + 0.8, 0.8, 1.0);
`;

/** Material dos prédios (paredes e peças), com atlas PBR opcional. */
export function createBuildingMaterial(atlas: LayerAtlas | null): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
  if (atlas) m.defines = { USE_ATLAS: '' };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = worldUniforms.uNight;
    shader.uniforms.uLitRatio = worldUniforms.uLitRatio;
    if (atlas) {
      const pad = <T>(arr: T[], fill: T) => Array.from({ length: 16 }, (_, i) => arr[i] ?? fill);
      shader.uniforms.uAtlas = { value: atlas.albedo };
      shader.uniforms.uAtlasN = { value: atlas.normal };
      shader.uniforms.uLayerNorm = { value: pad(atlas.avg, new THREE.Vector3(1, 1, 1)) };
      shader.uniforms.uLayerScale = { value: pad(atlas.scale, 1) };
      shader.uniforms.uLayerTint = { value: pad(atlas.scale.map((_, i) => (TINTABLE_LAYERS.includes(i) ? 1 : 0)), 0) };
    }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec4 facade;\nattribute vec4 style;\nattribute vec4 aux;\nvarying vec4 vFacade;\nvarying vec4 vStyle;\nvarying vec4 vAux;\nvarying vec2 vUvM;\nvarying vec3 vWPos;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvFacade = facade;\nvStyle = style;\nvAux = aux;\nvUvM = uv;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PARS}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${MAIN}`);
  };
  m.customProgramCacheKey = () => `building-v4-${!!atlas}`;
  return m;
}

/** Superfície texturizada (ruas, calçadas): textura normalizada x vertex color. */
export function createTexturedMaterial(tex: TextureLibrary, key: TexKey, normalScale = 1, extra: THREE.MeshStandardMaterialParameters = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, ...extra });
  return tex.apply(m, key, normalScale, true);
}

/** Letreiros/outdoors: atlas em canvas, acende à noite (emissivo). */
export function createSignMaterial(map: THREE.Texture) {
  const m = new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: '#ffffff', emissiveIntensity: 0, roughness: 0.45, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = worldUniforms.uNight;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= uNight * 0.9;');
  };
  m.emissiveIntensity = 1;
  m.customProgramCacheKey = () => 'sign-v1';
  return m;
}

/** Superfícies de cor sólida (peças sem textura). */
export function createVertexColorMaterial(opts: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, ...opts });
}
