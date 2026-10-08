import type { Game, System } from '../core/Game';
import type { Building, Vec2 } from '../data/types';
import { DELIVERY_APP, deliveryPay, formatMoney } from '../economy/catalog';
import type { PlayerProfile } from '../economy/PlayerProfile';
import { type Place, type Restaurant, customerName, frontOf, orderItems, residentialBuildings } from '../economy/places';
import { type Route, RouteProgress, type Router } from '../world/routing';
import { Beacon, RouteLine } from '../world/render/RouteLine';

/** raio (m) em volta da calçada e tempo parado (s) para retirar/entregar */
const ARRIVE_RADIUS = 11;
const HOLD_TIME = 1.2;
/** segundos para aceitar uma oferta */
export const OFFER_TTL = 20;
/** ritmo esperado (m/s) — chegar antes rende gorjeta */
const EXPECTED_SPEED = 6;

export interface Order {
  id: number;
  restaurant: Restaurant;
  customer: Place & { name: string };
  items: string;
  /** trajetos pela rua (m): até o restaurante e até o cliente */
  pickupDist: number;
  dropDist: number;
  /** valor da corrida (centavos), sem gorjeta */
  pay: number;
}

export interface Offer {
  order: Order;
  /** segundos restantes para aceitar */
  ttl: number;
}

export type JobPhase = 'pickup' | 'dropoff';

export interface Job {
  order: Order;
  phase: JobPhase;
  elapsed: number;
  expected: number;
  /** parado no local: 0..1 até retirar/entregar */
  hold: number;
}

/** Rota atual para a UI (minimapa, marcador na tela). */
export interface GpsInfo {
  route: Route | null;
  progress: number;
  target: Vec2;
  phase: JobPhase;
}

/**
 * Modo entregador de app (para quem ainda não tem empresa): fica disponível,
 * recebe ofertas de corrida (restaurante -> cliente), aceita, segue o GPS,
 * retira o pedido parado na porta do restaurante e entrega parado na porta
 * do cliente. Paga por distância + gorjeta por pontualidade.
 */
export class DeliverySystem implements System {
  online = false;
  offer: Offer | null = null;
  job: Job | null = null;
  progress: RouteProgress | null = null;
  readonly line: RouteLine;
  readonly beacon: Beacon;
  /** estado mudou (online, oferta, corrida, fase) */
  readonly onChange: (() => void)[] = [];
  /** entrega paga (valor da corrida, gorjeta) */
  readonly onPaid: ((pay: number, tip: number) => void)[] = [];
  onToast: ((msg: string) => void) | null = null;
  private wait = 2;
  private seq = 0;
  private offRoute = 0;
  private retry = 0;
  private lastRestaurant: Restaurant | null = null;
  private readonly customers: Building[];
  private readonly rng = Math.random;

  constructor(
    private readonly game: Game,
    private readonly profile: PlayerProfile,
    private readonly router: Router,
    readonly restaurants: Restaurant[],
  ) {
    this.line = new RouteLine(game.world.height);
    this.beacon = new Beacon(game.world.height);
    game.scene.add(this.line.mesh, this.beacon.group);
    this.customers = residentialBuildings(game.world);
    // trocou o veículo de trabalho no app: troca embaixo do jogador
    profile.onChange(() => {
      const k = profile.data.vehicle;
      const s = game.player.state;
      if (s.vehicle && k && s.vehicle !== k) game.player.mount(k);
    });
  }

  /** o que falta para trabalhar (null = pode) */
  get blocker(): string | null {
    if (!this.profile.has('bag')) return `Compre a bag térmica para aceitar entregas no ${DELIVERY_APP}.`;
    if (!this.profile.vehicles.length) return 'Compre uma bicicleta ou uma moto para fazer as entregas.';
    return null;
  }

