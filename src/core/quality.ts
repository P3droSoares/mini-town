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
    bloom: true,
    trees: 0.7,
    leafCards: 8,
    lodDistance: 520,
    npcScale: 0.75,
  },
  high: {
    level: 'high',
    pixelRatio: 2,
    antialias: true,
    shadowMap: 4096,
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

/** escolha automática: celular = low/medium, desktop = high */
export function autoQuality(mobile: boolean): QualityLevel {
  if (!mobile) return 'high';
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  return mem >= 6 && (navigator.hardwareConcurrency ?? 4) >= 8 ? 'medium' : 'low';
}
