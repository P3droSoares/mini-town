import { h } from './dom';

export class LoadingScreen {
  readonly el: HTMLElement;
  private bar: HTMLElement;
  private label: HTMLElement;
  private box: HTMLElement;

  constructor(parent: HTMLElement) {
    this.bar = h('i');
    this.label = h('div', { class: 'label' }, 'Preparando…');
    this.box = h(
      'div',
      { class: 'box card', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'houses', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span')),
      h('h1', {}, 'Vila Aurora'),
      h('div', { class: 'sub' }, 'uma cidade planejada em miniatura'),
      h('div', { class: 'bar' }, this.bar),
      this.label,
    );
    this.el = h('div', { class: 'loading' }, this.box);
    parent.append(this.el);
  }

  set(fraction: number, label: string) {
    this.bar.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
    this.label.textContent = label;
  }

  error(msg: string) {
    this.box.append(h('div', { class: 'err' }, msg));
    this.label.textContent = 'Não foi possível carregar a cidade.';
  }

  hide() {
    this.el.classList.add('done');
    setTimeout(() => this.el.remove(), 700);
  }
}
