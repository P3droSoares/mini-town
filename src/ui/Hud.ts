import type { CameraMode, Game } from '../core/Game';
import { ICONS, h, svgIcon } from './dom';
import { Joystick } from './Joystick';

/** Barra superior + controles de modo + dica + joystick. */
export class Hud {
  readonly topbar: HTMLElement;
  readonly controls: HTMLElement;
  private modeBtn: HTMLButtonElement;
  private hint: HTMLElement;
  private joystick: Joystick;
  private runBtn: HTMLButtonElement;
  private toastEl: HTMLElement;
  private toastTimer = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly game: Game,
  ) {
    this.modeBtn = h('button', {
      class: 'iconbtn card',
      title: 'Alternar câmera de cidade / andar a pé (C)',
      'aria-label': 'Alternar modo de câmera',
      onclick: () => game.toggleMode(),
    }) as HTMLButtonElement;
    this.topbar = h(
      'div',
      { class: 'topbar' },
      h('div', { class: 'brand card' }, h('b', {}, 'Vila Aurora'), h('small', {}, 'cidade planejada · em miniatura')),
      h('div', { class: 'spacer' }),
      this.modeBtn,
    );
    this.controls = h('div', { class: 'controls' });
    this.hint = h('div', { class: 'hint card' });
    this.toastEl = h('div', { class: 'toast card', role: 'status', 'aria-live': 'polite' });
    root.append(this.topbar, this.controls, this.hint, this.toastEl);

    this.joystick = new Joystick(root, game.input);
    this.runBtn = h('button', {
      class: 'iconbtn card runbtn',
      'aria-pressed': 'false',
      html: `${svgIcon(ICONS.run)}<span class="lbl">Correr</span>`,
      onclick: () => {
        game.input.runToggle = !game.input.runToggle;
        this.runBtn.classList.toggle('active', game.input.runToggle);
        this.runBtn.setAttribute('aria-pressed', String(game.input.runToggle));
      },
    }) as HTMLButtonElement;
    root.append(this.runBtn);

    game.onModeChange.push((m) => this.renderMode(m));
    game.player.onRideChange.push(() => this.renderMode(game.mode));
    this.renderMode(game.mode);
  }

  private renderMode(m: CameraMode) {
    const walk = m === 'walk';
    this.modeBtn.innerHTML = walk
      ? `${svgIcon(ICONS.city)}<span class="lbl">Ver cidade</span>`
      : `${svgIcon(ICONS.walk)}<span class="lbl">Andar a pé</span>`;
    this.modeBtn.classList.toggle('active', walk);
    const riding = walk && !!this.game.player.state.vehicle;
    this.joystick.visible = walk && this.game.mobile;
    this.runBtn.classList.toggle('show', walk && this.game.mobile);
    this.root.classList.toggle('walk', walk);
    const mob = this.game.mobile;
    this.hint.innerHTML = riding
      ? mob
        ? 'Joystick: para cima acelera, para baixo freia, para os lados vira'
        : '<kbd>W</kbd> acelera · <kbd>S</kbd> freia e dá ré · <kbd>A D</kbd> vira · <kbd>Espaço</kbd> freio · <kbd>F</kbd> descer'
      : walk
      ? mob
        ? 'Joystick para andar · arraste para olhar · pinça para zoom'
        : '<kbd>W A S D</kbd> andar · <kbd>Shift</kbd> correr · arraste para olhar · <kbd>C</kbd> ver cidade · <kbd>E</kbd> entregas'
      : mob
        ? 'Arraste para mover · 2 dedos giram e dão zoom · toque num prédio'
        : 'Arraste para mover · botão direito gira · roda dá zoom · <kbd>C</kbd> andar a pé';
    this.showHint();
  }

  private hintTimer = 0;
  private showHint() {
    this.hint.style.opacity = '1';
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => (this.hint.style.opacity = '0'), 6000);
  }

  toast(msg: string) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    // mensagens longas ficam mais tempo
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), Math.max(2200, msg.length * 60));
  }
}
