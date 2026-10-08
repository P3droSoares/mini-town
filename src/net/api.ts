/**
 * Cliente tipado da API do jogo online (contrato: docs/ARQUITETURA-ONLINE.md §4 e §6).
 *
 * - mesma origem (`/api`, via Caddy), cookie de sessão HttpOnly — nada de
 *   token/senha em `localStorage`
 * - CSRF (`X-CSRF-Token`) e `Idempotency-Key` automáticos
 * - 401 => `onUnauthorized` (a UI volta para a tela de login)
 * - 503 MAINTENANCE => `onMaintenance` (economia travada; leitura continua)
 * - polling envia `X-Background: 1` (não conta como atividade do jogador);
 *   ações do jogador enviam `X-User-Activity: 1`
 * - o cliente só envia intenções; preço, saldo e dono vêm sempre do servidor
 *
 * Os tipos abaixo espelham exatamente o que o servidor envia (sem formatos
 * alternativos): campo renomeado no servidor = erro visível, não tela vazia.
 */
import type { BusinessType, Category } from './rules';

export type { BusinessType };
export type PropertyCategory = Category;

/** inteiro em centavos, serializado como string (sem perda de precisão no JS) */
export type Cents = string;

export interface User {
  id: string;
  displayName: string;
  createdAt: string;
}

export interface AuthResult {
  user: User;
  csrfToken: string;
}

export interface Wallet {
  balance: Cents;
  netWorth: Cents;
  /** renda líquida pendente (bruta − IPTU); pode ser negativa (só IPTU) */
  pendingIncome: Cents;
  starterAvailable: boolean;
  /** IPTU vencido que não coube no saldo (cobrado antes de qualquer renda) */
  taxDebt: Cents;
  /** conta nova: mercado entre jogadores liberado a partir desta data (null = liberado) */
  marketUnlockAt: string | null;
  /** extensão opcional: renda bruta e IPTU pendentes separados */
  pendingGross?: Cents;
  pendingTax?: Cents;
}

/** opção de negócio calculada pelo servidor (extensão opcional, só dono) */
export interface BusinessOption {
  type: BusinessType;
  openCost: Cents;
  competitors: number;
  projectedIncomePerHour: Cents;
}

export interface PropertyView {
  lotId: string;
  category: PropertyCategory;
  area: number;
  levels: number;
  address: string | null;
  appraisal: Cents;
  cityPrice: Cents | null;
  buyable: boolean;
  owner: { displayName: string } | null;
  mine: boolean;
  isResidence: boolean;
  business: { type: BusinessType; level: number } | null;
  /** suspended = preço saiu da faixa permitida (índice mudou); não pode ser comprado */
  listing: { id: string; askPrice: Cents; suspended: boolean } | null;
  incomePerHour: Cents;
  /** só dono: casa inicial travada para venda até esta data (ISO) */
  lockedUntil: string | null;
  /** só dono: custo do próximo nível do negócio */
  upgradeCost: Cents | null;
  /** só dono de comercial sem negócio: custo de abertura */
  openBusinessCost: Cents | null;
  /** extensões opcionais (cotações prontas do servidor; sem elas o cliente estima com `net/rules`) */
  /** mesma regra de `claimStarterHome` */
  starterEligible?: boolean;
  /** só dono: quanto a prefeitura pagaria agora */
  sellToCityQuote?: Cents;
  /** só dono: faixa de preço aceita num anúncio */
  askRange?: { min: Cents; max: Cents };
  /** extensão opcional (dono de comercial sem negócio): custo, concorrentes e renda projetada por tipo */
  businessOptions?: BusinessOption[];
}

/** anúncio do mercado entre jogadores */
export interface ListingView {
  id: string;
  lotId: string;
  category: PropertyCategory;
  address: string | null;
  area: number;
  levels: number;
  askPrice: Cents;
  appraisal: Cents;
  seller: { displayName: string };
  mine: boolean;
  createdAt: string;
}

