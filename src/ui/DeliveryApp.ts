import type { Game } from '../core/Game';
import { DELIVERY_APP, type ItemId, SHOP, type VehicleKind, formatMoney } from '../economy/catalog';
import type { PlayerProfile } from '../economy/PlayerProfile';
import type { DeliverySystem } from '../systems/DeliverySystem';
import { VEHICLES } from '../entities/vehicles';
import { ICONS, h, svgIcon } from './dom';

const ITEM_ICON: Record<ItemId, string> = { bag: ICONS.bag, bike: ICONS.bike, moto: ICONS.moto };

/**
 * App do entregador (estilo celular): saldo, ficar disponível, corrida atual,
 * escolha do veículo e loja (bag, bicicleta, moto).
 */
export class DeliveryApp {
  readonly el: HTMLElement;
  /** botão da barra superior (ícone + saldo) */
  readonly button: HTMLButtonElement;
  private body: HTMLElement;
  private money: HTMLElement;
  onOpen: (() => void) | null = null;
  onToast: ((m: string) => void) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly game: Game,
    private readonly profile: PlayerProfile,
    private readonly delivery: DeliverySystem,
  ) {
    this.money = h('span', { class: 'money' });
    this.button = h(
      'button',
      {
        class: 'iconbtn card appbtn',
        title: `App de entregas ${DELIVERY_APP} (E)`,
        'aria-label': `Abrir app de entregas ${DELIVERY_APP}`,
        onclick: () => this.toggle(),
      },
      h('span', { class: 'ico', html: svgIcon(ICONS.bag) }),
      this.money,
    ) as HTMLButtonElement;
    this.body = h('div', { class: 'app-body' });
    this.el = h(
      'aside',
      { class: 'app card', role: 'dialog', 'aria-label': `App de entregas ${DELIVERY_APP}` },
      h(
        'header',
        { class: 'app-head' },
        h('span', { class: 'app-logo' }, DELIVERY_APP),
        h('span', { class: 'app-sub' }, 'Entregador'),
        h('button', { class: 'close', 'aria-label': 'Fechar', onclick: () => this.close() }, '×'),
      ),
      this.body,
    );
    parent.append(this.el);
    profile.onChange(() => this.render());
    // aceitou corrida: guarda o "celular" e pilota
    let lastJob = delivery.job;
    delivery.onChange.push(() => {
      if (delivery.job && delivery.job !== lastJob) this.close();
      lastJob = delivery.job;
      this.render();
    });
    game.player.onRideChange.push(() => this.render());
    game.onModeChange.push(() => this.render());
    // entrega paga: "+R$" subindo do saldo
    delivery.onPaid.push((pay, tip) => {
      const badge = h('span', { class: 'paid-badge', 'aria-hidden': 'true' }, `+${formatMoney(pay + tip)}`);
      this.button.append(badge);
      this.button.classList.remove('paid');
      void this.button.offsetWidth;
      this.button.classList.add('paid');
      setTimeout(() => badge.remove(), 2600);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    this.render();
  }

  get isOpen() {
    return this.el.classList.contains('open');
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    this.render();
    this.el.classList.add('open');
    this.button.classList.add('active');
    this.onOpen?.();
  }

  close() {
    this.el.classList.remove('open');
    this.button.classList.remove('active');
  }

  render() {
    const p = this.profile;
    const d = this.delivery;
    this.money.textContent = formatMoney(p.money);
    this.button.classList.toggle('online', d.online);

    const stat = (label: string, value: string) => h('div', {}, h('small', {}, label), h('b', {}, value));
    const wallet = h('div', { class: 'app-wallet' }, stat('Saldo', formatMoney(p.money)), stat('Entregas', String(p.data.deliveries)), stat('Ganhos', formatMoney(p.data.earned)));

    this.body.replaceChildren(wallet, this.statusSection(), this.garageSection() ?? '', this.shopSection(), this.helpSection());
  }

  private statusSection(): HTMLElement {
    const d = this.delivery;
    const job = d.job;
    if (job) {
      const o = job.order;
      const pickup = job.phase === 'pickup';
      return h(
        'section',
        { class: 'app-job' },
        h('h3', {}, 'Corrida em andamento'),
        h(
          'ol',
          { class: 'steps' },
          h('li', { class: pickup ? 'cur' : 'done' }, h('b', {}, o.restaurant.name), h('small', {}, `${o.restaurant.address} · retirar`)),
          h('li', { class: pickup ? '' : 'cur' }, h('b', {}, o.customer.name), h('small', {}, `${o.customer.address} · entregar`)),
        ),
        h('div', { class: 'app-items' }, o.items),
        h('div', { class: 'app-row' }, h('span', {}, 'Valor da corrida'), h('b', {}, formatMoney(o.pay))),
        h('button', { class: 'btn ghost', onclick: () => d.cancelJob() }, 'Cancelar corrida'),
      );
    }
    const blocker = d.blocker;
    const toggle = h('input', { type: 'checkbox', role: 'switch', 'aria-label': 'Disponível para entregas' }) as HTMLInputElement;
    toggle.checked = d.online;
    toggle.disabled = !!blocker && !d.online;
    toggle.addEventListener('change', () => {
      d.setOnline(toggle.checked);
      // celular: o painel cobre o joystick
      if (d.online && this.game.mobile) this.close();
    });
    return h(
      'section',
      { class: 'app-status' },
      h('label', { class: 'switch-row' }, h('span', {}, h('b', {}, d.online ? 'Disponível' : 'Offline'), h('small', {}, d.online ? (d.offer ? 'Nova corrida na tela!' : 'Procurando pedidos perto de você…') : 'Fique disponível para receber corridas')), toggle, h('i', { class: 'switch' })),
      blocker ? h('div', { class: 'app-note' }, blocker) : null,
    );
  }

  private garageSection(): HTMLElement | null {
    const p = this.profile;
    const owned = p.vehicles;
    if (!owned.length) return null;
    const pl = this.game.player;
    const riding = pl.state.vehicle && this.game.mode === 'walk';
    const choose = (k: VehicleKind) =>
      h(
        'button',
        {
          class: `seg${p.data.vehicle === k ? ' on' : ''}`,
          'aria-pressed': String(p.data.vehicle === k),
          onclick: () => p.selectVehicle(k),
          html: `${svgIcon(ITEM_ICON[k])}<span>${VEHICLES[k].name}</span>`,
        },
      );
    const name = VEHICLES[p.data.vehicle ?? owned[0]].name.toLowerCase();
    return h(
      'section',
      { class: 'app-garage' },
      h('h3', {}, 'Seu veículo'),
      owned.length > 1 ? h('div', { class: 'segs' }, ...owned.map(choose)) : null,
      h(
        'button',
        { class: 'btn primary', onclick: () => this.delivery.toggleRide() },
        riding ? `Descer da ${name}` : `Subir na ${name}`,
        h('kbd', {}, 'F'),
      ),
    );
  }

  private shopSection(): HTMLElement {
    const p = this.profile;
    const rows = SHOP.map((item) => {
      const owned = p.has(item.id);
      const missing = item.price - p.money;
      const action = owned
        ? h('span', { class: 'owned' }, 'Comprado')
        : h(
            'button',
            {
              class: 'btn buy',
              disabled: missing > 0,
              title: missing > 0 ? `Faltam ${formatMoney(missing)}` : `Comprar por ${formatMoney(item.price)}`,
              onclick: () => {
                if (p.buy(item.id)) this.onToast?.(`${item.name} comprado(a)!`);
              },
            },
            formatMoney(item.price),
          );
      return h(
        'li',
        { class: owned ? 'is-owned' : '' },
        h('span', { class: 'ico', html: svgIcon(ITEM_ICON[item.id]) }),
        h('div', {}, h('b', {}, item.name), h('small', {}, !owned && missing > 0 ? `Faltam ${formatMoney(missing)}` : item.description)),
        action,
      );
    });
    return h('section', { class: 'app-shop' }, h('h3', {}, 'Loja'), h('ul', {}, ...rows));
  }

  private helpSection(): HTMLElement {
    return h(
      'div',
      {
        class: 'app-help',
        html: this.game.mobile
          ? 'Joystick: para cima acelera, para baixo freia, para os lados vira. Pare na porta para retirar e entregar.'
          : '<kbd>F</kbd> sobe/desce · <kbd>W</kbd><kbd>S</kbd> acelera/freia · <kbd>A</kbd><kbd>D</kbd> vira · <kbd>Espaço</kbd> freio · <kbd>Shift</kbd> embala · <kbd>Enter</kbd> aceita corrida. Pare na porta para retirar e entregar.',
      },
    );
  }
}