  /** sobe/desce do veículo de trabalho */
  toggleRide() {
    const pl = this.game.player;
    if (pl.state.vehicle && this.game.mode === 'walk') {
      pl.dismount();
      return;
    }
    const kind = this.profile.data.vehicle;
    if (!kind) {
      this.toast(`Você ainda não tem veículo. Compre uma bicicleta ou moto no app ${DELIVERY_APP}.`);
      return;
    }
    if (this.game.mode !== 'walk') this.game.setMode('walk');
    pl.mount(kind);
  }

  setOnline(on: boolean) {
    if (on === this.online) return;
    if (on) {
      const b = this.blocker;
      if (b) {
        this.toast(b);
        return;
      }
      // já sai montado, na rua
      if (!this.game.player.state.vehicle || this.game.mode !== 'walk') this.toggleRide();
      this.online = true;
      this.wait = 2.5;
      this.toast('Você está disponível. Aguarde pedidos…');
    } else {
      if (this.job) {
        this.toast('Termine ou cancele a corrida antes de ficar offline.');
        return;
      }
      this.online = false;
      this.offer = null;
    }
    this.emit();
  }

  accept() {
    const o = this.offer;
    if (!o || this.job) return;
    this.offer = null;
    const ord = o.order;
    this.lastRestaurant = ord.restaurant;
    this.job = { order: ord, phase: 'pickup', elapsed: 0, expected: (ord.pickupDist + ord.dropDist) / EXPECTED_SPEED + 30, hold: 0 };
    // aceitou na câmera de cidade: volta para onde o jogador estava
    this.game.positionLocked = true;
    if (this.game.mode !== 'walk') this.game.setMode('walk');
    this.routeTo(ord.restaurant);
    this.toast(`Corrida aceita! Retire o pedido em ${ord.restaurant.name}`);
    this.emit();
  }

  decline() {
    if (!this.offer) return;
    this.offer = null;
    this.wait = 3 + this.rng() * 4;
    this.emit();
  }

  cancelJob() {
    if (!this.job) return;
    this.endJob();
    this.wait = 5;
    this.toast('Corrida cancelada.');
    this.emit();
  }

  /** dados do GPS para o minimapa e o marcador na tela */
  gps(): GpsInfo | null {
    const job = this.job;
    if (!job) return null;
    const target = job.phase === 'pickup' ? job.order.restaurant : job.order.customer;
    return { route: this.progress?.route ?? null, progress: this.progress?.progress ?? 0, target: target.spot, phase: job.phase };
  }

  /** metros até o destino (pela rota, ou em linha reta sem rota) */
  remaining(): number {
    const job = this.job;
    if (!job) return 0;
    if (this.progress) return this.progress.remaining;
    const t = job.phase === 'pickup' ? job.order.restaurant.spot : job.order.customer.spot;
    const s = this.game.player.state;
    return Math.hypot(t[0] - s.x, t[1] - s.z);
  }

  update(dt: number) {
    const pl = this.game.player;
    pl.bagVisible = this.profile.has('bag') && (this.online || !!this.job || !!pl.state.vehicle);
    // durante a corrida nada de teletransporte (busca/minimapa/câmera de cidade)
    this.game.positionLocked = !!this.job;
    this.line.update(dt);
    this.beacon.update(dt);

    if (this.online && !this.job) {
      if (this.offer) {
        this.offer.ttl -= dt;
        if (this.offer.ttl <= 0) {
          this.offer = null;
          this.wait = 4 + this.rng() * 5;
          this.emit();
        }
      } else if ((this.wait -= dt) <= 0) {
        const o = this.makeOrder();
        this.wait = 3;
        if (o) {
          this.offer = { order: o, ttl: OFFER_TTL };
          this.emit();
        }
      }
    }

    const job = this.job;
    if (!job) return;
    job.elapsed += dt;
    const target = job.phase === 'pickup' ? job.order.restaurant : job.order.customer;
    const s = pl.state;
    if (this.progress) {
      this.progress.update(s.x, s.z);
      this.line.progress = this.progress.progress;
      // saiu da rota: recalcula (como um GPS); longe de qualquer rua, espera um pouco entre tentativas
      this.offRoute = this.progress.offset > 22 ? this.offRoute + dt : Math.min(0, this.offRoute + dt);
      if (this.offRoute > 1.2) {
        this.reroute(target);
        this.offRoute = -3;
      }
    } else if ((this.retry += dt) > 2) this.reroute(target);

    // chegou: parado perto da calçada do local
    const d = Math.hypot(s.x - target.spot[0], s.z - target.spot[1]);
    const here = this.game.mode === 'walk' && d < ARRIVE_RADIUS && Math.abs(s.speed) < 2.5;
    job.hold = here ? job.hold + dt / HOLD_TIME : Math.max(0, job.hold - dt * 2);
    if (job.hold >= 1) this.advance();
  }

