/**
 * Avaliação, renda e impostos — funções puras, determinísticas, em centavos.
 */
import { ECONOMY, SELLABLE, type BusinessType, type Category } from './config.js';

const BP = BigInt(ECONOMY.index.baseBp);

export const isSellable = (c: Category): boolean => SELLABLE.has(c);

export function locationFactor(distM: number): number {
  const { max, min, decayMeters } = ECONOMY.location;
  return min + (max - min) * Math.exp(-Math.max(0, distM) / decayMeters);
}

export function sizeFactor(builtM2: number): number {
  const { refM2, exponent, min, max } = ECONOMY.size;
  return Math.min(max, Math.max(min, (refM2 / Math.max(1, builtM2)) ** exponent));
}

/**
 * Avaliação base (índice 1,0) em centavos. Construído = projeção do prédio ×
 * andares; o terreno (área do lote) entra à parte pelo valor do m² de terreno.
 */
export function basePrice(category: Category, footprintM2: number, levels: number, distM: number, lotM2 = 0): bigint {
  let reais = Math.max(0, lotM2) * ECONOMY.valorM2Terreno;
  if (category === 'vacant') {
    reais = Math.max(footprintM2, lotM2) * ECONOMY.valorM2Terreno;
  } else {
    const built = footprintM2 * Math.max(1, levels);
    reais += built * ECONOMY.valorM2[category] * locationFactor(distM) * sizeFactor(built);
  }
  const cents = BigInt(Math.round(reais * 100));
  return cents < ECONOMY.minAppraisal ? ECONOMY.minAppraisal : cents;
}

/** Avaliação atual = base × índice (piso inteiro, mesmo cálculo do SQL). */
export const appraisal = (base: bigint, indexBp: number): bigint => (base * BigInt(indexBp)) / BP;

/** Multiplica centavos por fração com piso (fração com até 6 casas). */
export function mulFrac(v: bigint, frac: number): bigint {
  return (v * BigInt(Math.round(frac * 1_000_000))) / 1_000_000n;
}

const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** Venda ao governo: 70% do menor valor entre avaliação atual e preço pago (sem arbitragem de índice). */
export function sellToCityPrice(appr: bigint, acquiredPrice: bigint | null): bigint {
  return mulFrac(acquiredPrice === null ? appr : minBig(appr, acquiredPrice), ECONOMY.sellToCityRate);
}

/** Taxa do mercado: 5% + 20% sobre o que passar de 110% da avaliação. */
export function marketFee(ask: bigint, appr: bigint): bigint {
  const M = ECONOMY.market;
  const over = ask - mulFrac(appr, M.surchargeFrom);
  return mulFrac(ask, M.feeRate) + (over > 0n ? mulFrac(over, M.surchargeRate) : 0n);
}

export function askRange(appr: bigint, tolerance = 0): { min: bigint; max: bigint } {
  const M = ECONOMY.market;
  return { min: mulFrac(appr, M.minAskRatio * (1 - tolerance)), max: mulFrac(appr, M.maxAskRatio * (1 + tolerance)) };
}

/** Preço da prefeitura: progressivo pelo número de imóveis que o comprador já tem. */
export function cityPrice(appr: bigint, ownedCount: number): bigint {
  const C = ECONOMY.city;
  const extra = Math.min(C.progressiveMax, Math.max(0, ownedCount - C.progressiveFrom + 1) * C.progressiveStep);
  return appr + mulFrac(appr, extra);
}

/** Peso de uma operação no índice: valor ÷ referência da categoria, limitado. */
export function demandWeight(price: bigint, refPrice: bigint | null): number {
  const I = ECONOMY.index;
  if (!refPrice || refPrice <= 0n) return I.maxWeight;
  return Math.min(I.maxWeight, Math.max(I.minWeight, Number(price) / Number(refPrice)));
}

/** Custo de abrir negócio: proporcional à avaliação (com piso). */
export function businessOpenCost(appr: bigint): bigint {
  const B = ECONOMY.business;
  const c = mulFrac(appr, B.openCostRate);
  return c < B.minOpenCost ? B.minOpenCost : c;
}

export function businessUpgradeCost(appr: bigint, currentLevel: number): bigint | null {
  const f = ECONOMY.business.upgradeCostFactor[currentLevel - 1];
  if (f === undefined || currentLevel >= ECONOMY.business.maxLevel) return null;
  return mulFrac(businessOpenCost(appr), f);
}

/** competidores = Σ nível dos rivais ÷ nível próprio (investir em nível defende o negócio). */
export function competitionFactor(competitors: number): number {
  const b = ECONOMY.business;
  return Math.max(b.competitionMin, 1 / (1 + b.competitionWeight * competitors));
}

