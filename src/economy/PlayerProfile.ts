import { type ItemId, STARTING_MONEY, type VehicleKind, shopItem } from './catalog';

/** Estado econômico do jogador (puro). No multiplayer virá do servidor. */
export interface ProfileData {
  version: 1;
  /** saldo em centavos */
  money: number;
  owned: ItemId[];
  /** veículo escolhido para trabalhar */
  vehicle: VehicleKind | null;
  deliveries: number;
  /** total ganho com entregas (centavos) */
  earned: number;
}

const KEY = 'mini-town:profile:v1';

const fresh = (): ProfileData => ({ version: 1, money: STARTING_MONEY, owned: [], vehicle: null, deliveries: 0, earned: 0 });

/** Carteira, itens comprados e estatísticas — salvo no navegador. */
export class PlayerProfile {
  readonly data: ProfileData;
  private listeners: (() => void)[] = [];

  constructor() {
    this.data = fresh();
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw) as Partial<ProfileData>;
        if (d.version === 1) Object.assign(this.data, d);
      }
    } catch {
      /* armazenamento indisponível: começa do zero */
    }
  }

  get money() {
    return this.data.money;
  }

  has(id: ItemId) {
    return this.data.owned.includes(id);
  }

  get vehicles(): VehicleKind[] {
    return (['bike', 'moto'] as const).filter((k) => this.has(k));
  }

  /** compra se houver saldo; o primeiro veículo vira o de trabalho */
  buy(id: ItemId): boolean {
    const item = shopItem(id);
    if (this.has(id) || this.data.money < item.price) return false;
    this.data.money -= item.price;
    this.data.owned.push(id);
    if (id !== 'bag' && (!this.data.vehicle || id === 'moto')) this.data.vehicle = id;
    this.commit();
    return true;
  }

  selectVehicle(k: VehicleKind) {
    if (!this.has(k) || this.data.vehicle === k) return;
    this.data.vehicle = k;
    this.commit();
  }

  /** crédito de uma entrega concluída */
  payDelivery(cents: number) {
    this.data.money += cents;
    this.data.earned += cents;
    this.data.deliveries++;
    this.commit();
  }

  /** ajuste manual (depuração: `profile.add(1000_00)` no console) */
  add(cents: number) {
    this.data.money = Math.max(0, this.data.money + Math.round(cents));
    this.commit();
  }

  /** volta ao começo (saldo inicial, sem itens) */
  reset() {
    Object.assign(this.data, fresh());
    this.commit();
  }

  onChange(f: () => void) {
    this.listeners.push(f);
  }

  private commit() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* ignora */
    }
    this.listeners.forEach((f) => f());
  }
}
