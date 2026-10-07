/**
 * Presets de qualidade. 'auto' escolhe pelo dispositivo; o menu permite trocar
 * (aplica na próxima carga para itens de geometria; pós-processamento é imediato).
 */
export type QualityLevel = 'low' | 'medium' | 'high';

export interface QualityPreset {
  level: QualityLevel;
  pixelRatio: number;
  antialias: boolean;
  shadowMap: number;
  normalMaps: boolean;
  anisotropy: number;
  /** oclusão de ambiente em tela (N8AO) */
  ssao: boolean;
  bloom: boolean;
  /** densidade de árvores (0..1) */
  trees: number;
  /** cartões de folhagem por árvore */
  leafCards: number;
  /** distância (m) para trocar prédios pelo LOD simples */
  lodDistance: number;
  npcScale: number;
}

export const PRESETS: Record<QualityLevel, QualityPreset> = {
  low: {
    level: 'low',
    pixelRatio: 1,
    antialias: false,
    shadowMap: 1024,
    normalMaps: false,
    anisotropy: 1,
    ssao: false,
    bloom: false,
    trees: 0.4,
    leafCards: 5,
    lodDistance: 380,
    npcScale: 0.5,
  },
  medium: {
    level: 'medium',
    pixelRatio: 1.5,
    antialias: true,
    shadowMap: 2048,
    normalMaps: true,
    anisotropy: 4,
    ssao: false,
    bloom: false,
    trees: 0.7,
    leafCards: 8,
    lodDistance: 380,
    npcScale: 0.75,
  },
  high: {
    level: 'high',
    pixelRatio: 2,
    antialias: true,
    shadowMap: 2048,
    normalMaps: true,
    anisotropy: 8,
    ssao: true,
    bloom: true,
    trees: 1,
    leafCards: 12,
    lodDistance: 700,
    npcScale: 1,
  },
};

/** nome da GPU (WEBGL_debug_renderer_info), se disponível */
export function gpuName(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl2') as WebGL2RenderingContext | null;
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return '';
  }
}

/** escolha automática: GPU dedicada = alta; integrada = média; celular = média/baixa */
export function autoQuality(mobile: boolean): QualityLevel {
  const gpu = gpuName();
  const integrated = /Intel|UHD|Iris|Vega|Radeon\(TM\) Graphics|Mali|Adreno|PowerVR|SwiftShader|llvmpipe/i.test(gpu);
  if (!mobile) return integrated ? 'medium' : 'high';
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  return mem >= 6 && (navigator.hardwareConcurrency ?? 4) >= 8 ? 'medium' : 'low';
}
