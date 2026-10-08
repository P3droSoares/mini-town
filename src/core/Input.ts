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

  /** tecla pertence a um controle da interface, não ao jogo */
  private isUiKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (!t || !(t instanceof HTMLElement)) return false;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return true;
    // menus e diálogos tratam o próprio teclado
    if (t.closest('[role=menu], [role=dialog], [role=tablist], .dlg-backdrop')) return true;
    // botão/link focado: setas, espaço e Enter operam o controle (letras seguem como atalhos)
    if (t !== document.body && t.matches('button, a[href], [tabindex]:not(canvas)')) return /^(Arrow|Space$|Enter$|NumpadEnter$|Home$|End$|Page)/.test(e.code);
    return false;
  }

  private onDown = (e: KeyboardEvent) => {
    if (this.isUiKey(e)) return;
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
