import type { Building, Lot } from '../data/types';
import type { WorldState } from '../world/WorldState';
import { ICONS, h, svgIcon } from './dom';
import { ZONING, buildingLabel, poiLabel } from './labels';
import type { PropertySection } from './PropertySection';

const CATEGORY: Record<string, string> = {
  residential: 'Residencial',
  commercial: 'Comercial',
  industrial: 'Industrial',
  institutional: 'Institucional',
  religious: 'Religioso',
};

/**
 * Painel lateral do prédio/lote. Dados do mapa (OSM) + seção econômica
 * (`PropertySection`, dados do servidor) pelo `lotId`.
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
    private readonly econ: PropertySection | null = null,
  ) {
    this.body = h('div');
    this.el = h(
      'aside',
      { class: 'panel card', 'aria-label': 'Informações do imóvel' },
      h('button', { class: 'close', 'aria-label': 'Fechar painel', html: svgIcon(ICONS.close), onclick: () => this.close() }),
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
        h('dt', {}, 'Uso'),
        h('dd', {}, CATEGORY[b.category] ?? 'Residencial'),
        h('dt', {}, 'Altura'),
        h('dd', {}, `${b.height.toFixed(1)} m`),
        h('dt', {}, 'Área do lote'),
        h('dd', {}, `${Math.round(lot?.area ?? b.area).toLocaleString('pt-BR')} m²`),
        h('dt', {}, 'Zoneamento'),
        h('dd', {}, ZONING[lot?.zoning ?? 'misto'] ?? 'Uso misto'),
      ),
      this.econSection(b.lotId),
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

  /** painel de terreno vago reservado */
  showLot(lot: Lot) {
    this.current = null;
    const addr = lot.address?.street ? `${lot.address.street} (aprox.)` : 'Sem endereço';
    this.body.replaceChildren(
      h('div', { class: 'kind' }, 'Terreno vago'),
      h('h2', {}, 'Lote disponível'),
      h(
        'dl',
        {},
        h('dt', {}, 'Endereço'),
        h('dd', {}, addr),
        h('dt', {}, 'Área'),
        h('dd', {}, `${Math.round(lot.area).toLocaleString('pt-BR')} m²`),
        h('dt', {}, 'Zoneamento'),
        h('dd', {}, ZONING[lot.zoning ?? 'misto'] ?? lot.zoning ?? 'Uso misto'),
      ),
      this.econSection(lot.lotId),
      h('div', { class: 'lot' }, h('span', {}, 'Lote ', h('code', {}, lot.lotId))),
      h('div', { class: 'note' }, 'Terreno sem construção: pode ser comprado e revendido no mercado.'),
    );
    this.el.classList.add('open');
  }
  /** seção econômica (servidor) para o lote; vazia sem camada online */
  private econSection(lotId: string): Node | string {
    if (!this.econ) return '';
    this.currentLot = lotId;
    this.econ.load(lotId);
    return this.econ.el;
  }

  /** lote exibido (prédio ou terreno) */
  currentLot: string | null = null;

  close() {
    this.current = null;
    this.currentLot = null;
    this.econ?.load(null);
    this.el.classList.remove('open');
    this.onClose?.();
  }
}
