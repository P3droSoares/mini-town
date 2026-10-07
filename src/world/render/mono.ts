import * as THREE from 'three';
import { MONO, MONO_COLOR, MONO_LIGHT } from './style';

const glsl = (c: THREE.Color) => `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})`;

/** cor base em espaço linear (escala preserva o matiz) */
export const monoLinear = new THREE.Color(MONO_COLOR);
export const monoLight = new THREE.Color(MONO_LIGHT);

/**
 * Modo monocromático. Remenda o chunk de emissivo (roda depois que o albedo
 * de todo material padrão foi calculado e antes da iluminação):
 *  - albedo = cor base x luminosidade da cor original (paredes claras ficam
 *    claras, asfalto escuro fica escuro — mesma cor, outros tons)
 *  - todo emissivo vira amarelo, mantendo a intensidade
 * Chamar antes de compilar qualquer material.
 */
export function installMono() {
  if (!MONO) return;
  const base = glsl(monoLinear);
  const light = glsl(monoLight);
  THREE.ShaderChunk.emissivemap_fragment += `
{
  float monoL = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  diffuseColor.rgb = ${base} * (1.1 + 4.6 * monoL);
  float monoE = dot(totalEmissiveRadiance, vec3(0.299, 0.587, 0.114));
  totalEmissiveRadiance = ${light} * monoE * 1.6;
}
`;
}

/** mapeia uma cor de céu/névoa para o tom monocromático, preservando a luminosidade */
export const MONO_SKY_GLSL = () => `
{
  float monoL = dot(col, vec3(0.299, 0.587, 0.114));
  col = ${glsl(monoLinear)} * (0.9 + 3.2 * monoL);
}
`;
