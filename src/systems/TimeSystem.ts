/**
 * Relógio do jogo. Padrão: horário real de Brasília (UTC−3, sem horário de
 * verão desde 2019). Pode ser fixado/acelerado pelo menu. Na economia futura
 * este relógio virá do servidor.
 */
export const BRT_OFFSET_H = -3;

export class TimeSystem {
  /** 'real' = relógio do sistema; 'manual' = hora escolhida + velocidade */
  mode: 'real' | 'manual' = 'real';
  /** multiplicador no modo manual (1 = tempo real; 60 = 1 min/s) */
  speed = 1;
  private manualUtcMs = Date.now();
  private listeners: (() => void)[] = [];

  /** instante atual do jogo (UTC) */
  now(): Date {
    return this.mode === 'real' ? new Date() : new Date(this.manualUtcMs);
  }

  /** hora decimal em Brasília (0..24) */
  hours(): number {
    const d = this.now();
    const h = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600 + BRT_OFFSET_H;
    return ((h % 24) + 24) % 24;
  }

  label(): string {
    const h = this.hours();
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  /** fixa a hora de Brasília (mantém a data de hoje) */
  setHours(h: number) {
    // dia local de Brasília pode diferir do UTC — usa o dia corrente em BRT
    const brt = new Date(this.now().getTime() + BRT_OFFSET_H * 3_600_000);
    const brtDay = Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate());
    this.manualUtcMs = brtDay + (h - BRT_OFFSET_H) * 3_600_000;
    this.mode = 'manual';
    this.emit();
  }

  useRealTime() {
    this.mode = 'real';
    this.speed = 1;
    this.emit();
  }

  onChange(f: () => void) {
    this.listeners.push(f);
  }
  private emit() {
    this.listeners.forEach((f) => f());
  }

  update(dt: number) {
    if (this.mode === 'manual') this.manualUtcMs += dt * 1000 * this.speed;
  }
}
