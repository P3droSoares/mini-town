import type { Building } from '../data/types';
import type { WorldState } from '../world/WorldState';
import { ICONS, h, svgIcon } from './dom';
import { ZONING, buildingLabel, poiLabel } from './labels';

/**
 * Painel lateral do prédio/lote. O `lotId` exibido aqui é a chave que a
 * camada econômica usará para compra/venda de imóveis.
 */
export class InfoPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  current: Building | null = null;
  onClose: (() => void) | null = null;
  onWalkHere: ((b: Building) => void) | null = null;
  onToast: ((m: string) => void) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly world: WorldState,
  ) {
    this.body = h('div');
    this.el = h(
      'aside',
      { class: 'panel card', 'aria-live': 'polite', 'aria-label': 'Informações do imóvel' },
      h('button', { class: 'close', 'aria-label': 'Fechar', onclick: () => this.close() }, '×'),
      this.body,
    );
    parent.append(this.el);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.current) this.close();
    });
  }

  show(b: Building) {
    this.current = b;
    const lot = this.world.lotOf(b);
    const addr = b.address;
    const addrText = addr
      ? `${addr.street ?? 'Rua sem nome'}${addr.housenumber ? `, ${addr.housenumber}` : ''}${addr.inferred ? ' (aprox.)' : ''}`
      : 'Sem endereço';
    const title = b.name ?? buildingLabel(b.type);
    const levels = Number.isInteger(b.levels) ? String(b.levels) : b.levels.toFixed(1);

    const copyBtn = h('button', {
      title: 'Copiar ID do lote',
      html: `${svgIcon(ICONS.copy).replace('<svg', '<svg width="14" height="14" style="vertical-align:-2px"')} Copiar`,
      onclick: () => {
        navigator.clipboard?.writeText(b.lotId).then(
          () => this.onToast?.(`ID ${b.lotId} copiado`),
          () => this.onToast?.('Não foi possível copiar'),
        );
      },
    });

    const pois = b.pois?.length
      ? h('ul', { class: 'pois' }, ...b.pois.map((p) => h('li', {}, h('b', {}, p.name), ` · ${poiLabel(p.value)}`)))
      : null;

    this.body.replaceChildren(
      h('div', { class: 'kind' }, buildingLabel(b.type), b.generated ? h('span', { class: 'tag' }, 'procedural') : null),
      h('h2', {}, title),
      h(
        'dl',
        {},
        h('dt', {}, 'Endereço'),
        h('dd', {}, addrText),
        h('dt', {}, 'Andares'),
        h('dd', {}, `${levels}${b.heightFromTag ? '' : ' (estimado)'}`),
        h('dt', {}, 'Altura'),
        h('dd', {}, `${b.height.toFixed(1)} m`),
        h('dt', {}, 'Área do lote'),
        h('dd', {}, `${Math.round(lot?.area ?? b.area).toLocaleString('pt-BR')} m²`),
        h('dt', {}, 'Zoneamento'),
        h('dd', {}, ZONING[lot?.zoning ?? 'misto'] ?? 'Uso misto'),
        h('dt', {}, 'Proprietário'),
        h('dd', {}, lot?.ownerId ?? 'Sem dono'),
      ),
      h('div', { class: 'lot' }, h('span', {}, 'Lote ', h('code', {}, b.lotId)), copyBtn),
      pois ?? '',
      h(
        'div',
        { class: 'note' },
        b.generated
          ? 'Prédio gerado para preencher a quadra (não mapeado no OSM). '
          : h('span', {}, 'Dados: ', h('a', { href: `https://www.openstreetmap.org/${b.osmType}/${b.osmId}`, target: '_blank', rel: 'noopener' }, `OSM ${b.osmType}/${b.osmId}`), '. '),
        h(
          'a',
          {
            href: '#',
            onclick: (e: Event) => {
              e.preventDefault();
              this.onWalkHere?.(b);
            },
          },
          'Andar até aqui',
        ),
      ),
    );
    this.el.classList.add('open');
  }

  close() {
    this.current = null;
    this.el.classList.remove('open');
    this.onClose?.();
  }
}
