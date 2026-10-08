/**
 * Catálogo e regras de dinheiro do modo entregador. Valores em centavos.
 * Escala de jogo (não de mercado): a moto é a meta de algumas dezenas de
 * entregas de bicicleta.
 */

/** nome do app de entregas (troque aqui para usar uma marca fictícia) */
export const DELIVERY_APP = 'iFood';

export type VehicleKind = 'bike' | 'moto';
export type ItemId = 'bag' | VehicleKind;

export interface ShopItem {
  id: ItemId;
  name: string;
  price: number;
  description: string;
}

/** saldo de quem ainda não tem empresa: dá para a bag e a bicicleta */
export const STARTING_MONEY = 500_00;

export const SHOP: ShopItem[] = [
  { id: 'bag', name: `Bag térmica ${DELIVERY_APP}`, price: 120_00, description: 'Obrigatória para aceitar entregas.' },
  { id: 'bike', name: 'Bicicleta aro 29', price: 350_00, description: 'Até 32 km/h. Sobe ladeira no braço.' },
  { id: 'moto', name: 'Moto 160cc usada', price: 1_500_00, description: 'Até 60 km/h. Mais entregas por hora.' },
];

export const shopItem = (id: ItemId) => SHOP.find((i) => i.id === id)!;

/** pagamento da corrida: taxa fixa + valor por km do trajeto total (busca + entrega) */
export const PAY = {
  base: 10_00,
  perKm: 30_00,
  min: 12_00,
};

export function deliveryPay(routeMeters: number): number {
  const v = PAY.base + (PAY.perKm * routeMeters) / 1000;
  // arredonda para R$ 0,50
  return Math.max(PAY.min, Math.round(v / 50) * 50);
}

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const formatMoney = (cents: number) => BRL.format(cents / 100);