export interface IncomeInput {
  category: Category;
  /** avaliação usada na renda (índice suavizado, ver incomeIndex) */
  appraisal: bigint;
  isResidence: boolean;
  /** casa inicial sob gravame: não rende aluguel */
  encumbered?: boolean;
  business: { type: BusinessType; level: number; competitors: number } | null;
}

/** Renda bruta por hora (centavos, fracionária — o piso é aplicado na coleta). */
export function incomePerHour(p: IncomeInput): number {
  if (p.isResidence || p.encumbered) return 0;
  let rate: number = ECONOMY.incomeRatePerHour[p.category];
  if (p.category === 'commercial' && p.business) {
    const B = ECONOMY.business;
    const t = B.types[p.business.type];
    // negócio nunca deixa a renda abaixo da renda sem negócio
    const mult = t.multiplier * competitionFactor(p.business.competitors) * (1 + B.levelBonus * (p.business.level - 1));
    rate *= Math.max(1, mult);
  }
  return Number(p.appraisal) * rate;
}

/** Horas acumuladas desde a última coleta, limitadas ao teto. */
export function accruedHours(lastCollectedAt: Date, now: Date, cap: number = ECONOMY.maxAccrualHours): number {
  const h = (now.getTime() - lastCollectedAt.getTime()) / 3_600_000;
  return Math.min(cap, Math.max(0, h));
}

/** Multiplicador do IPTU progressivo pelo tamanho da carteira. */
export function iptuMultiplier(ownedCount: number): number {
  const P = ECONOMY.iptuProgressive;
  return Math.min(P.maxMultiplier, 1 + P.step * Math.max(0, ownedCount - P.free));
}

const HOUR_MS = 3_600_000;

/**
 * Renda bruta (até 24 h) e IPTU (tempo real, teto alto) de um imóvel.
 * `taxAppraisal` = avaliação usada no imposto (maior entre índice e média).
 *
 * `consumedMs` = quanto do relógio do imóvel esta coleta paga: só o tempo
 * cujo IPTU foi cobrado em centavos inteiros. O resto fracionário fica para
 * a próxima coleta — coletar a cada poucos segundos não zera o imposto pelo
 * arredondamento (o centavo que falta continua acumulando). Sem IPTU, a
 * renda manda (o arredondamento dela é contra o jogador).
 */
export function accrual(
  p: IncomeInput,
  lastCollectedAt: Date,
  now: Date,
  taxAppraisal: bigint = p.appraisal,
  taxMult = 1,
): { gross: bigint; tax: bigint; consumedMs: number } {
  const elapsedMs = Math.max(0, now.getTime() - lastCollectedAt.getTime());
  const hTax = accruedHours(lastCollectedAt, now, ECONOMY.maxTaxAccrualHours);
  const taxPerHour = (Number(taxAppraisal) * ECONOMY.iptuPerDay * taxMult) / 24;
  const tax = Math.floor((Number(taxAppraisal) * ECONOMY.iptuPerDay * taxMult * hTax) / 24);
  const perHour = incomePerHour(p);
  let consumedMs: number;
  if (hTax >= ECONOMY.maxTaxAccrualHours) {
    consumedMs = elapsedMs; // além do teto o excedente é perdoado (regra do IPTU)
  } else if (taxPerHour > 0) {
    consumedMs = Math.min(elapsedMs, Math.floor((tax / taxPerHour) * HOUR_MS));
  } else if (perHour > 0 && elapsedMs < ECONOMY.maxAccrualHours * HOUR_MS) {
    const g = Math.floor((perHour * elapsedMs) / HOUR_MS);
    consumedMs = Math.min(elapsedMs, Math.floor((g / perHour) * HOUR_MS));
  } else {
    consumedMs = elapsedMs; // nada acumula (ou renda no teto): avança tudo
  }
  // renda só do tempo pago; no teto de 24 h é exata
  const hIncome = Math.min(ECONOMY.maxAccrualHours, consumedMs / HOUR_MS);
  const gross = BigInt(Math.floor(perHour * hIncome));
  return { gross, tax: BigInt(tax), consumedMs };
}

/** Arredondamento relativo (n algarismos significativos, passo mínimo). */
export function roundSignificant(v: bigint, digits: number, minStep: bigint): bigint {
  const abs = v < 0n ? -v : v;
  let step = minStep;
  const len = abs.toString().length;
  if (len > digits) {
    const s = 10n ** BigInt(len - digits);
    if (s > step) step = s;
  }
  const r = ((abs + step / 2n) / step) * step;
  return v < 0n ? -r : r;
}
