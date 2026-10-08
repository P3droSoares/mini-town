import * as THREE from 'three';
import type { Game, System } from '../core/Game';
import { formatMoney } from '../economy/catalog';
import type { PlayerProfile } from '../economy/PlayerProfile';
import { VEHICLES } from '../entities/vehicles';
import { type DeliverySystem, OFFER_TTL } from '../systems/DeliverySystem';
import { ICONS, h, svgIcon } from './dom';

const fmtDist = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const v3 = new THREE.Vector3();

/**
 * HUD do entregador: cartão de oferta (aceitar/recusar com contagem),
 * cartão da corrida (destino, distância, tempo, "pare para retirar"),
 * velocímetro + botão subir/descer e marcador do destino na tela.
 */
export class DeliveryHud implements System {
  private offerEl: HTMLElement;
  private offerBar: HTMLElement;
  private jobEl: HTMLElement;
  private jobDist: HTMLElement;
  private jobTime: HTMLElement;
  private jobHold: HTMLElement;
  private jobHoldBar: HTMLElement;
  private rideBar: HTMLElement;
  private speedEl: HTMLElement;
  private rideBtn: HTMLButtonElement;
  private marker: HTMLElement;
  private markerDist: HTMLElement;
  private acc = 0;
  private renderedOffer = -1;
  private renderedJob = '';

  constructor(
    root: HTMLElement,
    private readonly game: Game,
    private readonly delivery: DeliverySystem,
    private readonly profile: PlayerProfile,
  ) {
    this.offerBar = h('i');
    this.offerEl = h('div', { class: 'offer card', role: 'alertdialog', 'aria-live': 'assertive', 'aria-label': 'Nova corrida' });
    this.jobDist = h('span', { class: 'job-dist' });
    this.jobTime = h('span');
    this.jobHoldBar = h('i');
    this.jobHold = h('div', { class: 'job-hold' }, h('span', {}), h('div', { class: 'bar' }, this.jobHoldBar));
    this.jobEl = h('div', { class: 'job card', 'aria-live': 'polite' });
    this.speedEl = h('b', {}, '0');
    this.rideBtn = h('button', { class: 'iconbtn card ridebtn', onclick: () => delivery.toggleRide() }) as HTMLButtonElement;
    this.rideBar = h('div', { class: 'ridebar' }, h('div', { class: 'speedo card', 'aria-label': 'Velocidade' }, this.speedEl, h('small', {}, 'km/h')), this.rideBtn);
    this.markerDist = h('span');
    this.marker = h('div', { class: 'waypoint', 'aria-hidden': 'true' }, h('i', { class: 'wp-ico' }), this.markerDist);
    root.append(this.offerEl, this.jobEl, this.rideBar, this.marker);

    delivery.onChange.push(() => this.sync());
    profile.onChange(() => this.sync());
    game.player.onRideChange.push(() => this.sync());
    game.onModeChange.push(() => this.sync());
    this.sync();
  }

  /** reconstrói o que muda pouco (oferta, corrida, botão) */
  private sync() {
    const d = this.delivery;
    const pl = this.game.player;
    const walk = this.game.mode === 'walk';

    // ---- oferta
    const offer = d.offer;
    this.offerEl.classList.toggle('show', !!offer);
    if (offer && offer.order.id !== this.renderedOffer) {
      this.renderedOffer = offer.order.id;
      const o = offer.order;
      this.offerEl.replaceChildren(
        h('div', { class: 'offer-top' }, h('span', { class: 'tag' }, 'Nova corrida'), h('b', { class: 'offer-pay' }, formatMoney(o.pay))),
        h(
          'ol',
          { class: 'steps' },
          h('li', { class: 'cur' }, h('b', {}, o.restaurant.name), h('small', {}, `${fmtDist(o.pickupDist)} até a coleta`)),
          h('li', {}, h('b', {}, `${o.customer.name} · ${o.customer.address}`), h('small', {}, `+${fmtDist(o.dropDist)} até a entrega`)),
        ),
        h('div', { class: 'offer-items' }, o.items),
        h(
          'div',
          { class: 'offer-actions' },
          h('button', { class: 'btn ghost', onclick: () => d.decline() }, 'Recusar'),
          h('button', { class: 'btn primary', onclick: () => d.accept() }, 'Aceitar', this.game.mobile ? null : h('kbd', {}, 'Enter')),
        ),
        h('div', { class: 'offer-timer' }, this.offerBar),
      );
    }

    // ---- corrida
    const job = d.job;
    this.jobEl.classList.toggle('show', !!job);
    const key = job ? `${job.order.id}:${job.phase}` : '';
    if (job && key !== this.renderedJob) {
      const pickup = job.phase === 'pickup';
      const place = pickup ? job.order.restaurant : job.order.customer;
      (this.jobHold.firstChild as HTMLElement).textContent = pickup ? 'Retirando pedido…' : 'Entregando…';
      this.jobEl.replaceChildren(
        h('div', { class: 'job-phase' }, h('span', { class: 'ico', html: svgIcon(pickup ? ICONS.store : ICONS.home) }), pickup ? 'Retirar pedido' : 'Entregar pedido', h('span', { class: 'job-pay' }, formatMoney(job.order.pay))),
        h('div', { class: 'job-main' }, h('b', {}, pickup ? job.order.restaurant.name : job.order.customer.name), this.jobDist),
        h('div', { class: 'job-sub' }, h('span', {}, place.address), this.jobTime),
        this.jobHold,
      );
      this.marker.querySelector('.wp-ico')!.innerHTML = svgIcon(pickup ? ICONS.store : ICONS.home);
    }
    this.renderedJob = key;

    // ---- veículo
    const riding = !!pl.state.vehicle && walk;
    const kind = pl.state.vehicle ?? this.profile.data.vehicle;
    this.rideBar.classList.toggle('show', walk && !!kind);
    this.rideBar.classList.toggle('riding', riding);
    if (kind) {
      const name = VEHICLES[kind].name;
      this.rideBtn.innerHTML = `${svgIcon(kind === 'bike' ? ICONS.bike : ICONS.moto)}<span class="lbl">${riding ? 'Descer' : `Subir na ${name.toLowerCase()}`}</span>${this.game.mobile ? '' : '<kbd>F</kbd>'}`;
      this.rideBtn.setAttribute('aria-label', riding ? `Descer da ${name.toLowerCase()}` : `Subir na ${name.toLowerCase()}`);
    }
  }