  private advance() {
    const job = this.job!;
    job.hold = 0;
    if (job.phase === 'pickup') {
      job.phase = 'dropoff';
      this.routeTo(job.order.customer);
      this.toast(`Pedido retirado! Leve para ${job.order.customer.name}`);
    } else {
      const tip = this.tipFor(job);
      this.profile.payDelivery(job.order.pay + tip);
      this.toast(`Entrega concluída! +${formatMoney(job.order.pay + tip)}${tip ? ` (gorjeta de ${formatMoney(tip)})` : ''}`);
      this.onPaid.forEach((f) => f(job.order.pay, tip));
      this.endJob();
      this.wait = 3 + this.rng() * 3;
    }
    this.emit();
  }

  /** gorjeta: mais provável quanto antes do esperado */
  private tipFor(job: Job): number {
    const chance = Math.min(0.85, Math.max(0.05, 1.25 - job.elapsed / job.expected));
    if (this.rng() > chance) return 0;
    return Math.round((2 + this.rng() * 6) * 2) * 50;
  }

  private endJob() {
    this.job = null;
    this.progress = null;
    this.line.set(null);
    this.beacon.hide();
    this.game.positionLocked = false;
  }

  /** novo destino: rota + marcador */
  private routeTo(place: Place) {
    this.beacon.show(place.spot[0], place.spot[1]);
    this.offRoute = 0;
    this.reroute(place);
  }

  /** recalcula a rota da posição atual até o local */
  private reroute(place: Place) {
    const s = this.game.player.state;
    const r = this.router.route([s.x, s.z], place.road);
    this.progress = r ? new RouteProgress(r) : null;
    this.line.set(r);
    this.retry = 0;
  }

  /** oferta perto do jogador: restaurante entre os mais próximos, cliente a 180–750 m */
  private makeOrder(): Order | null {
    const s = this.game.player.state;
    const here: Vec2 = [s.x, s.z];
    const near = this.restaurants
      .filter((r) => r !== this.lastRestaurant)
      .map((r) => ({ r, d: Math.hypot(r.spot[0] - s.x, r.spot[1] - s.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 6);
    for (let tries = 0; tries < 8 && near.length; tries++) {
      const { r } = near[Math.floor(this.rng() * near.length)];
      const c = this.pickCustomer(r);
      if (!c) continue;
      const toR = this.router.route(here, r.road);
      const toC = this.router.route(r.road, c.road);
      if (!toR || !toC) continue;
      return {
        id: ++this.seq,
        restaurant: r,
        customer: { ...c, name: customerName(this.rng) },
        items: orderItems(r.cuisine, this.rng),
        pickupDist: toR.length,
        dropDist: toC.length,
        pay: deliveryPay(toR.length + toC.length),
      };
    }
    return null;
  }

  private pickCustomer(r: Restaurant): Place | null {
    if (!this.customers.length) return null;
    for (let i = 0; i < 60; i++) {
      const b = this.customers[Math.floor(this.rng() * this.customers.length)];
      const d = Math.hypot(b.centroid[0] - r.spot[0], b.centroid[1] - r.spot[1]);
      if (d < 180 || d > 750) continue;
      const place = frontOf(this.game.world, this.router, b);
      if (place) return place;
    }
    return null;
  }

  private toast(msg: string) {
    this.onToast?.(msg);
  }

  private emit() {
    this.onChange.forEach((f) => f());
  }
}
