import { newIdempotencyKey } from '../net/api';
import { cents, formatMoney, formatMoneyShort } from '../net/money';
import { RULES } from '../net/rules';
import type { OnlineStore } from '../net/store';
import { ICONS, h, iconEl } from './dom';
import { confirmAction, errorMessage, setBusy } from './modal';

/**
 * HUD econômico: saldo, patrimônio, renda pendente (coletar), Mercado e menu
 * da conta. Sem servidor mostra "servidor offline"; sem sessão, "Entrar".
 */
export class EconomyHud {
  readonly el: HTMLElement;
  private readonly balance = h('b', {}, '—');
  private readonly netWorth = h('b', {}, '—');
  private readonly collectBtn: HTMLButtonElement;
  private readonly collectAmount = h('span', { class: 'amt' }, '');
  private readonly accountBtn: HTMLButtonElement;
  private readonly accountName = h('span', { class: 'lbl' }, '');
  private readonly menu: HTMLElement;
  private readonly online: HTMLElement;
  private readonly status: HTMLElement;
  private readonly statusText = h('span', {}, '');
  private readonly statusBtn: HTMLButtonElement;
  /** reconectando / economia em manutenção */
  private readonly linkNote = h('div', { class: 'econ-link', role: 'status', hidden: true });
  private collecting = false;
  onMarket: (() => void) | null = null;
  onLogin: (() => void) | null = null;
  /** `error` = variante persistente do aviso */
  onToast: ((m: string, error?: boolean) => void) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly store: OnlineStore,
  ) {
    this.collectBtn = h(
      'button',
      { type: 'button', class: 'btn collect', onclick: () => void this.collect() },
      iconEl(ICONS.coins),
      h('span', { class: 'lbl' }, 'Coletar'),
      this.collectAmount,
    ) as HTMLButtonElement;
    const marketBtn = h('button', { type: 'button', class: 'btn', onclick: () => this.onMarket?.() }, iconEl(ICONS.market), h('span', { class: 'lbl' }, 'Mercado'));
    marketBtn.setAttribute('aria-label', 'Abrir mercado');

    const item = (label: string, fn: () => void) =>
      h('button', {
        type: 'button',
        role: 'menuitem',
        tabindex: '-1',
        onclick: () => {
          this.toggleMenu(false);
          fn();
        },
      }, label);
    this.menu = h(
      'div',
      { class: 'acct-menu card', role: 'menu', 'aria-label': 'Conta', hidden: true },
      item('Trocar senha', () =>
        void import('./PasswordDialog').then(
          (m) => m.openPasswordDialog(store, (msg) => this.onToast?.(msg)),
          (e) => this.onToast?.(errorMessage(e), true),
        ),
      ),
      item('Sair', () => void this.logout(false)),
      item('Sair de todos os aparelhos', () =>
        void confirmAction({
          title: 'Sair de todos os aparelhos?',
          note: 'Todas as sessões desta conta serão encerradas, inclusive esta. Se a rede falhar, você continua conectado e pode tentar de novo.',
          confirmLabel: 'Sair de todos',
          busyLabel: 'Saindo…',
          run: async () => {
            await this.store.logout(true);
            this.onToast?.('Pronto: todas as sessões desta conta foram encerradas.');
          },
        }),
      ),
    );
    this.menu.addEventListener('keydown', this.onMenuKey);
    this.accountBtn = h(
      'button',
      { type: 'button', class: 'btn acct', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => this.toggleMenu() },
      iconEl(ICONS.user),
      this.accountName,
    ) as HTMLButtonElement;

    this.online = h(
      'div',
      { class: 'econ-online' },
      h('div', { class: 'stat', title: 'Saldo disponível' }, h('small', {}, 'Saldo'), this.balance),
      h('div', { class: 'stat', title: 'Saldo + avaliação dos imóveis' }, h('small', {}, 'Patrimônio'), this.netWorth),
      this.collectBtn,
      marketBtn,
      h('div', { class: 'acct-wrap' }, this.accountBtn, this.menu),
    );
    this.statusBtn = h('button', { type: 'button', class: 'btn primary' }, 'Entrar') as HTMLButtonElement;
    this.statusBtn.addEventListener('click', () => {
      if (store.status === 'anonymous') return this.onLogin?.();
      // servidor voltou: sem sessão, já oferece o login
      if (store.status === 'offline') void store.connect().then(() => store.status === 'anonymous' && this.onLogin?.());
    });
    this.status = h('div', { class: 'econ-status' }, iconEl(ICONS.cloudOff), this.statusText, this.statusBtn);
    this.el = h('div', { class: 'econ card', role: 'region', 'aria-label': 'Carteira' }, this.status, this.online, this.linkNote);
    parent.append(this.el);

    document.addEventListener('pointerdown', (e) => {
      if (!this.menu.hidden && !this.menu.parentElement!.contains(e.target as Node)) this.toggleMenu(false);
    });
    store.on('status', () => this.render());
    store.on('wallet', () => {
      this.renderWallet();
      this.renderLink();
    });
    store.on('link', () => this.renderLink());
    // formato curto no celular: refaz ao cruzar o breakpoint
    matchMedia('(max-width: 720px)').addEventListener('change', () => this.renderWallet());
    this.render();
  }

  private render() {
    const s = this.store.status;
    const on = s === 'online';
    this.online.hidden = !on;
    this.status.hidden = on;
    this.el.dataset.status = s;
    this.toggleMenu(false);
    this.renderLink();
    if (on) {
      this.accountName.textContent = this.store.user?.displayName ?? 'Conta';
      this.accountBtn.setAttribute('aria-label', `Conta de ${this.store.user?.displayName ?? ''}`);
      this.renderWallet();
      return;
    }
    const ico = this.status.firstElementChild as HTMLElement;
    ico.hidden = s !== 'offline';
    this.statusBtn.hidden = s === 'checking';
    if (s === 'checking') this.statusText.textContent = 'Conectando ao servidor…';
    else if (s === 'offline') {
      this.statusText.textContent = 'Servidor offline — só exploração';
      this.statusBtn.textContent = 'Tentar de novo';
      this.statusBtn.className = 'btn';
    } else {
      this.statusText.textContent = 'Modo exploração';
      this.statusBtn.textContent = 'Entrar';
      this.statusBtn.className = 'btn primary';
    }
  }

  private renderLink() {
    const st = this.store;
    const text =
      st.status !== 'online'
        ? ''
        : st.reconnecting
          ? 'Reconectando ao servidor…'
          : st.maintenance
            ? 'Economia em manutenção: compras e vendas pausadas. Você pode continuar olhando.'
            : cents(st.wallet?.taxDebt) > 0n
              ? `Dívida de IPTU: ${formatMoney(st.wallet?.taxDebt)} — descontada antes de qualquer renda.`
              : '';
    this.linkNote.textContent = text;
    this.linkNote.hidden = !text;
  }

  private renderWallet() {
    const w = this.store.wallet;
    const narrow = matchMedia('(max-width: 720px)').matches;
    const fmt = narrow ? formatMoneyShort : formatMoney;
    this.balance.textContent = w ? fmt(w.balance) : '—';
    this.netWorth.textContent = w ? fmt(w.netWorth) : '—';
    const pending = cents(w?.pendingIncome);
    // bruta e IPTU separados quando o servidor informa; senão só o líquido
    const gross = w?.pendingGross !== undefined ? cents(w.pendingGross) : null;
    const tax = w?.pendingTax !== undefined ? cents(w.pendingTax) : null;
    const onlyTax = pending < 0n;
    this.collectAmount.textContent = !w ? '' : onlyTax ? `IPTU ${formatMoneyShort(-pending)}` : formatMoneyShort(pending);
    // algo a liquidar (renda ou IPTU) = habilitado; amarelo só com renda a receber
    const something = gross !== null && tax !== null ? gross > 0n || tax > 0n : pending !== 0n;
    if (!this.collecting) this.collectBtn.disabled = !w || !something;
    this.collectBtn.classList.toggle('primary', pending > 0n);
    const detail =
      gross !== null && tax !== null
        ? `renda ${formatMoney(gross)}, IPTU ${formatMoney(tax)}, líquido ${formatMoney(pending)}`
        : onlyTax
          ? `IPTU a pagar ${formatMoney(-pending)} (sem renda acumulada)`
          : `${formatMoney(pending)} líquido (renda menos IPTU)`;
    this.collectBtn.setAttribute('aria-label', `Coletar renda: ${detail}`);
    this.collectBtn.title = onlyTax
      ? `Sua moradia não rende aluguel; o IPTU (${RULES.iptuPerDayPct} ao dia) acumula até ${RULES.maxAccrualHours} h e é pago ao coletar. Imóveis que não são a sua moradia geram renda.`
      : `Coletar: ${detail}. Acumula no máximo ${RULES.maxAccrualHours} h.`;
  }

  private async collect() {
    if (this.collecting) return;
    this.collecting = true;
    setBusy(this.collectBtn, true);
    try {
      const r = await this.store.api.collectIncome(newIdempotencyKey());
      this.store.applyWallet(r.wallet);
      const tax = cents(r.tax);
      const got = cents(r.collected);
      this.onToast?.(
        got > 0n ? `Renda coletada: ${formatMoney(got)}${tax > 0n ? ` (IPTU ${formatMoney(tax)})` : ''}` : tax > 0n ? `IPTU pago: ${formatMoney(tax)}` : 'Nada a coletar agora.',
      );
    } catch (e) {
      this.onToast?.(errorMessage(e), true);
    } finally {
      this.collecting = false;
      setBusy(this.collectBtn, false);
      this.renderWallet();
    }
  }

  private async logout(all: boolean) {
    try {
      await this.store.logout(all);
      this.onToast?.('Você saiu da conta.');
    } catch (e) {
      // a sessão continua válida: avisa de forma persistente e oferece repetir
      void confirmAction({
        title: 'Não foi possível sair',
        note: 'Sua sessão continua ativa neste aparelho. Verifique a conexão e tente de novo antes de deixar o computador.',
        warning: errorMessage(e),
        confirmLabel: 'Tentar sair de novo',
        busyLabel: 'Saindo…',
        run: async () => {
          await this.store.logout(all);
          this.onToast?.('Você saiu da conta.');
        },
      });
    }
  }

  private items(): HTMLButtonElement[] {
    return [...this.menu.querySelectorAll<HTMLButtonElement>('[role=menuitem]')];
  }

  private toggleMenu(open = this.menu.hidden) {
    if (open === !this.menu.hidden) return;
    this.menu.hidden = !open;
    this.accountBtn.setAttribute('aria-expanded', String(open));
    if (open) this.items()[0]?.focus();
  }

  private onMenuKey = (e: KeyboardEvent) => {
    const list = this.items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    // teclas do menu não chegam ao jogo (setas moveriam câmera/jogador)
    if (e.key !== 'Tab') e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.toggleMenu(false);
      this.accountBtn.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      list[e.key === 'Home' ? 0 : list.length - 1]?.focus();
    } else if (e.key === 'Tab') this.toggleMenu(false);
  };
}
