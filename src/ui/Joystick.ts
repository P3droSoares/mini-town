import type { Input } from '../core/Input';
import { h } from './dom';

/** Joystick virtual para celular (modo a pé). Escreve em `input.stick`. */
export class Joystick {
  readonly el: HTMLElement;
  private knob: HTMLElement;
  private pointer: number | null = null;
  private cx = 0;
  private cy = 0;
  private readonly radius = 48;

  constructor(
    parent: HTMLElement,
    private readonly input: Input,
  ) {
    this.knob = h('i');
    this.el = h('div', { class: 'joystick', 'aria-label': 'Joystick de movimento', role: 'application' }, this.knob);
    parent.append(this.el);
    this.el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
  }

  set visible(v: boolean) {
    this.el.classList.toggle('show', v);
    if (!v) this.reset();
  }

  private onDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    this.pointer = e.pointerId;
    const r = this.el.getBoundingClientRect();
    this.cx = r.left + r.width / 2;
    this.cy = r.top + r.height / 2;
    this.onMove(e);
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    let dx = e.clientX - this.cx;
    let dy = e.clientY - this.cy;
    const l = Math.hypot(dx, dy);
    if (l > this.radius) {
      dx = (dx / l) * this.radius;
      dy = (dy / l) * this.radius;
    }
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    this.input.stick.x = dx / this.radius;
    this.input.stick.y = -dy / this.radius;
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    this.reset();
  };

  private reset() {
    this.pointer = null;
    this.knob.style.transform = '';
    this.input.stick.x = 0;
    this.input.stick.y = 0;
  }
}
