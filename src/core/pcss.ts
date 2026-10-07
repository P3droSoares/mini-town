import * as THREE from 'three';

/**
 * Sombras PCSS (Percentage-Closer Soft Shadows): contato nítido e penumbra
 * que se alarga com a distância entre oclusor e receptor — o "jeito ray
 * tracing" de sombra macia. Patch global no chunk de sombras do three
 * (deve ser instalado ANTES de compilar os materiais). Requer
 * renderer.shadowMap.type = PCFShadowMap (mapa de profundidade empacotado).
 */
const PCSS = /* glsl */ `
#define PCSS_BLOCKER 12
#define PCSS_FILTER 20
// penumbra em UV por unidade de profundidade normalizada (luz ortográfica)
#define PCSS_SCALE 0.085
#define PCSS_SEARCH 0.0035
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec2 vogel(int i, int n, float phi) {
  float r = sqrt((float(i) + 0.5) / float(n));
  float th = float(i) * 2.39996323 + phi;
  return r * vec2(cos(th), sin(th));
}
float pcssShadow(sampler2D sm, vec2 size, vec4 c) {
  float phi = ign(gl_FragCoord.xy) * 6.2831853;
  // 1) busca de bloqueadores: profundidade média de quem faz sombra
  float sum = 0.0;
  float n = 0.0;
  for (int i = 0; i < PCSS_BLOCKER; i++) {
    float d = unpackRGBAToDepth(texture2D(sm, c.xy + vogel(i, PCSS_BLOCKER, phi) * PCSS_SEARCH));
    if (d < c.z) { sum += d; n += 1.0; }
  }
  if (n < 0.5) return 1.0;
  float blocker = sum / n;
  // 2) penumbra proporcional à distância oclusor -> receptor
  float pen = clamp((c.z - blocker) * PCSS_SCALE, 1.5 / size.x, PCSS_SEARCH * 1.2);
  // 3) filtro PCF com o raio da penumbra
  float s = 0.0;
  for (int i = 0; i < PCSS_FILTER; i++) s += texture2DCompare(sm, c.xy + vogel(i, PCSS_FILTER, phi) * pen, c.z);
  return s / float(PCSS_FILTER);
}
`;

let installed = false;

export function installPCSS() {
  if (installed) return;
  const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  const anchor = 'float getShadow( sampler2D shadowMap,';
  const branch = 'if ( frustumTest ) {';
  if (!chunk.includes(anchor) || !chunk.includes(branch)) {
    console.warn('[pcss] chunk de sombras mudou nesta versão do three — PCSS desativado');
    return;
  }
  // funções antes de getShadow; ramo PCSS logo no início do teste de frustum
  let out = chunk.replace(anchor, `${PCSS}\n\t${anchor}`);
  const at = out.indexOf(branch, out.indexOf(anchor));
  out = `${out.slice(0, at + branch.length)}\n\t\t\tshadow = pcssShadow( shadowMap, shadowMapSize, shadowCoord );\n\t\t\treturn mix( 1.0, shadow, shadowIntensity );\n${out.slice(at + branch.length)}`;
  THREE.ShaderChunk.shadowmap_pars_fragment = out;
  installed = true;
}
