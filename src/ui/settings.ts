/** Preferências locais do jogador (por navegador). */
export interface Settings {
  /** preset de qualidade ('auto' = pelo dispositivo) */
  quality: 'auto' | 'low' | 'medium' | 'high';
  tiltShift: boolean;
  shadows: boolean;
  showFps: boolean;
  /** 0..1 multiplica a quantidade de carros/pedestres */
  npcDensity: number;
}

const KEY = 'mini-town:settings:v1';

export const defaultSettings = (mobile: boolean): Settings => ({
  quality: 'auto',
  tiltShift: false,
  shadows: true,
  showFps: false,
  npcDensity: mobile ? 0.6 : 1,
});

export function loadSettings(mobile: boolean): Settings {
  const d = defaultSettings(mobile);
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...d, ...JSON.parse(raw) };
  } catch {
    /* armazenamento indisponível: usa padrão */
  }
  return d;
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignora */
  }
}
