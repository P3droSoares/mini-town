import { Api, ApiError, type MarketOverview, type Ownership, type User, type Wallet } from './api';

/**
 * Estado da sessão online no cliente (espelho do que o servidor diz).
 *  - checking: verificando servidor/sessão
 *  - offline: sem backend (o mapa continua jogável, só exploração)
 *  - anonymous: servidor no ar, sem sessão
 *  - online: autenticado
 *
 * Além do status, a "qualidade do link" (evento `link`):
 *  - reconnecting: online, mas as últimas consultas falharam (502/rede) —
 *    tenta de novo sozinho com espera crescente; só vira `offline` depois de
 *    várias falhas confirmadas por `/api/health`
 *  - maintenance: economia travada no servidor (503 MAINTENANCE); leitura ok
 */
export type OnlineStatus = 'checking' | 'offline' | 'anonymous' | 'online';

export type StoreEvent = 'status' | 'wallet' | 'ownership' | 'link';

const WALLET_POLL_MS = 30000;
const OWNERSHIP_POLL_MS = 60000;
/** sem ponteiro/teclado por este tempo = jogador ausente: polling para (a sessão expira sozinha em 30 min) */
export const IDLE_MS = 25 * 60_000;
/** falhas seguidas (com /health também falhando) até declarar offline */
const OFFLINE_AFTER = 3;
/** espera entre tentativas enquanto "reconectando" (ms) */
const PROBE_DELAYS = [5000, 10000, 20000, 40000, 60000];
/** reconexão automática depois de offline (ms; o último se repete) */
const RECONNECT_DELAYS = [2000, 5000, 15000, 30000, 60000];

/** tempo que o aviso de manutenção fica no HUD sem nova recusa */
const MAINTENANCE_SHOW_MS = 120_000;

const jitter = (ms: number) => Math.round(ms * (0.85 + Math.random() * 0.3));

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function sameWallet(a: Wallet | null, b: Wallet | null): boolean {
  if (!a || !b) return a === b;
  return a.balance === b.balance && a.netWorth === b.netWorth && a.pendingIncome === b.pendingIncome && a.starterAvailable === b.starterAvailable && a.pendingGross === b.pendingGross && a.pendingTax === b.pendingTax;
}

export class OnlineStore {
  readonly api: Api;
  status: OnlineStatus = 'checking';
  user: User | null = null;
  wallet: Wallet | null = null;
  /** lotIds: meus, à venda (de qualquer um), com dono (qualquer um) */
  mine = new Set<string>();
  listed = new Set<string>();
  owned = new Set<string>();
  /** motivo do último 401 (mensagem para a tela de login) */
  expiredMessage: string | null = null;
  /** consultas de fundo falhando; tentando de novo sozinho */
  reconnecting = false;
  /** economia em manutenção (503 MAINTENANCE) */
  maintenance = false;

  private readonly listeners = new Map<StoreEvent, Set<() => void>>();
  private walletTimer = 0;
  private ownershipTimer = 0;
  private walletSeq = 0;
  private ownershipSeq = 0;
  private failures = 0;
  private probeTimer = 0;
  private reconnectTimer = 0;
  private reconnectTry = 0;
  /** usuário da sessão que caiu para offline (reconecta sozinho) */
  private lostUser: User | null = null;
  private lastActivity = Date.now();
  private maintenanceTimer = 0;
  /** índices do mercado (público), com cache curto */
  private idxCache: { at: number; v: MarketOverview['indices'] } | null = null;
  /** remove os ouvintes globais em `dispose()` */
  private readonly life = new AbortController();

