import type { ListingView, PropertyView, TxView } from '../net/api';
import type { CatalogEntry } from '../net/cityCatalog';
import { cents, formatMoney, sumCents } from '../net/money';
import { type Category, RULES, cityPriceFor, iptuPerHour, plainIncomePerHour, sellToCityMax, starterPays, withIndex } from '../net/rules';
import type { OnlineStore } from '../net/store';
import { ICONS, h, iconEl } from './dom';
import { TRADABLE, businessLabel, categoryLabel, formatArea, formatDate, formatPayback, money0, pctOf, propertyAddress, saleLabel, statLabel, txLabel } from './format';
import { Modal, confirmAction, errorMessage, fundsWarning } from './modal';
import { starterNote } from './PropertySection';

type TabId = 'starter' | 'city' | 'listings' | 'mine' | 'statement' | 'ranking' | 'indices';

const TABS: [TabId, string][] = [
  ['starter', 'Casa inicial'],
  ['city', 'Prefeitura'],
  ['listings', 'À venda'],
  ['mine', 'Meus imóveis'],
  ['statement', 'Extrato'],
  ['ranking', 'Ranking'],
  ['indices', 'Índices'],
];

/** itens por página na aba "Prefeitura" (paginação no cliente) */
const CITY_PAGE = 25;
/** metas de patrimônio (centavos) */
const NET_WORTH_GOALS = [100_000n, 250_000n, 1_000_000n, 5_000_000n, 25_000_000n].map((r) => r * 100n);

/**
 * Painel do mercado (modal com abas). Cada aba busca dados ao ser aberta;
 * todo texto do servidor entra por textContent (via `h`). Carregado sob
 * demanda (import dinâmico) no primeiro clique em "Mercado".
 */
export class MarketPanel {
  private readonly modal: Modal;
  private readonly tabBtns = new Map<TabId, HTMLButtonElement>();
  private readonly panel: HTMLElement;
  private tab: TabId = 'starter';
  private seq = 0;
  private listingCategory = '';
  private cityCategory: '' | Category = '';
  private cityAffordable = true;
  /** depois da casa inicial: orienta o próximo passo (renda) */
  private nextStepHint = false;
  private catalog: CatalogEntry[] | null = null;
  /** "ver no mapa": fecha o painel e voa até o lote */
  onGoTo: ((lotId: string) => void) | null = null;
  onToast: ((m: string, error?: boolean) => void) | null = null;

  constructor(
    private readonly store: OnlineStore,
    private readonly loadCatalog: () => CatalogEntry[],
  ) {
    this.modal = new Modal({ title: 'Mercado de Itabirito', className: 'wide market' });
    const list = h('div', { class: 'tabs scroll', role: 'tablist', 'aria-label': 'Seções do mercado' });
    for (const [id, label] of TABS) {
      const b = h('button', { type: 'button', role: 'tab', id: `mk-tab-${id}`, 'aria-controls': 'mk-panel', class: 'tab', onclick: () => this.select(id) }, label) as HTMLButtonElement;
      this.tabBtns.set(id, b);
      list.append(b);
    }
    list.addEventListener('keydown', (e) => {
      const ids = TABS.map((t) => t[0]);
      let i = ids.indexOf(this.tab);
      if (e.key === 'ArrowRight') i = (i + 1) % ids.length;
      else if (e.key === 'ArrowLeft') i = (i - 1 + ids.length) % ids.length;
      else if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = ids.length - 1;
      else return;
      e.preventDefault();
      this.select(ids[i]);
      this.tabBtns.get(ids[i])!.focus();
    });
    this.panel = h('div', { id: 'mk-panel', role: 'tabpanel', class: 'mk-panel', tabindex: '0' });
    this.modal.body.append(list, this.panel);
    // queda transitória ou offline não fecha o painel; sessão encerrada fecha
    // todos os diálogos (`closeAllModals` no main)
  }

  open(tab?: TabId) {
    if (this.store.status !== 'online') return;
    // sem casa inicial disponível, abre em "Prefeitura"
    const t = tab ?? (this.store.wallet?.starterAvailable ? 'starter' : this.tab === 'starter' ? 'city' : this.tab);
    this.modal.open(this.tabBtns.get(t));
    this.select(t);
  }

