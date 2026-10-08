/**
 * Estado de entrada unificado (teclado + joystick virtual).
 * Sistemas leem `move` (x = direita, y = frente) e `run`.
 */
export class Input {
  private keys = new Set<string>();
  /** vetor do joystick virtual (-1..1) */
  readonly stick = { x: 0, y: 0 };
  runToggle = false;
  private listeners = new Map<string, Set<() => void>>();

  constructor() {
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    window.addEventListener('blur', () => this.keys.clear());
  }

  private isTyping(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    // caixa de seleção/botão com foco não é digitação: atalhos continuam valendo
    if (t.tagName === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes((t as HTMLInputElement).type);
    return t.tagName === 'TEXTAREA' || t.isContentEditable;
  }

  private onDown = (e: KeyboardEvent) => {
    if (this.isTyping(e)) return;
    this.keys.add(e.code);
    if (!e.repeat) this.listeners.get(e.code)?.forEach((f) => f());
  };
  private onUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  /** registra ação em tecla (ex.: 'KeyC') */
  on(code: string, fn: () => void) {
    if (!this.listeners.has(code)) this.listeners.set(code, new Set());
    this.listeners.get(code)!.add(fn);
  }

  down(code: string) {
    return this.keys.has(code);
  }

  get move(): { x: number; y: number } {
    let x = this.stick.x;
    let y = this.stick.y;
    if (this.down('KeyW') || this.down('ArrowUp')) y += 1;
    if (this.down('KeyS') || this.down('ArrowDown')) y -= 1;
    if (this.down('KeyD') || this.down('ArrowRight')) x += 1;
    if (this.down('KeyA') || this.down('ArrowLeft')) x -= 1;
    const l = Math.hypot(x, y);
    if (l > 1) {
      x /= l;
      y /= l;
    }
    return { x, y };
  }

  get run() {
    return this.runToggle || this.down('ShiftLeft') || this.down('ShiftRight');
  }
}
