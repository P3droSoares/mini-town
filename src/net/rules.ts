/**
 * Regras da economia no cliente, importadas da fonte única do servidor
 * (`server/src/economy/config.ts` e `pricing.ts` — módulos puros, sem Node).
 * Assim o cliente não tem percentuais próprios que possam divergir: mudou o
 * balanceamento no servidor, o cliente acompanha (ou deixa de compilar).
 *
 * Tudo aqui é só ESTIMATIVA para exibir quando o servidor não mandou a cotação
 * pronta (`PropertyView`); o servidor recalcula e decide tudo.
 */
import { BUSINESS_TYPES as SERVER_BUSINESS_TYPES, ECONOMY, SELLABLE, type BusinessType, type Category } from '../../server/src/economy/config';
import {
  askRange,
  basePrice,
  businessOpenCost as serverOpenCost,
  businessUpgradeCost,
  cityPrice,
  incomePerHour,
  iptuMultiplier,
  marketFee,
  mulFrac,
  sellToCityPrice,
} from '../../server/src/economy/pricing';

export type { BusinessType, Category };

/** tipos de negócio na ordem do servidor */
export const BUSINESS_TYPES: readonly BusinessType[] = SERVER_BUSINESS_TYPES;

export const isBusinessType = (t: string): t is BusinessType => (BUSINESS_TYPES as readonly string[]).includes(t);

/** fração → "70%" */
const pct = (f: number) => `${Math.round(f * 1000) / 10}%`.replace('.', ',');

/** textos de regra prontos para a UI (derivados do servidor) */
export const RULES = {
  sellToCityPct: pct(ECONOMY.sellToCityRate),
  feePct: pct(ECONOMY.market.feeRate),
  askMinPct: pct(ECONOMY.market.minAskRatio),
  askMaxPct: pct(ECONOMY.market.maxAskRatio),
  starterSubsidyPct: pct(ECONOMY.starter.subsidy),
  /** teto da casa inicial (avaliação base, sem índice) */
  starterMaxBase: ECONOMY.starter.maxBase,
  starterLockDays: ECONOMY.starter.lockDays,
  starterEncumbranceDays: ECONOMY.starter.encumbranceDays,
  maxAccrualHours: ECONOMY.maxAccrualHours,
  maxTaxAccrualDays: Math.round(ECONOMY.maxTaxAccrualHours / 24),
  iptuPerDayPct: pct(ECONOMY.iptuPerDay),
  maxBusinessLevel: ECONOMY.business.maxLevel,
  competitionRadiusM: ECONOMY.business.competitionRadiusM,
  competitionMaxCutPct: pct(1 - ECONOMY.business.competitionMin),
  levelBonusPct: pct(ECONOMY.business.levelBonus),
  indexMin: ECONOMY.index.minBp / ECONOMY.index.baseBp,
  indexMax: ECONOMY.index.maxBp / ECONOMY.index.baseBp,
  leaderboardSize: ECONOMY.leaderboard.size,
  /** acima disto (% da avaliação) a venda paga sobretaxa — e o preço ganha aviso */
  overpricedPct: Math.round(ECONOMY.market.surchargeFrom * 100),
  surchargePct: pct(ECONOMY.market.surchargeRate),
} as const;

/** categoria pode ter dono */
export const isSellableCategory = (c: Category): boolean => SELLABLE.has(c);

/** quanto o jogador paga pela casa inicial (o resto é subsídio) */
export const starterPays = (price: bigint): bigint => price - mulFrac(price, ECONOMY.starter.subsidy);

/**
 * Aproximação de `claimStarterHome` quando o servidor não manda
 * `starterEligible`: o teto é sobre a avaliação BASE (sem índice); com o
 * índice da categoria (público) dá para estimar a base.
 */
export function starterEligibleEstimate(p: { category: Category; owner: unknown; cityPrice: string | null; appraisal: bigint }, index = 1): boolean {
  if (p.category !== 'residential' || p.owner || p.cityPrice === null) return false;
  const base = index > 0 ? (p.appraisal * BigInt(ECONOMY.index.baseBp)) / BigInt(Math.round(index * ECONOMY.index.baseBp)) : p.appraisal;
  return base <= ECONOMY.starter.maxBase;
}

/** venda à prefeitura: teto (o servidor usa o menor entre avaliação e preço pago) */
export const sellToCityMax = (appraisal: bigint): bigint => sellToCityPrice(appraisal, null);

export const askLimits = (appraisal: bigint): { min: bigint; max: bigint } => askRange(appraisal);

/** valor líquido do vendedor no mercado (preço − taxa, inclusive a sobretaxa) */
export const sellerNet = (ask: bigint, appraisal: bigint): bigint => ask - marketFee(ask, appraisal);

/** custo de abrir negócio (proporcional à avaliação; igual para todos os tipos) */
export const businessOpenCost = (appraisal: bigint): bigint => serverOpenCost(appraisal);

/** quanto já foi investido num negócio (abertura + upgrades até o nível atual), na avaliação atual */
export function businessInvested(appraisal: bigint, level: number): bigint {
  let s = serverOpenCost(appraisal);
  for (let l = 1; l < level; l++) s += businessUpgradeCost(appraisal, l) ?? 0n;
  return s;
}

/** renda bruta por hora (centavos, piso) de um comercial com o negócio dado */
export function businessIncomePerHour(appraisal: bigint, t: BusinessType, level: number, competitors: number): bigint {
  const v = incomePerHour({ category: 'commercial', appraisal, isResidence: false, business: { type: t, level, competitors } });
  return BigInt(Math.floor(v));
}

/** renda/h depois do upgrade, escalando a atual pelo bônus de nível (concorrência igual) */
export function upgradedIncome(current: bigint, level: number): bigint {
  const b = ECONOMY.business.levelBonus;
  const f = (1 + b * level) / (1 + b * (level - 1));
  return BigInt(Math.floor(Number(current) * f));
}

/** renda bruta por hora de um imóvel sem negócio (aluguel/produção) */
export function plainIncomePerHour(category: Category, appraisal: bigint): bigint {
  return BigInt(Math.floor(incomePerHour({ category, appraisal, isResidence: false, business: null })));
}

/** IPTU por hora (centavos, piso), com o progressivo pelo nº de imóveis */
export function iptuPerHour(appraisal: bigint, ownedCount: number): bigint {
  return BigInt(Math.floor((Number(appraisal) * ECONOMY.iptuPerDay * iptuMultiplier(ownedCount)) / 24));
}

/** preço da prefeitura (progressivo pelo nº de imóveis do comprador) */
export const cityPriceFor = (appraisal: bigint, ownedCount: number): bigint => cityPrice(appraisal, ownedCount);

/** avaliação base (índice 1,0) — mesma função do catálogo do servidor */
export const estimateBasePrice = (category: Category, footprintM2: number, levels: number, distM: number, lotM2: number): bigint =>
  basePrice(category, footprintM2, levels, distM, lotM2);

/** avaliação atual = base × índice (índice como número, ex.: 1,05) */
export const withIndex = (base: bigint, index: number): bigint => (base * BigInt(Math.round(index * ECONOMY.index.baseBp))) / BigInt(ECONOMY.index.baseBp);