  close() {
    this.modal.close();
  }

  private select(id: TabId) {
    this.tab = id;
    for (const [k, b] of this.tabBtns) {
      const on = k === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('active', on);
      if (on) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    this.panel.setAttribute('aria-labelledby', `mk-tab-${id}`);
    void this.load(id);
  }

  /** carrega a aba; respostas atrasadas de outra aba são descartadas */
  private async load(id: TabId) {
    const seq = ++this.seq;
    const stale = () => seq !== this.seq;
    this.panel.setAttribute('aria-busy', 'true');
    this.panel.replaceChildren(h('div', { class: 'skeleton' }, h('i'), h('i'), h('i'), h('i')));
    try {
      const content = await this.build(id, stale);
      if (stale()) return;
      this.panel.replaceChildren(content);
    } catch (e) {
      if (stale()) return;
      this.panel.replaceChildren(
        h('div', { class: 'err-box', role: 'alert' }, iconEl(ICONS.alert), h('span', {}, errorMessage(e))),
        h('button', { type: 'button', class: 'btn', onclick: () => void this.load(id) }, 'Tentar de novo'),
      );
    } finally {
      if (!stale()) this.panel.removeAttribute('aria-busy');
    }
  }

  private build(id: TabId, stale: () => boolean): Promise<HTMLElement> {
    switch (id) {
      case 'starter':
        return this.buildStarter();
      case 'city':
        return this.buildCity();
      case 'listings':
        return this.buildListings(stale);
      case 'mine':
        return this.buildMine();
      case 'statement':
        return this.buildStatement(stale);
      case 'ranking':
        return this.buildRanking();
      case 'indices':
        return this.buildIndices();
    }
  }

  /** recusa definitiva numa confirmação: a lista exibida ficou velha */
  private reloadTab = () => void this.load(this.tab);

  // ---------------------------------------------------------------- linhas

  private goBtn(lotId: string) {
    return h(
      'button',
      {
        type: 'button',
        class: 'btn small',
        'aria-label': 'Ver no mapa',
        title: 'Ver no mapa',
        onclick: () => {
          this.modal.close();
          this.onGoTo?.(lotId);
        },
      },
      iconEl(ICONS.pin),
      h('span', { class: 'lbl' }, 'Ver no mapa'),
    );
  }

  private propRow(
    p: { lotId: string; category: Category; address: string | null; area?: number; levels?: number; isResidence?: boolean; listing?: unknown; business?: PropertyView['business'] },
    price: Node | string | null,
    priceLabel: string,
    ...actions: (Node | null)[]
  ) {
    const meta = [categoryLabel(p.category), p.area ? formatArea(p.area) : null, p.levels ? `${p.levels} andar${p.levels > 1 ? 'es' : ''}` : null].filter(Boolean).join(' · ');
    const tags = h('span', { class: 'tags' });
    if (p.isResidence) tags.append(h('span', { class: 'tag accent' }, 'Moradia'));
    if (p.listing) tags.append(h('span', { class: 'tag' }, 'Anunciado'));
    if (p.business) tags.append(h('span', { class: 'tag' }, `${businessLabel(p.business.type)} nv ${p.business.level}`));
    return h(
      'li',
      { class: 'row-item' },
      h('div', { class: 'ri-main' }, h('b', {}, propertyAddress(p)), h('small', {}, meta), tags.childElementCount ? tags : null),
      price !== null ? h('div', { class: 'ri-price' }, h('b', {}, price), h('small', {}, priceLabel)) : null,
      h('div', { class: 'ri-actions' }, ...actions),
    );
  }

  private empty(text: string) {
    return h('p', { class: 'empty muted' }, text);
  }

  // ---------------------------------------------------------------- abas

  private async buildStarter(): Promise<HTMLElement> {
    const wrap = h('div');
    if (!this.store.wallet?.starterAvailable) {
      wrap.append(h('p', { class: 'notice' }, 'Você já escolheu sua casa inicial. Ela é sua moradia e não rende aluguel: para ter renda, compre outros imóveis na aba "Prefeitura" ou em "À venda".'));
      return wrap;
    }
    const { homes } = await this.store.api.starterHomes();
    wrap.append(h('p', { class: 'lead' }, `Escolha sua primeira casa: a prefeitura paga ${RULES.starterSubsidyPct} do preço. Vale uma vez por conta; a casa fica travada por ${RULES.starterLockDays} dias e vira sua moradia (sem aluguel).`));
    if (!homes.length) {
      wrap.append(this.empty('Nenhuma casa disponível agora. Tente mais tarde.'));
      return wrap;
    }
    const ul = h('ul', { class: 'rows' });
    for (const p of homes) {
      const price = cents(p.cityPrice ?? p.appraisal);
      const pay = starterPays(price);
      const choose = h(
        'button',
        {
          type: 'button',
          class: 'btn small primary',
          onclick: async () => {
            const balance = cents(this.store.wallet?.balance);
            const ok = await confirmAction({
              title: 'Escolher esta casa?',
              rows: [
                ['Imóvel', propertyAddress(p)],
                ['Preço', formatMoney(price)],
                ['Você paga (estimado)', formatMoney(pay)],
                ['Saldo depois (estimado)', formatMoney(balance - pay)],
              ],
              warning: fundsWarning(balance, pay),
              note: starterNote(),
              confirmLabel: 'Escolher',
              onRejected: this.reloadTab,
              run: async (key) => {
                const r = await this.store.api.claimStarter(p.lotId, key);
                await this.store.afterTrade(r.wallet);
              },
            });
            if (ok) {
              this.onToast?.('Bem-vindo à sua casa nova!');
              this.nextStepHint = true;
              this.select('city');
            }
          },
        },
        'Escolher',
      );
      ul.append(this.propRow(p, formatMoney(pay), `você paga · de ${formatMoney(price)}`, this.goBtn(p.lotId), choose));
    }
    wrap.append(ul);
    return wrap;
  }

  /**
   * Imóveis da prefeitura (sem dono) que dão renda, filtrados pelo saldo.
   * Lista estimada no cliente (catálogo + índices públicos); "Comprar" busca
   * o preço real no servidor antes de confirmar.
   */
  private async buildCity(): Promise<HTMLElement> {
    const overview = await this.store.api.overview();
    this.catalog ??= this.loadCatalog();
    const balance = cents(this.store.wallet?.balance);
    const wrap = h('div');
    if (this.nextStepHint) {
      wrap.append(h('p', { class: 'notice' }, 'Próximo passo: compre um imóvel que dê renda. A sua moradia não rende aluguel; os outros imóveis rendem por hora e você coleta pelo HUD.'));
    }
    const catId = 'mk-city-cat';
    const select = h(
      'select',
      { id: catId },
      h('option', { value: '' }, 'Com renda'),
      ...TRADABLE.map((c) => h('option', { value: c }, categoryLabel(c))),
    ) as HTMLSelectElement;
    select.value = this.cityCategory;
    select.addEventListener('change', () => {
      this.cityCategory = select.value as '' | Category;
      void this.load('city');
    });
    const affId = 'mk-city-aff';
    const aff = h('input', { id: affId, type: 'checkbox' }) as HTMLInputElement;
    aff.checked = this.cityAffordable;
    aff.addEventListener('change', () => {
      this.cityAffordable = aff.checked;
      void this.load('city');
    });
    wrap.append(
      h('div', { class: 'filter' }, h('label', { for: catId }, 'Categoria'), select, h('label', { class: 'check', for: affId }, aff, `Até o meu saldo (${money0(balance)})`)),
    );

    const owned = this.store.owned;
    const count = this.store.mine.size;
    const rows = this.catalog
      .filter((c) => !owned.has(c.lotId) && (this.cityCategory ? c.category === this.cityCategory : c.category !== 'vacant'))
      .map((c) => {
        const appraisal = withIndex(c.base, overview.indices[c.category] ?? 1);
        // preço da prefeitura é progressivo pelo nº de imóveis do comprador
        const price = cityPriceFor(appraisal, count);
        const net = plainIncomePerHour(c.category, appraisal) - iptuPerHour(appraisal, count + 1);
        return { c, price, net };
      })
      .filter((r) => !this.cityAffordable || r.price <= balance)
      // maior renda líquida que cabe no bolso primeiro; terreno (sem renda): mais barato primeiro
      .sort((a, b) => (a.net === b.net ? (a.price < b.price ? -1 : 1) : a.net > b.net ? -1 : 1));
    if (!rows.length) {
      wrap.append(this.empty(this.cityAffordable ? 'Nada da prefeitura cabe no seu saldo nesta categoria agora. Desmarque o filtro de saldo para ver tudo.' : 'Nenhum imóvel da prefeitura nesta categoria.'));
      return wrap;
    }
    wrap.append(h('p', { class: 'muted' }, `${rows.length.toLocaleString('pt-BR')} imóveis. Valores estimados: o preço final é confirmado pelo servidor.`));
    const ul = h('ul', { class: 'rows' });
    const more = h('button', { type: 'button', class: 'btn block' }, 'Carregar mais') as HTMLButtonElement;
    let shown = 0;
    const page = () => {
      for (const { c, price, net } of rows.slice(shown, shown + CITY_PAGE)) {
        const buy = h('button', { type: 'button', class: 'btn small primary', onclick: () => void this.buyFromCity(c.lotId, buy) }, 'Comprar') as HTMLButtonElement;
        const label = net > 0n ? `~${formatMoney(net)}/h líquido · retorno ${formatPayback(price, net)}` : 'sem renda (terreno)';
        ul.append(this.propRow(c, `~${formatMoney(price)}`, label, this.goBtn(c.lotId), buy));
      }
      shown += CITY_PAGE;
      more.hidden = shown >= rows.length;
    };
    more.addEventListener('click', page);
    page();
    wrap.append(ul, more);
    return wrap;
  }

  /** compra da prefeitura com o preço do servidor (não o estimado) */
  private async buyFromCity(lotId: string, btn: HTMLButtonElement) {
    btn.disabled = true;
    let p: PropertyView;
    try {
      p = await this.store.api.property(lotId);
    } catch (e) {
      this.onToast?.(errorMessage(e), true);
      return;
    } finally {
      btn.disabled = false;
    }
    if (p.owner || !p.cityPrice) {
      this.onToast?.('Este imóvel já tem dono.', true);
      return this.reloadTab();
    }
    const price = cents(p.cityPrice);
    const balance = cents(this.store.wallet?.balance);
    const income = cents(p.incomePerHour);
    const tax = iptuPerHour(cents(p.appraisal), this.store.mine.size + 1);
    const ok = await confirmAction({
      title: 'Comprar da prefeitura?',
      rows: [
        ['Imóvel', propertyAddress(p)],
        ['Preço', formatMoney(price)],
        ['Renda (estimada)', `${formatMoney(income)}/h`],
        ['IPTU (estimado)', `${formatMoney(tax)}/h`],
        ['Retorno (estimado)', formatPayback(price, income - tax)],
        ['Saldo atual', formatMoney(balance)],
        ['Saldo depois (estimado)', formatMoney(balance - price)],
      ],
      warning: fundsWarning(balance, price),
      note: `A renda acumula até ${RULES.maxAccrualHours} h; colete pelo HUD.`,
      confirmLabel: 'Comprar',
      onRejected: this.reloadTab,
      run: async (key) => {
        const r = await this.store.api.buyFromCity(lotId, key);
        await this.store.afterTrade(r.wallet);
      },
    });
    if (ok) {
      this.nextStepHint = false;
      this.onToast?.('Imóvel comprado! Ele já começa a render.');
      this.reloadTab();
    }
  }

  private async buildListings(stale: () => boolean): Promise<HTMLElement> {
    const id = 'mk-cat';
    const select = h('select', { id }, h('option', { value: '' }, 'Todas'), ...TRADABLE.map((c) => h('option', { value: c }, categoryLabel(c)))) as HTMLSelectElement;
    select.value = this.listingCategory;
    select.addEventListener('change', () => {
      this.listingCategory = select.value;
      void this.load('listings');
    });
    const ul = h('ul', { class: 'rows' });
    const more = h('button', { type: 'button', class: 'btn block' }, 'Carregar mais') as HTMLButtonElement;
    const unlock = this.store.wallet?.marketUnlockAt;
    const locked = unlock && new Date(unlock).getTime() > Date.now() ? h('p', { class: 'notice' }, `Conta nova: compra e venda entre jogadores liberadas em ${formatDate(unlock)}.`) : null;
    const wrap = h('div', {}, locked, h('div', { class: 'filter' }, h('label', { for: id }, 'Categoria'), select), ul, more);
    let cursor: string | null = null;
    const page = async () => {
      const r = await this.store.api.listings(this.listingCategory || null, cursor);
      if (stale()) return;
      cursor = r.nextCursor;
      for (const l of r.items) ul.append(this.listingRow(l));
      more.hidden = !cursor;
      if (!ul.childElementCount) ul.replaceWith(this.empty('Nenhum imóvel anunciado nesta categoria.'));
    };
    more.addEventListener('click', async () => {
      more.disabled = true;
      more.textContent = 'Carregando…';
      try {
        await page();
      } catch (e) {
        this.onToast?.(errorMessage(e), true);
      } finally {
        more.disabled = false;
        more.textContent = 'Carregar mais';
      }
    });
    await page();
    return wrap;
  }

  private listingRow(l: ListingView): HTMLElement {
    const name = propertyAddress(l);
    const price = cents(l.askPrice);
    const appraisal = cents(l.appraisal);
    const ratio = pctOf(price, appraisal);
    let action: HTMLElement;
    if (l.mine) {
      action = h(
        'button',
        {
          type: 'button',
          class: 'btn small',
          onclick: async () => {
            const ok = await confirmAction({
              title: 'Cancelar anúncio?',
              rows: [['Imóvel', name], ['Preço', formatMoney(price)]],
              confirmLabel: 'Cancelar anúncio',
              onRejected: this.reloadTab,
              run: async (key) => {
                await this.store.api.cancelListing(l.id, key);
                await this.store.afterTrade();
              },
            });
            if (ok) {
              this.onToast?.('Anúncio cancelado.');
              void this.load('listings');
            }
          },
        },
        'Cancelar',
      );
    } else {
      action = h(
        'button',
        {
          type: 'button',
          class: 'btn small primary',
          onclick: async () => {
            const balance = cents(this.store.wallet?.balance);
            const ok = await confirmAction({
              title: 'Comprar este imóvel?',
              rows: [
                ['Imóvel', name],
                ['Vendedor', l.seller.displayName],
                ['Preço', formatMoney(price)],
                ['Avaliação', formatMoney(appraisal)],
                ['Preço / avaliação', `${ratio}%`],
                ['Saldo atual', formatMoney(balance)],
                ['Saldo depois (estimado)', formatMoney(balance - price)],
              ],
              warning: [
                fundsWarning(balance, price),
                ratio > RULES.overpricedPct ? `Preço acima da avaliação. Vendido à prefeitura, renderia até ~${formatMoney(sellToCityMax(appraisal))}.` : null,
              ],
              confirmLabel: 'Comprar',
              onRejected: this.reloadTab,
              run: async (key) => {
                const r = await this.store.api.buyListing(l.id, key);
                await this.store.afterTrade(r.wallet);
              },
            });
            if (ok) {
              this.onToast?.('Imóvel comprado!');
              void this.load('listings');
            }
          },
        },
        'Comprar',
      );
    }
    const who = l.mine ? 'seu anúncio' : `de ${l.seller.displayName}`;
    const row = this.propRow(l, formatMoney(price), `${who} · ${ratio}% da avaliação`, this.goBtn(l.lotId), action);
    if (ratio > RULES.overpricedPct) row.querySelector('.ri-main')?.append(h('span', { class: 'tags' }, h('span', { class: 'tag warn' }, iconEl(ICONS.alert), `acima da avaliação (${formatMoney(appraisal)})`)));
    return row;
  }

  private async buildMine(): Promise<HTMLElement> {
    const { properties } = await this.store.api.myProperties();
    const wrap = h('div');
    const total = sumCents(properties.map((p) => p.appraisal));
    const income = sumCents(properties.map((p) => p.incomePerHour));
    wrap.append(
      h(
        'div',
        { class: 'summary' },
        h('div', { class: 'stat' }, h('small', {}, 'Imóveis'), h('b', {}, String(properties.length))),
        h('div', { class: 'stat' }, h('small', {}, 'Avaliação total'), h('b', {}, formatMoney(total))),
        h('div', { class: 'stat' }, h('small', {}, 'Renda bruta'), h('b', {}, `${formatMoney(income)}/h`)),
      ),
      this.goals(properties),
    );
    if (!properties.length) {
      wrap.append(this.empty('Você ainda não tem imóveis. Comece pela casa inicial ou pela aba "Prefeitura".'));
      return wrap;
    }
    const ul = h('ul', { class: 'rows' });
    for (const p of properties) ul.append(this.propRow(p, formatMoney(p.appraisal), p.isResidence ? 'avaliação · moradia, sem aluguel' : `avaliação · ${formatMoney(p.incomePerHour)}/h`, this.goBtn(p.lotId)));
    wrap.append(h('h3', {}, 'Seus imóveis'), ul);
    return wrap;
  }

  /** metas de médio prazo (orientação; sem recompensa — o servidor não tem missões) */
  private goals(props: PropertyView[]): HTMLElement {
    const w = this.store.wallet;
    const netWorth = cents(w?.netWorth);
    const nextGoal = NET_WORTH_GOALS.find((g) => g > netWorth) ?? null;
    const steps: [string, boolean][] = [
      ['Escolher a casa inicial', !w?.starterAvailable],
      ['Ter um imóvel que rende (que não seja a moradia)', props.some((p) => !p.isResidence && cents(p.incomePerHour) > 0n)],
      ['Abrir um negócio num imóvel comercial', props.some((p) => p.business)],
      ['Levar um negócio ao nível máximo', props.some((p) => (p.business?.level ?? 0) >= RULES.maxBusinessLevel)],
    ];
    const ul = h('ul', { class: 'goals' });
    for (const [label, done] of steps) ul.append(h('li', { class: done ? 'done' : '' }, iconEl(done ? ICONS.check : ICONS.target), h('span', {}, label)));
    const box = h('div', { class: 'goals-box' }, h('h3', {}, 'Metas'), ul);
    if (nextGoal) {
      const f = Number((netWorth * 1000n) / nextGoal) / 1000;
      const meter = h('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(f * 100)), 'aria-label': `Patrimônio rumo a ${money0(nextGoal)}` }, h('i'));
      (meter.firstElementChild as HTMLElement).style.width = `${(Math.min(1, f) * 100).toFixed(1)}%`;
      box.append(h('p', { class: 'muted' }, `Próxima marca de patrimônio: ${money0(nextGoal)} (faltam ${money0(nextGoal - netWorth)})`), meter);
    }
    return box;
  }

  private async buildStatement(stale: () => boolean): Promise<HTMLElement> {
    const ul = h('ul', { class: 'rows tx' });
    const more = h('button', { type: 'button', class: 'btn block' }, 'Carregar mais') as HTMLButtonElement;
    const wrap = h('div', {}, ul, more);
    let cursor: string | null = null;
    const page = async () => {
      const r = await this.store.api.transactions(cursor);
      if (stale()) return;
      cursor = r.nextCursor;
      for (const t of r.items) ul.append(this.txRow(t));
      more.hidden = !cursor;
      if (!ul.childElementCount) ul.replaceWith(this.empty('Nenhuma movimentação ainda.'));
    };
    more.addEventListener('click', async () => {
      more.disabled = true;
      more.textContent = 'Carregando…';
      try {
        await page();
      } catch (e) {
        this.onToast?.(errorMessage(e), true);
      } finally {
        more.disabled = false;
        more.textContent = 'Carregar mais';
      }
    });
    await page();
    return wrap;
  }

  private txRow(t: TxView): HTMLElement {
    const amount = cents(t.amount);
    return h(
      'li',
      { class: 'row-item' },
      h('div', { class: 'ri-main' }, h('b', {}, txLabel(t.kind, amount)), h('small', {}, formatDate(t.createdAt))),
      h('div', { class: 'ri-price' }, h('b', { class: amount > 0n ? 'pos' : '' }, formatMoney(amount, { sign: true }))),
    );
  }

  private async buildRanking(): Promise<HTMLElement> {
    const { items } = await this.store.api.leaderboard();
    if (!items.length) return this.empty('Ranking vazio por enquanto.');
    const me = this.store.user?.displayName;
    const ol = h('ol', { class: 'rows rank' });
    let myRank: number | null = null;
    for (const it of items) {
      const isMe = it.displayName === me;
      if (isMe) myRank = it.rank;
      ol.append(
        h(
          'li',
          { class: `row-item${isMe ? ' me' : ''}`, 'aria-current': isMe ? 'true' : false },
          h('span', { class: 'pos-n' }, `${it.rank}º`),
          h('div', { class: 'ri-main' }, h('b', {}, it.displayName), isMe ? h('small', {}, 'você') : null),
          h('div', { class: 'ri-price' }, h('b', {}, formatMoney(it.netWorth, { compactCents: true })), h('small', {}, 'patrimônio')),
        ),
      );
    }
    // posição do jogador: na lista, ou quanto falta para entrar
    const last = items[items.length - 1];
    const mine = cents(this.store.wallet?.netWorth);
    const where =
      myRank !== null
        ? `Você está em ${myRank}º lugar.`
        : items.length < RULES.leaderboardSize
          ? 'Você ainda não aparece no ranking.'
          : `Você está fora do top ${RULES.leaderboardSize}: faltam ~${money0(cents(last.netWorth) > mine ? cents(last.netWorth) - mine : 0n)} de patrimônio para entrar.`;
    return h('div', {}, h('p', { class: 'notice' }, where), h('p', { class: 'muted' }, `Top ${RULES.leaderboardSize} por patrimônio (valores arredondados).`), ol);
  }

  private async buildIndices(): Promise<HTMLElement> {
    const o = await this.store.api.overview();
    const wrap = h('div');
    const idx = Object.entries(o.indices).filter((e): e is [string, number] => Number.isFinite(e[1]));
    const { indexMin: lo, indexMax: hi } = RULES;
    if (idx.length) {
      const ul = h('ul', { class: 'indices' });
      for (const [category, value] of idx) {
        const f = Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
        const base = (1 - lo) / (hi - lo);
        const meter = h('div', { class: 'meter', role: 'meter', 'aria-valuemin': String(lo), 'aria-valuemax': String(hi), 'aria-valuenow': String(value), 'aria-label': `Índice ${categoryLabel(category)}` }, h('i'), h('em'));
        (meter.firstElementChild as HTMLElement).style.width = `${(f * 100).toFixed(1)}%`;
        (meter.lastElementChild as HTMLElement).style.left = `${(base * 100).toFixed(1)}%`;
        const pct = Math.round((value - 1) * 100);
        ul.append(
          h(
            'li',
            {},
            h('span', { class: 'ix-name' }, categoryLabel(category)),
            meter,
            h('b', { class: 'ix-val' }, `×${value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`),
            h('small', { class: 'ix-pct' }, pct === 0 ? 'estável' : `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`),
          ),
        );
      }
      const fmt = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
      wrap.append(h('h3', {}, 'Índice por categoria'), h('p', { class: 'muted' }, `Multiplica a avaliação nas compras da prefeitura. Varia com a demanda, entre ×${fmt(lo)} e ×${fmt(hi)}.`), ul);
    }
    const s = o.stats;
    wrap.append(
      h('h3', {}, 'Cidade'),
      h(
        'dl',
        { class: 'kv' },
        ...(
          [
            ['players', s.players.toLocaleString('pt-BR')],
            ['ownedProperties', s.ownedProperties.toLocaleString('pt-BR')],
            ['activeListings', s.activeListings.toLocaleString('pt-BR')],
            ['moneySupply', formatMoney(s.moneySupply)],
          ] as [string, string][]
        ).flatMap(([k, v]) => [h('dt', {}, statLabel(k)), h('dd', {}, v)]),
      ),
    );
    if (o.recentSales.length) {
      const ul = h('ul', { class: 'rows' });
      for (const sale of o.recentSales.slice(0, 20)) {
        ul.append(
          h(
            'li',
            { class: 'row-item' },
            h('div', { class: 'ri-main' }, h('b', {}, categoryLabel(sale.category)), h('small', {}, [saleLabel(sale.kind), formatDate(sale.at)].filter(Boolean).join(' · '))),
            h('div', { class: 'ri-price' }, h('b', {}, formatMoney(sale.price))),
            h('div', { class: 'ri-actions' }, this.goBtn(sale.lotId)),
          ),
        );
      }
      wrap.append(h('h3', {}, 'Vendas recentes'), ul);
    }
    return wrap;
  }
}

