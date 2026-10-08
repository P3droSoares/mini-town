import type { BusinessType, PropertyCategory, PropertyView } from '../net/api';
import { formatMoney } from '../net/money';

/** Rótulos pt-BR da camada econômica. */

export const CATEGORY_LABEL: Record<PropertyCategory, string> = {
  residential: 'Residencial',
  commercial: 'Comercial',
  industrial: 'Industrial',
  institutional: 'Institucional',
  religious: 'Religioso',
  vacant: 'Terreno vago',
};

/** categorias negociáveis (filtro do mercado, índices) */
export const TRADABLE: PropertyCategory[] = ['residential', 'commercial', 'industrial', 'vacant'];

export const BUSINESS_LABEL: Record<BusinessType, string> = {
  mercado: 'Mercado',
  padaria: 'Padaria',
  loja: 'Loja',
  escritorio: 'Escritório',
  restaurante: 'Restaurante',
};

export function categoryLabel(c: string): string {
  return CATEGORY_LABEL[c as PropertyCategory] ?? c;
}

export function businessLabel(t: string): string {
  return BUSINESS_LABEL[t as BusinessType] ?? t;
}

/** rótulos dos tipos de lançamento do extrato (códigos desconhecidos aparecem crus) */
const TX_LABEL: Record<string, string> = {
  signup_grant: 'Bônus de boas-vindas',
  starter_home: 'Casa inicial',
  city_purchase: 'Compra da prefeitura',
  city_sale: 'Venda à prefeitura',
  income: 'Renda coletada (− IPTU)',
  property_tax: 'IPTU',
  business_open: 'Abertura de negócio',
  business_upgrade: 'Melhoria de negócio',
};

/** `market_sale` vale para os dois lados: o sinal diz se foi compra ou venda */
export function txLabel(kind: string, amount = 0n): string {
  if (kind === 'market_sale') return amount > 0n ? 'Venda no mercado' : 'Compra no mercado';
  return TX_LABEL[kind] ?? kind.replace(/_/g, ' ');
}

/** tipo de venda recente (visão pública) */
export function saleLabel(kind: string): string {
  if (kind === 'market_sale') return 'entre jogadores';
  if (kind === 'city_purchase') return 'da prefeitura';
  if (kind === 'city_sale') return 'à prefeitura';
  return kind.replace(/_/g, ' ');
}

/** rótulos das estatísticas do mercado (chaves desconhecidas aparecem cruas) */
const STAT_LABEL: Record<string, string> = {
  players: 'Jogadores',
  ownedProperties: 'Imóveis com dono',
  activeListings: 'Anúncios ativos',
  moneySupply: 'Dinheiro com jogadores',
};

export function statLabel(k: string): string {
  return STAT_LABEL[k] ?? k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
}

const dateFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dateFmt.format(d);
}

export function formatArea(m2: number): string {
  return `${Math.round(m2).toLocaleString('pt-BR')} m²`;
}

/** endereço exibível de um imóvel */
export function propertyAddress(p: Pick<PropertyView, 'address' | 'category'>): string {
  return p.address?.trim() || `${categoryLabel(p.category)} sem endereço`;
}

/** a / b em % inteiro (b = 0 => 0) */
export function pctOf(a: bigint, b: bigint): number {
  return b > 0n ? Number((a * 100n + b / 2n) / b) : 0;
}

/** tempo para recuperar um gasto com o ganho por hora (texto curto) */
export function formatPayback(cost: bigint, gainPerHour: bigint): string {
  if (gainPerHour <= 0n) return 'sem retorno pela renda';
  const hours = Number((cost + gainPerHour - 1n) / gainPerHour);
  if (hours < 48) return `~${hours} h de renda`;
  return `~${Math.ceil(hours / 24).toLocaleString('pt-BR')} dias de renda`;
}

/** "I$ 60.000" (sem centavos quando redondos) */
export const money0 = (v: bigint) => formatMoney(v, { compactCents: true });