  constructor(api = new Api()) {
    this.api = api;
    api.onUnauthorized = () => {
      if (!this.user && !this.lostUser) return;
      this.expiredMessage = 'Sua sessão expirou. Entre novamente.';
      this.setAnonymous();
    };
    api.onMaintenance = (active) => {
      clearTimeout(this.maintenanceTimer);
      // o aviso some sozinho; a próxima operação recusada o mostra de novo
      if (active) this.maintenanceTimer = window.setTimeout(() => api.onMaintenance?.(false), MAINTENANCE_SHOW_MS);
      if (this.maintenance === active) return;
      this.maintenance = active;
      this.emit('link');
    };
    const signal = this.life.signal;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      // voltar à aba é interação do jogador
      this.lastActivity = Date.now();
      if (this.status === 'online') {
        void this.refreshWallet();
        void this.refreshOwnership();
      } else if (this.status === 'offline' && this.lostUser) void this.reconnect();
    }, { signal });
    const active = () => {
      const wasIdle = this.idle;
      this.lastActivity = Date.now();
      // voltou depois de ausência: atualiza já (a sessão pode ter expirado => 401 => login)
      if (wasIdle && this.status === 'online') {
        void this.refreshWallet();
        void this.refreshOwnership();
      }
    };
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) window.addEventListener(ev, active, { capture: true, passive: true, signal });
  }

  /** índices por categoria (cache de 5 min; falha = último conhecido ou null) */
  async marketIndices(): Promise<MarketOverview['indices'] | null> {
    if (this.idxCache && Date.now() - this.idxCache.at < 300_000) return this.idxCache.v;
    try {
      const o = await this.api.overview();
      this.idxCache = { at: Date.now(), v: o.indices };
      return o.indices;
    } catch {
      return this.idxCache?.v ?? null;
    }
  }

  /** desliga timers e ouvintes (testes; troca de store) */
  dispose() {
    this.life.abort();
    this.stopPolling();
    this.clearTimers();
    clearTimeout(this.maintenanceTimer);
    this.status = 'offline';
  }

  /** jogador sem interagir há mais de IDLE_MS */
  get idle(): boolean {
    return Date.now() - this.lastActivity > IDLE_MS;
  }

  on(ev: StoreEvent, fn: () => void): () => void {
    let set = this.listeners.get(ev);
    if (!set) this.listeners.set(ev, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private emit(ev: StoreEvent) {
    for (const fn of this.listeners.get(ev) ?? []) {
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    }
  }

  /** verifica backend e sessão (sem lançar) */
  async connect(): Promise<void> {
    this.clearTimers();
    this.setStatus('checking');
    if (!(await this.api.health())) return this.goOffline();
    try {
      const me = await this.api.me();
      if (me) await this.setUser(me.user);
      else {
        if (this.lostUser) this.expiredMessage = 'Sua sessão expirou. Entre novamente.';
        this.setAnonymous();
      }
    } catch (e) {
      console.warn('[online] falha ao consultar sessão', e);
      if (e instanceof ApiError && e.offline) this.goOffline();
      else this.setAnonymous();
    }
  }

  async login(email: string, password: string) {
    const r = await this.api.login(email, password);
    await this.setUser(r.user);
  }

  async register(displayName: string, email: string, password: string) {
    const r = await this.api.register(displayName, email, password);
    await this.setUser(r.user);
  }

  /**
   * Encerra a sessão. Só limpa o estado local depois que o servidor confirma;
   * se falhar (rede, 5xx, 429) lança e o jogador continua logado na UI —
   * o cookie ainda vale e a interface não pode fingir o contrário.
   */
  async logout(all = false) {
    if (all) await this.api.logoutAll();
    else await this.api.logout();
    this.expiredMessage = null;
    this.setAnonymous();
  }

  private async setUser(user: User) {
    // outra conta na mesma aba: nada da anterior pode sobrar
    if (this.user && this.user.id !== user.id) this.clearData();
    this.user = user;
    this.lostUser = null;
    this.expiredMessage = null;
    this.failures = 0;
    this.reconnecting = false;
    this.clearTimers();
    this.setStatus('online');
    this.startPolling();
    await Promise.all([this.refreshWallet(true), this.refreshOwnership(true)]);
  }

  private clearData() {
    const had = this.mine.size > 0 || this.listed.size > 0;
    this.wallet = null;
    this.mine = new Set();
    this.listed = new Set();
    this.owned = new Set();
    this.emit('wallet');
    if (had) this.emit('ownership');
  }

  private setAnonymous() {
    this.user = null;
    this.lostUser = null;
    this.stopPolling();
    this.clearTimers();
    this.failures = 0;
    this.reconnecting = false;
    this.maintenance = false;
    // mapa de donos vem de rota autenticada: sem sessão, sem destaques
    this.clearData();
    this.setStatus('anonymous');
    this.emit('link');
  }

  private setStatus(s: OnlineStatus) {
    if (s !== 'online') this.stopPolling();
    this.status = s;
    this.emit('status');
  }

  /** aplica a carteira devolvida por uma operação econômica */
  applyWallet(w: Wallet | null | undefined) {
    if (!w) return;
    this.walletSeq++; // invalida consultas em andamento (resposta velha)
    if (sameWallet(this.wallet, w)) return;
    this.wallet = w;
    this.emit('wallet');
  }

  /** `foreground` = pedido do jogador (conta como atividade da sessão) */
  async refreshWallet(foreground = false): Promise<void> {
    if (this.status !== 'online') return;
    const seq = ++this.walletSeq;
    try {
      const w = await this.api.wallet(!foreground);
      if (seq !== this.walletSeq || this.status !== 'online') return;
      this.healthy();
      if (sameWallet(this.wallet, w)) return;
      this.wallet = w;
      this.emit('wallet');
    } catch (e) {
      this.handleBackgroundError(e);
    }
  }

  async refreshOwnership(foreground = false): Promise<void> {
    if (this.status !== 'online') return;
    const seq = ++this.ownershipSeq;
    try {
      const o: Ownership = await this.api.ownership(!foreground);
      if (seq !== this.ownershipSeq || this.status !== 'online') return;
      this.healthy();
      const mine = new Set(o.mine);
      const listed = new Set(o.listed);
      this.owned = new Set(o.owned);
      // só avisa (e o 3D/minimapa só redesenham) quando algo mudou
      if (sameSet(mine, this.mine) && sameSet(listed, this.listed)) return;
      this.mine = mine;
      this.listed = listed;
      this.emit('ownership');
    } catch (e) {
      this.handleBackgroundError(e);
    }
  }

  /** depois de qualquer operação: carteira (se não veio) + mapa de donos */
  async afterTrade(w?: Wallet | null) {
    if (w) this.applyWallet(w);
    else await this.refreshWallet(true);
    await this.refreshOwnership(true);
  }

  // ---------------------------------------------------------------- falhas e reconexão

  private healthy() {
    this.failures = 0;
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = 0;
    }
    if (this.reconnecting) {
      this.reconnecting = false;
      this.emit('link');
    }
  }

  private handleBackgroundError(e: unknown) {
    if (e instanceof ApiError && e.offline) {
      // falha transitória (reinício do server, 502 do proxy): não derruba a sessão
      this.failures++;
      if (!this.reconnecting) {
        this.reconnecting = true;
        this.emit('link');
      }
      this.scheduleProbe();
    } else if (!(e instanceof ApiError && (e.status === 401 || e.aborted))) console.warn('[online]', e);
  }

  /** testa /health com espera crescente; sem resposta várias vezes = offline */
  private scheduleProbe() {
    if (this.probeTimer || this.status !== 'online') return;
    const delay = PROBE_DELAYS[Math.min(this.failures - 1, PROBE_DELAYS.length - 1)] ?? PROBE_DELAYS[0];
    this.probeTimer = window.setTimeout(async () => {
      this.probeTimer = 0;
      if (this.status !== 'online') return;
      if (await this.api.health()) {
        await Promise.all([this.refreshWallet(), this.refreshOwnership()]);
        return;
      }
      if (this.status !== 'online') return;
      this.failures++;
      if (this.failures >= OFFLINE_AFTER) this.goOffline();
      else this.scheduleProbe();
    }, jitter(delay));
  }

  private goOffline() {
    if (this.user) this.lostUser = this.user;
    this.reconnecting = false;
    this.setStatus('offline');
    this.emit('link');
    if (this.lostUser) this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectTry, RECONNECT_DELAYS.length - 1)];
    this.reconnectTry++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0;
      if (this.status === 'offline' && this.lostUser) void this.reconnect();
    }, jitter(delay));
  }

  /** volta sozinho depois de offline (sem passar por "Conectando…") */
  private async reconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
    }
    if (!(await this.api.health())) return this.scheduleReconnect();
    try {
      const me = await this.api.me(true);
      if (this.status !== 'offline') return;
      if (me) await this.setUser(me.user);
      else {
        // a sessão expirou enquanto o servidor estava fora
        this.expiredMessage = 'Sua sessão expirou. Entre novamente.';
        this.setAnonymous();
      }
    } catch {
      this.scheduleReconnect();
    }
  }

  private clearTimers() {
    clearTimeout(this.probeTimer);
    clearTimeout(this.reconnectTimer);
    this.probeTimer = this.reconnectTimer = 0;
    this.reconnectTry = 0;
  }

  private startPolling() {
    this.stopPolling();
    // só com a aba visível e o jogador presente: aba esquecida não mantém a sessão viva
    const due = () => document.visibilityState === 'visible' && !this.idle;
    this.walletTimer = window.setInterval(() => due() && void this.refreshWallet(), WALLET_POLL_MS);
    this.ownershipTimer = window.setInterval(() => due() && void this.refreshOwnership(), OWNERSHIP_POLL_MS);
  }

  private stopPolling() {
    clearInterval(this.walletTimer);
    clearInterval(this.ownershipTimer);
  }
}