/** lançamento do extrato do jogador (valor com sinal: negativo = saída) */
export interface TxView {
  id: string;
  kind: string;
  lotId: string | null;
  amount: Cents;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Ownership {
  mine: string[];
  listed: string[];
  /** todos os imóveis com dono (usado para filtrar a aba "Prefeitura") */
  owned: string[];
}

export interface RecentSale {
  kind: string;
  lotId: string;
  category: PropertyCategory;
  price: Cents;
  at: string;
}

export interface MarketOverview {
  /** `{ categoria: índice }` (1,0 = neutro) */
  indices: Partial<Record<PropertyCategory, number>>;
  recentSales: RecentSale[];
  stats: { players: number; ownedProperties: number; activeListings: number; moneySupply: Cents };
}

export interface LeaderboardItem {
  rank: number;
  displayName: string;
  netWorth: Cents;
}

export interface CollectResult {
  collected: Cents;
  tax: Cents;
  wallet: Wallet;
}

export interface PropertyWallet {
  property: PropertyView;
  wallet: Wallet;
}

/** erro de API normalizado (`message` em pt-BR, pronto para `textContent`) */
export class ApiError extends Error {
  /** segundos do `Retry-After` (429), se houver */
  readonly retryAfter: number | null;
  /** `error.details` do servidor (ex.: `{ min, max }`), se houver */
  readonly details: unknown;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    extra: { retryAfter?: number | null; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.retryAfter = extra.retryAfter ?? null;
    this.details = extra.details;
  }
  /** economia travada (modo manutenção): servidor no ar, leitura liberada */
  get maintenance() {
    return this.status === 503 && this.code === 'MAINTENANCE';
  }
  /** requisição cancelada pelo próprio cliente (resposta não interessa mais) */
  get aborted() {
    return this.code === 'ABORTED';
  }
  /** servidor inalcançável (sem backend, rede, proxy/servidor reiniciando) */
  get offline() {
    if (this.aborted || this.maintenance) return false;
    return this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504;
  }
  /**
   * Resultado incerto ou recusa temporária: repetir a MESMA intenção com a
   * mesma Idempotency-Key é seguro (rede, 5xx, 408, 429). 4xx de regra não.
   */
  get retryable() {
    if (this.aborted) return false;
    return this.status === 0 || this.status >= 500 || this.status === 408 || this.status === 429;
  }
}

/** formato do `lotId` aceito pelo servidor (validado antes de montar a URL) */
export const LOT_ID_RE = /^ITB-[A-Z0-9-]{1,40}$/;

/** UUID v4 para `Idempotency-Key` (randomUUID só existe em contexto seguro) */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

interface RequestOptions {
  body?: unknown;
  /** `true` = gera chave nova; string = reaproveita (repetição da mesma intenção) */
  idempotency?: boolean | string;
  /** 401 aqui é esperado (login, /me): não dispara `onUnauthorized` */
  quiet401?: boolean;
  query?: Record<string, string | null | undefined>;
  /** consulta automática (polling): não renova a inatividade da sessão */
  background?: boolean;
  /** cancelamento externo (ex.: painel trocou de imóvel) */
  signal?: AbortSignal;
}

const TIMEOUT_MS = 15000;

/** `Retry-After` em segundos (só a forma numérica) */
function retryAfterOf(res: Response): number | null {
  const v = Number(res.headers.get('retry-after'));
  return Number.isFinite(v) && v > 0 ? Math.ceil(v) : null;
}

export class Api {
  private csrf: string | null = null;
  /** sessão inválida/expirada numa rota autenticada */
  onUnauthorized: (() => void) | null = null;
  /** economia entrou (true) ou saiu (false) do modo manutenção */
  onMaintenance: ((active: boolean) => void) | null = null;

  constructor(private readonly base = '/api') {}

  get hasCsrf() {
    return this.csrf !== null;
  }

  // ---------------------------------------------------------------- núcleo

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
    let url = this.base + path;
    if (opts.query) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) if (v) q.set(k, v);
      const s = q.toString();
      if (s) url += `?${s}`;
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (method !== 'GET' && this.csrf) headers['X-CSRF-Token'] = this.csrf;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    // atividade do jogador renova a sessão; polling não (expiração por inatividade, §2.5)
    if (opts.background) headers['X-Background'] = '1';
    else headers['X-User-Activity'] = '1';
    // a chave é fixada aqui para a repetição por CSRF usar a mesma
    if (opts.idempotency === true) opts = { ...opts, idempotency: newIdempotencyKey() };
    if (typeof opts.idempotency === 'string') headers['Idempotency-Key'] = opts.idempotency;

