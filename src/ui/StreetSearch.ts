import type { StreetGroup, WorldState } from '../world/WorldState';
import { ICONS, h, svgIcon } from './dom';

/** Busca de rua por nome (sem acento/caixa), com teclado e autocompletar. */
export class StreetSearch {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLUListElement;
  private results: StreetGroup[] = [];
  private sel = -1;
  onChoose: ((g: StreetGroup) => void) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly world: WorldState,
  ) {
    this.input = h('input', {
      type: 'search',
      placeholder: 'Buscar rua…',
      'aria-label': 'Buscar rua por nome',
      autocomplete: 'off',
      spellcheck: 'false',
      role: 'combobox',
      'aria-expanded': 'false',
      'aria-controls': 'street-results',
    }) as HTMLInputElement;
    this.list = h('ul', { id: 'street-results', class: 'card', role: 'listbox', hidden: true }) as HTMLUListElement;
    this.el = h('div', { class: 'search card' }, h('span', { class: 'ico', html: svgIcon(ICONS.search) }), this.input, this.list);
    parent.append(this.el);

    this.input.addEventListener('input', () => this.refresh());
    this.input.addEventListener('focus', () => this.refresh());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!this.results.length) return;
        this.sel = (this.sel + (e.key === 'ArrowDown' ? 1 : -1) + this.results.length) % this.results.length;
        this.render();
      } else if (e.key === 'Enter') {
        const g = this.results[Math.max(0, this.sel)];
        if (g) this.choose(g);
      } else if (e.key === 'Escape') {
        this.input.blur();
        this.hide();
      }
    });
    this.input.addEventListener('blur', () => setTimeout(() => this.hide(), 150));
    // atalho "/" foca a busca
    window.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== this.input) {
        e.preventDefault();
        this.input.focus();
      }
    });
  }

  private refresh() {
    this.results = this.world.searchStreets(this.input.value, 8);
    this.sel = this.results.length ? 0 : -1;
    this.render();
  }

  private render() {
    const q = this.input.value.trim();
    if (!q) return this.hide();
    const items = this.results.length
      ? this.results.map((g, i) =>
          h(
            'li',
            {
              role: 'option',
              class: i === this.sel ? 'sel' : '',
              'aria-selected': String(i === this.sel),
              onmousedown: (e: Event) => {
                e.preventDefault();
                this.choose(g);
              },
            },
            h('span', {}, g.name),
            h('small', {}, `${Math.round(g.length)} m`),
          ),
        )
      : [h('li', { class: 'empty' }, 'Nenhuma rua encontrada')];
    this.list.replaceChildren(...items);
    this.list.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
  }

  private hide() {
    this.list.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
  }

  private choose(g: StreetGroup) {
    this.input.value = g.name;
    this.hide();
    this.input.blur();
    this.onChoose?.(g);
  }
}