  update(dt: number) {
    const d = this.delivery;
    if (d.offer) this.offerBar.style.width = `${Math.max(0, (d.offer.ttl / OFFER_TTL) * 100)}%`;
    this.updateMarker();
    this.acc += dt;
    if (this.acc < 0.1) return;
    this.acc = 0;
    const s = this.game.player.state;
    if (s.vehicle) this.speedEl.textContent = String(Math.round(Math.abs(s.speed) * 3.6));
    const job = d.job;
    if (job) {
      this.jobDist.textContent = fmtDist(d.remaining());
      this.jobTime.textContent = fmtTime(job.elapsed);
      this.jobHold.classList.toggle('show', job.hold > 0.02);
      this.jobHoldBar.style.width = `${Math.min(100, job.hold * 100)}%`;
    }
  }

  /** área do minimapa na tela (o marcador desvia dele) */
  minimapRect: DOMRect | null = null;

  /** marcador do destino projetado na tela (preso à borda quando fora de vista) */
  private updateMarker() {
    const gps = this.delivery.gps();
    const show = !!gps && this.game.mode === 'walk';
    this.marker.classList.toggle('show', show);
    if (!gps || !show) return;
    const cam = this.game.camera;
    const [tx, tz] = gps.target;
    v3.set(tx, this.game.world.height.sample(tx, tz) + 5.5, tz).project(cam);
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    // atrás da câmera: espelha para apontar o lado certo
    const behind = v3.z > 1;
    let x = behind ? -v3.x : v3.x;
    let y = behind ? -v3.y : v3.y;
    // fora de vista: prende na borda, longe da barra de cima, do cartão da corrida e dos botões de baixo
    const mx = 1 - 120 / w;
    const top = 1 - 380 / hgt;
    // embaixo: acima do velocímetro (celular: acima do joystick e dos botões)
    const bottom = -1 + (this.game.mobile ? 420 : 200) / hgt;
    const out = behind || Math.abs(x) > mx || y > top || y < bottom;
    if (out) {
      // projeta do centro da tela na direção do alvo até a borda da área livre
      const cy = (top + bottom) / 2;
      const dy = y - cy;
      const k = Math.min(mx / Math.max(Math.abs(x), 1e-6), (dy > 0 ? top - cy : cy - bottom) / Math.max(Math.abs(dy), 1e-6));
      x *= k;
      y = cy + dy * k;
    }
    this.marker.classList.toggle('edge', out);
    const px = ((x + 1) / 2) * w;
    let py = ((1 - y) / 2) * hgt;
    // não cobre o minimapa (canto inferior esquerdo)
    const mm = this.minimapRect;
    if (mm && px > mm.left - 50 && px < mm.right + 50 && py > mm.top - 8) py = mm.top - 8;
    this.marker.style.transform = `translate(${px}px, ${py}px) translate(-50%, -100%)`;
    const s = this.game.player.state;
    this.markerDist.textContent = fmtDist(Math.hypot(tx - s.x, tz - s.z));
  }
}