    if (opts.signal?.aborted) throw new ApiError(0, 'ABORTED', 'Cancelado.');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const onAbort = () => ctl.abort();
    opts.signal?.addEventListener('abort', onAbort);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctl.signal,
      });
    } catch {
      if (opts.signal?.aborted) throw new ApiError(0, 'ABORTED', 'Cancelado.');
      throw new ApiError(0, 'NETWORK', 'Servidor offline ou sem conexão. Tente de novo em instantes.');
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }

    const economic = method !== 'GET' && typeof opts.idempotency === 'string';
    if (res.status === 204) {
      if (economic) this.onMaintenance?.(false);
      return undefined as T;
    }
    const json = (res.headers.get('content-type') ?? '').includes('application/json');
    // sem backend (vite puro) o fallback devolve index.html: trata como offline
    if (!json) {
      if (res.ok || res.status === 404) throw new ApiError(0, 'NO_BACKEND', 'Servidor offline: o jogo online não está disponível agora.');
      throw new ApiError(res.status, 'HTTP_' + res.status, `Falha no servidor (HTTP ${res.status}).`, { retryAfter: retryAfterOf(res) });
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new ApiError(res.status, 'BAD_JSON', 'Resposta inválida do servidor.');
    }
    if (res.ok) {
      if (economic) this.onMaintenance?.(false);
      return data as T;
    }

    const err = (data as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
    const code = typeof err?.code === 'string' ? err.code : `HTTP_${res.status}`;
    const retryAfter = retryAfterOf(res);
    const message = typeof err?.message === 'string' && err.message ? err.message : defaultMessage(res.status, retryAfter);
    if (res.status === 401) {
      this.csrf = null;
      if (!opts.quiet401) this.onUnauthorized?.();
    }
    if (res.status === 503 && code === 'MAINTENANCE') this.onMaintenance?.(true);
    // token CSRF velho (rotação no servidor): renova pela sessão e repete uma vez
    if (res.status === 403 && /CSRF/i.test(code) && !retried && method !== 'GET') {
      let renewed = false;
      try {
        renewed = (await this.me()) !== null;
      } catch {
        /* cai no erro original */
      }
      // mesma `opts` => mesma Idempotency-Key na repetição
      if (renewed) return this.request<T>(method, path, opts, true);
    }
    throw new ApiError(res.status, code, message, { retryAfter, details: err?.details });
  }

  private remember<T extends { csrfToken: string }>(r: T): T {
    this.csrf = typeof r.csrfToken === 'string' ? r.csrfToken : null;
    return r;
  }

  private lot(lotId: string): string {
    if (!LOT_ID_RE.test(lotId)) throw new ApiError(400, 'BAD_LOT', 'Imóvel inválido.');
    return encodeURIComponent(lotId);
  }

  // ---------------------------------------------------------------- saúde / auth

  /** `true` se o backend responde; nunca lança */
  async health(): Promise<boolean> {
    try {
      const r = await this.request<{ ok?: boolean }>('GET', '/health', { quiet401: true, background: true });
      return r?.ok === true;
    } catch {
      return false;
    }
  }

  /** sessão atual; `null` se não autenticado */
  async me(background = false): Promise<AuthResult | null> {
    try {
      return this.remember(await this.request<AuthResult>('GET', '/auth/me', { quiet401: true, background }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  }

  async register(displayName: string, email: string, password: string): Promise<AuthResult> {
    return this.remember(await this.request<AuthResult>('POST', '/auth/register', { body: { displayName, email, password }, quiet401: true }));
  }

  async login(email: string, password: string): Promise<AuthResult> {
    return this.remember(await this.request<AuthResult>('POST', '/auth/login', { body: { email, password }, quiet401: true }));
  }

  /**
   * Encerra a sessão no servidor. Só esquece o token quando o servidor
   * confirma (204) ou a sessão já não existe (401); outra falha lança e o
   * estado local continua "logado" (o cookie ainda vale).
   */
  logout(): Promise<void> {
    return this.endSession('/auth/logout');
  }

  logoutAll(): Promise<void> {
    return this.endSession('/auth/logout-all');
  }

  private async endSession(path: string): Promise<void> {
    try {
      await this.request<void>('POST', path, { quiet401: true });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) throw e;
    }
    this.csrf = null;
  }

  changePassword(currentPassword: string, newPassword: string): Promise<void> {
    return this.request<void>('POST', '/auth/password', { body: { currentPassword, newPassword } });
  }

  // ---------------------------------------------------------------- jogador

  wallet(background = false): Promise<Wallet> {
    return this.request<Wallet>('GET', '/me/wallet', { background });
  }

  myProperties(): Promise<{ properties: PropertyView[] }> {
    return this.request('GET', '/me/properties');
  }

  transactions(cursor?: string | null): Promise<Page<TxView>> {
    return this.request('GET', '/me/transactions', { query: { cursor } });
  }

  // ---------------------------------------------------------------- imóveis

  async property(lotId: string, signal?: AbortSignal): Promise<PropertyView> {
    return this.request('GET', `/properties/${this.lot(lotId)}`, { signal });
  }

  ownership(background = false): Promise<Ownership> {
    return this.request('GET', '/properties/ownership', { background });
  }

  starterHomes(): Promise<{ homes: PropertyView[] }> {
    return this.request('GET', '/starter-homes');
  }

  async claimStarter(lotId: string, key: string): Promise<PropertyWallet> {
    this.lot(lotId);
    return this.request('POST', '/starter-homes/claim', { body: { lotId }, idempotency: key });
  }

  async buyFromCity(lotId: string, key: string): Promise<PropertyWallet> {
    return this.request('POST', `/properties/${this.lot(lotId)}/buy`, { idempotency: key });
  }

  async sellToCity(lotId: string, key: string): Promise<{ wallet: Wallet }> {
    return this.request('POST', `/properties/${this.lot(lotId)}/sell-to-city`, { idempotency: key });
  }

  async setResidence(lotId: string, key: string): Promise<{ property: PropertyView }> {
    return this.request('POST', `/properties/${this.lot(lotId)}/residence`, { idempotency: key });
  }

  async openBusiness(lotId: string, type: BusinessType, key: string): Promise<PropertyWallet> {
    return this.request('POST', `/properties/${this.lot(lotId)}/business`, { body: { type }, idempotency: key });
  }

  async upgradeBusiness(lotId: string, key: string): Promise<PropertyWallet> {
    return this.request('POST', `/properties/${this.lot(lotId)}/business/upgrade`, { idempotency: key });
  }

  collectIncome(key: string): Promise<CollectResult> {
    return this.request('POST', '/income/collect', { idempotency: key });
  }

  // ---------------------------------------------------------------- mercado

  listings(category?: string | null, cursor?: string | null): Promise<Page<ListingView>> {
    return this.request('GET', '/market/listings', { query: { category, cursor } });
  }

  /** `askPrice` em centavos inteiros (o servidor valida a faixa permitida) */
  async createListing(lotId: string, askPrice: bigint, key: string): Promise<ListingView> {
    this.lot(lotId);
    const n = Number(askPrice);
    if (!Number.isSafeInteger(n) || n <= 0) throw new ApiError(400, 'BAD_PRICE', 'Preço inválido.');
    return this.request('POST', '/market/listings', { body: { lotId, askPrice: n }, idempotency: key });
  }

  cancelListing(id: string, key: string): Promise<void> {
    return this.request('DELETE', `/market/listings/${encodeURIComponent(id)}`, { idempotency: key });
  }

  buyListing(id: string, key: string): Promise<PropertyWallet> {
    return this.request('POST', `/market/listings/${encodeURIComponent(id)}/buy`, { idempotency: key });
  }

  overview(): Promise<MarketOverview> {
    return this.request('GET', '/market/overview');
  }

  leaderboard(): Promise<{ items: LeaderboardItem[] }> {
    return this.request('GET', '/leaderboard');
  }
}

function defaultMessage(status: number, retryAfter: number | null): string {
  if (status === 401) return 'Sua sessão expirou. Entre novamente.';
  if (status === 403) return 'Ação não permitida.';
  if (status === 404) return 'Não encontrado.';
  if (status === 409) return 'Conflito: os dados mudaram. Atualize e tente de novo.';
  if (status === 429) return retryAfter ? `Muitas tentativas. Aguarde ${retryAfter} s e tente de novo.` : 'Muitas tentativas. Aguarde um pouco.';
  if (status >= 500) return 'Erro no servidor. Tente de novo em instantes.';
  return 'Não foi possível concluir a operação.';
}

/** mensagem para o jogador, com o tempo de espera do 429 quando conhecido */
export function describeError(e: ApiError): string {
  if (e.status === 429 && e.retryAfter && !/\d+\s*s\b/.test(e.message)) return `${e.message} (aguarde ${e.retryAfter} s)`;
  return e.message;
}
