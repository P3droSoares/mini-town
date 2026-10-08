/**
 * Constantes da economia do Real de Itabirito (I$). Único lugar para ajustar
 * o balanceamento. Dinheiro sempre em centavos (bigint); taxas em fração.
 */

export const CATEGORIES = ['residential', 'commercial', 'industrial', 'institutional', 'religious', 'vacant'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Categorias que podem ter dono. */
export const SELLABLE: ReadonlySet<Category> = new Set(['residential', 'commercial', 'industrial', 'vacant']);

/** I$ → centavos. */
export const reais = (v: number): bigint => BigInt(Math.round(v * 100));

export const ECONOMY = {
  /** emissão do Tesouro para conta nova (igual a economy_signup_grant() no banco) */
  signupGrant: reais(30_000),

  // ---------------------------------------------------------- avaliação
  /** valor do m² construído por categoria (I$) */
  valorM2: {
    residential: 400,
    commercial: 650,
    industrial: 300,
    institutional: 700,
    religious: 900,
    vacant: 0,
  } satisfies Record<Category, number>,
  /** terreno: área do lote × valor do m² de terreno (I$); somado ao construído */
  valorM2Terreno: 25,
  /** fator_localizacao = min + (max - min) · e^(-d / decaimento) */
  location: { max: 1.6, min: 0.6, decayMeters: 500 },
  /** fator_tamanho = clamp((ref / area_construida)^expoente, min, max) — ganho de escala */
  size: { refM2: 100, exponent: 0.1, min: 0.7, max: 1.2 },
  /** avaliação mínima de qualquer imóvel */
  minAppraisal: reais(1_000),

  // ---------------------------------------------------------- índice de mercado
  index: {
    /** pontos-base: 10000 = 1,0 */
    baseBp: 10_000,
    minBp: 6_000,
    maxBp: 18_000,
    /** variação máxima em relação ao início da janela de 1 h */
    maxHourlyChangeBp: 500,
    /** efeito de cada operação na demanda (ponderado pelo valor, ver demandWeight) */
    buyFromCityBp: 40,
    marketSaleBp: 25,
    sellToCityBp: -40,
    /** peso mínimo/máximo de uma operação = preço ÷ preço de referência da categoria */
    minWeight: 0.05,
    maxWeight: 1,
    /** venda entre jogadores só conta como demanda com preço ≥ esta fração da avaliação */
    marketSaleMinRatio: 0.9,
    /** revenda do mesmo imóvel dentro desta janela não move o índice (h) */
    resaleIgnoreHours: 24,
    /** reversão à média: fração da distância a 1,0 removida por hora */
    reversionPerHour: 0.05,
    /** média móvel exponencial (constante de tempo em h) usada na renda/IPTU */
    emaHours: 24,
  },

  // ---------------------------------------------------------- fluxos
  starter: {
    /** avaliação BASE máxima de uma casa inicial (sem o índice) */
    maxBase: reais(60_000),
    /** fração do preço paga pelo Tesouro */
    subsidy: 0.8,
    /** dias em que a casa inicial não pode ser vendida/anunciada */
    lockDays: 30,
    /** gravame: até aqui a casa não rende aluguel e o subsídio volta ao Tesouro se vendida */
    encumbranceDays: 180,
    /** casas elegíveis só podem ser compradas da prefeitura por quem tem menos imóveis que isto */
    reserveMaxOwned: 3,
    /** tamanho da amostra devolvida ao cliente */
    sampleSize: 30,
  },
  /** venda ao governo: fração do menor valor entre a avaliação atual e o preço pago */
  sellToCityRate: 0.7,
  city: {
    /** compras à prefeitura por jogador em 24 h */
    dailyPurchaseQuota: 30,
    /** a partir de quantos imóveis o preço da prefeitura fica progressivo */
    progressiveFrom: 10,
    /** acréscimo por imóvel acima do limite, com teto */
    progressiveStep: 0.05,
    progressiveMax: 1.0,
  },
  market: {
    /** faixa de preço do anúncio em relação à avaliação */
    minAskRatio: 0.8,
    maxAskRatio: 1.3,
    /** tolerância na compra se o índice mudou desde o anúncio */
    buyTolerance: 0.05,
    /** taxa sobre a venda entre jogadores (sumidouro) */
    feeRate: 0.05,
    /** taxa extra sobre o que passar desta fração da avaliação */
    surchargeFrom: 1.1,
    surchargeRate: 0.2,
    /** teto absoluto de um anúncio (validação de entrada) */
    maxAskPrice: reais(1_000_000_000),
    /** idade mínima da conta para comprar ou anunciar no mercado entre jogadores (dias) */
    minAccountAgeDays: 7,
    /** um negócio por par comprador/vendedor (em qualquer sentido) nesta janela (dias) */
    pairCooldownDays: 7,
    /** contas que usaram a mesma rede nesta janela não negociam entre si (dias) */
    linkWindowDays: 30,
    /** anúncio expira depois de (dias) */
    listingTtlDays: 7,
  },

  // ---------------------------------------------------------- renda
  /** renda por hora real = avaliação × taxa (≈ 1,2–1,4% ao dia) */
  incomeRatePerHour: {
    residential: 0.0005,
    commercial: 0.0006,
    industrial: 0.00055,
    institutional: 0,
    religious: 0,
    vacant: 0,
  } satisfies Record<Category, number>,
  /** acúmulo máximo de renda entre coletas */
  maxAccrualHours: 24,
  /** IPTU acumula por tempo real até este teto (o que não é pago vira dívida) */
  maxTaxAccrualHours: 30 * 24,
  /** IPTU por dia sobre a avaliação */
  iptuPerDay: 0.004,
  /** a residência é isenta de IPTU até esta avaliação (benefício de morar) */
  residenceTaxExemption: reais(60_000),
  /** IPTU progressivo: +passo por imóvel acima de livres, com teto do multiplicador */
  iptuProgressive: { free: 5, step: 0.05, maxMultiplier: 3 },

  // ---------------------------------------------------------- negócios
  business: {
    types: {
      mercado: { multiplier: 1.5 },
      padaria: { multiplier: 1.35 },
      loja: { multiplier: 1.3 },
      escritorio: { multiplier: 1.4 },
      restaurante: { multiplier: 1.45 },
    },
    /** custo de abertura = avaliação × taxa (piso abaixo) */
    openCostRate: 0.15,
    minOpenCost: reais(5_000),
    /** raio de concorrência (m) */
    competitionRadiusM: 150,
    /** fator = max(min, 1 / (1 + peso · Σ nível dos rivais ÷ nível próprio)) */
    competitionWeight: 0.25,
    competitionMin: 0.4,
    maxLevel: 5,
    /** bônus de receita por nível acima do 1 */
    levelBonus: 0.1,
    /** custo do upgrade n→n+1 = custo de abertura × fator[n-1] */
    upgradeCostFactor: [1, 1.75, 3, 5],
  },

  // ---------------------------------------------------------- alarmes do job de invariantes
  alerts: {
    /** emissão líquida do Tesouro por hora acima disto = alarme (log + auditoria) */
    maxEmissionPerHour: reais(5_000_000),
    /** saldo do GOVERNO abaixo disto = alarme */
    minGovernmentBalance: reais(-10_000_000),
  },

  // ---------------------------------------------------------- ranking
  leaderboard: { size: 50, minStep: reais(1_000), significantDigits: 2 },
} as const;

export type BusinessType = keyof typeof ECONOMY.business.types;
export const BUSINESS_TYPES = Object.keys(ECONOMY.business.types) as BusinessType[];
