import { ApiError, type BusinessType, type MarketOverview, type PropertyView } from '../net/api';
import { cents, formatMoney, moneyToInput, parseMoneyInput } from '../net/money';
import {
  BUSINESS_TYPES,
  RULES,
  askLimits,
  businessIncomePerHour,
  businessInvested,
  businessOpenCost,
  iptuPerHour,
  isBusinessType,
  sellToCityMax,
  sellerNet,
  starterEligibleEstimate,
  starterPays,
  upgradedIncome,
} from '../net/rules';
import type { OnlineStore } from '../net/store';
import { ICONS, h, iconEl } from './dom';
import { businessLabel, categoryLabel, formatDate, formatPayback, money0, pctOf, propertyAddress } from './format';
import { type ConfirmOptions, confirmAction, errorBox, errorMessage, fundsWarning, warnBox } from './modal';

/**
 * Seção econômica do painel do imóvel: dados do servidor (PropertyView) e
 * ações com confirmação antes de gastar. Valores exibidos vêm do servidor ou
 * das regras compartilhadas (`net/rules`) e são rotulados "estimado".
 */
export class PropertySection {
  readonly el: HTMLElement;
  private lotId: string | null = null;
  private seq = 0;
  private view: PropertyView | null = null;
  /** GET em voo do imóvel anterior (cancelado ao trocar de imóvel) */
  private ctl: AbortController | null = null;
  /** índices do mercado (estimativa da elegibilidade da casa inicial) */
  private indices: MarketOverview['indices'] | null = null;
  onLogin: (() => void) | null = null;
  onToast: ((m: string, error?: boolean) => void) | null = null;

  constructor(private readonly store: OnlineStore) {
    this.el = h('section', { class: 'econ-sec', 'aria-label': 'Mercado imobiliário', 'aria-live': 'polite' });
    store.on('status', () => this.lotId && this.load(this.lotId));
    // dono/anúncio mudou no mapa: atualiza se é este imóvel
    store.on('ownership', () => {
      const v = this.view;
      if (!v || !this.lotId) return;
      const listed = store.listed.has(this.lotId);
      const mine = store.mine.has(this.lotId);
      if (listed !== !!v.listing || mine !== v.mine) this.load(this.lotId);
    });
    // casa inicial usada: os botões dependem disso (só re-renderiza nessa mudança,
    // para não apagar o que o jogador está digitando no anúncio)
    let starter = store.wallet?.starterAvailable;
    store.on('wallet', () => {
      const s = store.wallet?.starterAvailable;
      if (s === starter) return;
      starter = s;
      if (this.view && this.view.lotId === this.lotId) this.render(this.view);
    });
  }

  /** `null` = imóvel sem cadastro econômico (só informação) */
  load(lotId: string | null) {
    this.lotId = lotId;
    this.view = null;
    const seq = ++this.seq;
    this.ctl?.abort();
    this.ctl = null;
    if (!lotId) return this.el.replaceChildren();
    const st = this.store.status;
    if (st === 'checking') return this.message('Conectando ao servidor…');
    if (st === 'offline') {
      return this.message('Servidor offline: compra e venda indisponíveis no momento.', h('button', { type: 'button', class: 'btn', onclick: () => void this.store.connect() }, 'Tentar de novo'), true);
    }
    if (st === 'anonymous') {
      return this.message('Entre na sua conta para ver o preço e negociar este imóvel.', h('button', { type: 'button', class: 'btn primary', onclick: () => this.onLogin?.() }, 'Entrar'));
    }
    this.el.setAttribute('aria-busy', 'true');
    this.el.replaceChildren(h('h3', {}, 'Mercado imobiliário'), h('div', { class: 'skeleton' }, h('i'), h('i'), h('i')));
    const ctl = (this.ctl = new AbortController());
    // casa inicial disponível: os índices ajudam a estimar a avaliação base (teto)
    const idx = this.store.wallet?.starterAvailable ? this.store.marketIndices() : Promise.resolve(this.indices);
    Promise.all([this.store.api.property(lotId, ctl.signal), idx]).then(
      ([p, indices]) => {
        if (seq !== this.seq) return;
        this.indices = indices;
        this.el.removeAttribute('aria-busy');
        this.render(p);
      },
      (e) => {
        if (seq !== this.seq || (e instanceof ApiError && e.aborted)) return;
        this.el.removeAttribute('aria-busy');
        if (e instanceof ApiError && e.status === 404) return this.message('Este imóvel não faz parte do mercado.');
        this.message(errorMessage(e), h('button', { type: 'button', class: 'btn', onclick: () => this.load(lotId) }, 'Tentar de novo'), true);
      },
    );
  }

  private reload = () => {
    if (this.lotId) this.load(this.lotId);
  };

  private message(text: string, action?: HTMLElement, warn = false) {
    this.el.removeAttribute('aria-busy');
    this.el.replaceChildren(
      h('h3', {}, 'Mercado imobiliário'),
      h('p', { class: warn ? 'err-box inline' : 'muted' }, warn ? iconEl(ICONS.alert) : null, h('span', {}, text)),
      action ?? '',
    );
  }

  private render(p: PropertyView) {
    this.view = p;
    const appraisal = cents(p.appraisal);
    const rows: [string, Node | string][] = [['Avaliação', formatMoney(appraisal)]];
    if (p.listing) {
      const ask = cents(p.listing.askPrice);
      rows.push(['À venda por', h('span', { class: 'hl' }, formatMoney(ask))]);
      rows.push(['Preço / avaliação', `${pctOf(ask, appraisal)}%`]);
    } else if (!p.owner && p.cityPrice) rows.push(['Preço da prefeitura', h('span', { class: 'hl' }, formatMoney(p.cityPrice))]);
    rows.push(['Dono', p.mine ? 'Você' : p.owner ? p.owner.displayName : p.buyable ? 'Prefeitura (à venda)' : 'Público (não vendável)']);
    rows.push(['Renda', p.isResidence ? 'Sem aluguel (sua moradia)' : `${formatMoney(p.incomePerHour)}/h`]);
    if (p.business) rows.push(['Negócio', `${businessLabel(p.business.type)} · nível ${p.business.level}`]);
    if (p.isResidence) rows.push(['Moradia', 'Você mora aqui']);

    const tags = h('div', { class: 'tags' });
    if (p.mine) tags.append(h('span', { class: 'tag accent' }, 'Seu imóvel'));
    if (p.listing) tags.append(h('span', { class: 'tag' }, 'Anunciado'));
    tags.append(h('span', { class: 'tag' }, categoryLabel(p.category)));

    this.el.replaceChildren(
      h('h3', {}, 'Mercado imobiliário'),
      tags,
      h('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      this.actions(p),
    );
  }

  /** conta nova: data de liberação do mercado entre jogadores (vazio = liberado) */
  private marketLockedUntil(): string {
    const at = this.store.wallet?.marketUnlockAt;
    return at && new Date(at).getTime() > Date.now() ? formatDate(at) : '';
  }

  /** saldo lido na hora do clique (a carteira pode ter mudado) */
  private balance(): bigint {
    return cents(this.store.wallet?.balance);
  }

  private after(price: bigint): [string, string][] {
    const b = this.balance();
    return [
      ['Saldo atual', formatMoney(b)],
      ['Saldo depois (estimado)', formatMoney(b - price)],
    ];
  }

  private btn(label: string, kind: 'primary' | 'danger' | '', fn: () => void, icon?: string) {
    return h('button', { type: 'button', class: `btn ${kind} block`, onclick: fn }, icon ? iconEl(icon) : null, h('span', {}, label));
  }

  private actions(p: PropertyView): HTMLElement {
    const box = h('div', { class: 'econ-actions' });
    return p.mine ? this.ownActions(p, box) : this.otherActions(p, box);
  }

  // ---------------------------------------------------------------- imóvel de outro / da prefeitura

  private otherActions(p: PropertyView, box: HTMLElement): HTMLElement {
    const addr = propertyAddress(p);
    const appraisal = cents(p.appraisal);
    if (p.listing?.suspended) {
      box.append(h('p', { class: 'notice' }, 'Anúncio suspenso: o índice do mercado mudou e o preço saiu da faixa permitida. Não pode ser comprado agora.'));
      return box;
    }
    if (p.listing) {
      const listing = p.listing;
      const price = cents(listing.askPrice);
      const ratio = pctOf(price, appraisal);
      const overpriced = ratio > RULES.overpricedPct;
      const unlock = this.marketLockedUntil();
      if (unlock) {
        box.append(h('p', { class: 'notice' }, `Conta nova: compra e venda entre jogadores liberadas em ${unlock}.`));
        return box;
      }
      if (overpriced) box.append(warnBox(`Preço ${ratio}% da avaliação. Vendido de volta à prefeitura, renderia até ~${formatMoney(sellToCityMax(appraisal))}.`));
      box.append(
        this.btn(`Comprar por ${formatMoney(price)}`, 'primary', () =>
          this.act({
            title: 'Comprar imóvel anunciado?',
            rows: [
              ['Imóvel', addr],
              ['Vendedor', p.owner?.displayName ?? '—'],
              ['Preço', formatMoney(price)],
              ['Avaliação', formatMoney(appraisal)],
              ['Preço / avaliação', `${ratio}%`],
              ...this.after(price),
            ],
            warning: [
              fundsWarning(this.balance(), price),
              overpriced ? `Preço acima da avaliação. Vendido à prefeitura, renderia até ~${formatMoney(sellToCityMax(appraisal))}.` : null,
            ],
            note: p.business ? `Você herda o negócio (${businessLabel(p.business.type)} nível ${p.business.level}).` : undefined,
            confirmLabel: 'Comprar',
            run: async (key) => {
              const r = await this.store.api.buyListing(listing.id, key);
              await this.done(r.property, r.wallet, 'Imóvel comprado!');
            },
          }),
        ),
      );
      return box;
    }
    if (!p.owner && p.buyable && p.cityPrice) {
      const price = cents(p.cityPrice);
      const starter = !!this.store.wallet?.starterAvailable;
      const eligible = p.starterEligible ?? starterEligibleEstimate({ ...p, appraisal }, this.indices?.[p.category] ?? 1);
      const buy = this.btn(`Comprar da prefeitura · ${formatMoney(price)}`, starter && eligible ? '' : 'primary', () => this.buyFromCity(p, price));
      if (starter && eligible) {
        // jogador novo: a ação certa é a casa inicial
        const pay = starterPays(price);
        box.append(this.btn(`Escolher como casa inicial · ${formatMoney(pay)}`, 'primary', () => this.claimStarter(p, price, pay), ICONS.home), buy);
      } else {
        box.append(buy);
        if (starter && p.category === 'residential') {
          box.append(h('p', { class: 'muted' }, `Não serve como casa inicial (teto: avaliação base de ${money0(RULES.starterMaxBase)}). Veja as casas elegíveis na aba "Casa inicial" do Mercado.`));
        }
      }
      return box;
    }
    if (!p.owner && !p.buyable) box.append(h('p', { class: 'muted' }, 'Imóvel público: não está à venda.'));
    return box;
  }

  private buyFromCity(p: PropertyView, price: bigint) {
    const appraisal = cents(p.appraisal);
    const income = cents(p.incomePerHour);
    const tax = iptuPerHour(appraisal, this.store.mine.size + 1);
    void this.act({
      title: 'Comprar da prefeitura?',
      rows: [
        ['Imóvel', propertyAddress(p)],
        ['Preço', formatMoney(price)],
        ['Renda (estimada)', `${formatMoney(income)}/h`],
        ['IPTU (estimado)', `${formatMoney(tax)}/h`],
        ['Retorno (estimado)', formatPayback(price, income - tax)],
        ...this.after(price),
      ],
      warning: fundsWarning(this.balance(), price),
      note:
        p.category === 'vacant'
          ? 'Terreno vago não gera renda, mas paga IPTU. O preço final é confirmado pelo servidor.'
          : `A renda acumula até ${RULES.maxAccrualHours} h; colete pelo HUD. O preço final é confirmado pelo servidor.`,
      confirmLabel: 'Comprar',
      run: async (key) => {
        const r = await this.store.api.buyFromCity(p.lotId, key);
        await this.done(r.property, r.wallet, 'Imóvel comprado!');
      },
    });
  }

  private claimStarter(p: PropertyView, price: bigint, pay: bigint) {
    void this.act({
      title: 'Escolher como casa inicial?',
      rows: [['Imóvel', propertyAddress(p)], ['Preço', formatMoney(price)], ['Você paga (estimado)', formatMoney(pay)], ...this.after(pay)],
      warning: fundsWarning(this.balance(), pay),
      note: starterNote(),
      confirmLabel: 'Escolher esta casa',
      run: async (key) => {
        const r = await this.store.api.claimStarter(p.lotId, key);
        await this.done(r.property, r.wallet, 'Bem-vindo à sua casa nova! Próximo passo: compre um imóvel que dê renda.');
      },
    });
  }

  // ---------------------------------------------------------------- imóvel próprio

  private ownActions(p: PropertyView, box: HTMLElement): HTMLElement {
    const addr = propertyAddress(p);
    const locked = p.lockedUntil && new Date(p.lockedUntil).getTime() > Date.now() ? formatDate(p.lockedUntil) : '';
    if (p.listing) {
      const listing = p.listing;
      if (listing.suspended) box.append(h('p', { class: 'notice' }, 'Seu anúncio está suspenso: o índice mudou e o preço saiu da faixa. Cancele e anuncie de novo.'));
      box.append(
        this.btn('Cancelar anúncio', '', () =>
          this.act({
            title: 'Cancelar anúncio?',
            rows: [['Imóvel', addr], ['Preço anunciado', formatMoney(listing.askPrice)]],
            confirmLabel: 'Cancelar anúncio',
            run: async (key) => {
              await this.store.api.cancelListing(listing.id, key);
              await this.done(null, null, 'Anúncio cancelado.');
            },
          }),
        ),
      );
    } else if (locked) {
      // carência da casa inicial: anunciar/vender sempre seria recusado
      box.append(h('p', { class: 'notice' }, `Casa inicial: venda e anúncio liberados em ${locked}.`));
    } else {
      const unlock = this.marketLockedUntil();
      box.append(unlock ? h('p', { class: 'notice' }, `Conta nova: anúncios entre jogadores liberados em ${unlock}.`) : this.listingForm(p));
      const appraisal = cents(p.appraisal);
      // cotação do servidor; sem ela, o teto (o servidor usa o menor entre avaliação e preço pago)
      const quoted = p.sellToCityQuote !== undefined;
      const get = quoted ? cents(p.sellToCityQuote) : sellToCityMax(appraisal);
      const getLabel = `${quoted ? '' : 'até '}~${formatMoney(get)}`;
      box.append(
        this.btn(
          `Vender à prefeitura · ${getLabel}`,
          'danger',
          () =>
            this.act({
              title: 'Vender à prefeitura?',
              rows: [['Imóvel', addr], ['Avaliação', formatMoney(appraisal)], ['Você recebe (estimado)', getLabel]],
              warning: [
                p.business
                  ? `Seu negócio (${businessLabel(p.business.type)} nível ${p.business.level}) será fechado sem reembolso. Investido: ~${formatMoney(businessInvested(appraisal, p.business.level))}.`
                  : null,
                p.isResidence ? 'Você deixará de morar aqui.' : null,
              ],
              note: `A prefeitura paga ${RULES.sellToCityPct} do menor valor entre a avaliação atual e o preço que você pagou. Renda e IPTU pendentes deste imóvel são acertados na venda. Não dá para desfazer.`,
              confirmLabel: 'Vender',
              danger: true,
              run: async (key) => {
                const r = await this.store.api.sellToCity(p.lotId, key);
                await this.done(null, r.wallet, 'Imóvel vendido à prefeitura.');
              },
            }),
          ICONS.alert,
        ),
      );
    }
    if (p.category === 'residential' && !p.isResidence) {
      box.append(
        this.btn('Morar aqui', '', () =>
          this.act({
            title: 'Morar neste imóvel?',
            rows: [['Imóvel', addr], ['Renda que deixa de receber', `${formatMoney(p.incomePerHour)}/h`]],
            note: 'A casa onde você mora não gera aluguel. Sua moradia atual (se houver) volta a render.',
            confirmLabel: 'Morar aqui',
            run: async (key) => {
              const r = await this.store.api.setResidence(p.lotId, key);
              await this.done(r.property, null, 'Você agora mora aqui.');
            },
          }),
        ),
      );
    }
    if (p.category === 'commercial' && !p.business) box.append(this.businessForm(p));
    if (p.business && p.business.level < RULES.maxBusinessLevel) box.append(this.upgradeButton(p, p.business));
    return box;
  }

  private upgradeButton(p: PropertyView, biz: { type: BusinessType; level: number }): HTMLElement {
    const cost = p.upgradeCost ? cents(p.upgradeCost) : null;
    const next = biz.level + 1;
    const now = cents(p.incomePerHour);
    const then = upgradedIncome(now, biz.level);
    return this.btn(`Melhorar negócio para nível ${next}${cost !== null ? ` · ${formatMoney(cost)}` : ''}`, '', () =>
      this.act({
        title: `Melhorar para nível ${next}?`,
        rows: [
          ['Negócio', businessLabel(biz.type)],
          ['Custo', cost !== null ? formatMoney(cost) : 'indisponível'],
          ['Renda agora', `${formatMoney(now)}/h`],
          ['Renda no nível ' + next + ' (estimada)', `${formatMoney(then)}/h`],
          ...(cost !== null ? ([['Retorno (estimado)', formatPayback(cost, then - now)]] as [string, string][]) : []),
          ...(cost !== null ? this.after(cost) : []),
        ],
        warning: cost !== null ? fundsWarning(this.balance(), cost) : null,
        note: `Cada nível soma ${RULES.levelBonusPct} à receita. A concorrência no raio de ${RULES.competitionRadiusM} m continua valendo.`,
        confirmLabel: 'Melhorar',
        run: async (key) => {
          const r = await this.store.api.upgradeBusiness(p.lotId, key);
          await this.done(r.property, r.wallet, `Negócio no nível ${next}!`);
        },
      }),
    );
  }

  /** anunciar com preço (faixa vinda das regras compartilhadas; o servidor revalida) */
  private listingForm(p: PropertyView): HTMLElement {
    const appraisal = cents(p.appraisal);
    const { min, max } = p.askRange ? { min: cents(p.askRange.min), max: cents(p.askRange.max) } : askLimits(appraisal);
    const id = `ask-${p.lotId}`;
    const input = h('input', { id, type: 'text', inputmode: 'decimal', autocomplete: 'off', maxlength: '20', 'aria-describedby': `${id}-h` }) as HTMLInputElement;
    input.value = moneyToInput(appraisal);
    const help = h('small', { id: `${id}-h`, class: 'help' }, `Entre ${formatMoney(min)} e ${formatMoney(max)} (${RULES.askMinPct} a ${RULES.askMaxPct} da avaliação). Taxa de ${RULES.feePct} na venda, mais ${RULES.surchargePct} sobre o que passar de ${RULES.overpricedPct}% da avaliação.`);
    const err = errorBox();
    const submit = h('button', { type: 'submit', class: 'btn' }, 'Anunciar') as HTMLButtonElement;
    const form = h('form', { class: 'inline-form', novalidate: true }, h('label', { for: id }, 'Anunciar à venda (I$)'), h('div', { class: 'row' }, input, submit), help, err.el);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      const v = parseMoneyInput(input.value);
      if (v === null || v <= 0n) return this.fieldErr(input, err, 'Digite um valor, ex.: 150.000,00');
      if (v < min || v > max) return this.fieldErr(input, err, `O preço deve ficar entre ${formatMoney(min)} e ${formatMoney(max)}.`);
      input.removeAttribute('aria-invalid');
      err.show(null);
      const ok = await confirmAction({
        title: 'Anunciar imóvel?',
        rows: [
          ['Imóvel', propertyAddress(p)],
          ['Preço pedido', formatMoney(v)],
          ['Preço / avaliação', `${pctOf(v, appraisal)}%`],
          ['Você recebe (após taxas)', formatMoney(sellerNet(v, appraisal))],
        ],
        warning: [
          p.business ? `Quem comprar herda o negócio (${businessLabel(p.business.type)} nível ${p.business.level}); você não recebe nada além do preço.` : null,
          p.isResidence ? 'Se vender, você deixa de morar aqui.' : null,
        ],
        note: 'Enquanto anunciado, o imóvel não pode ser vendido à prefeitura.',
        confirmLabel: 'Anunciar',
        onRejected: this.reload,
        run: async (key) => {
          try {
            await this.store.api.createListing(p.lotId, v, key);
          } catch (ex) {
            throw askRangeError(ex);
          }
          await this.done(null, null, 'Imóvel anunciado no mercado.');
        },
      });
      if (!ok && input.isConnected) input.focus();
    });
    return form;
  }

  private fieldErr(input: HTMLInputElement, err: ReturnType<typeof errorBox>, msg: string) {
    input.setAttribute('aria-invalid', 'true');
    err.show(msg);
    input.focus();
  }

  /** abrir negócio: custo, concorrentes e renda projetada por tipo */
  private businessForm(p: PropertyView): HTMLElement {
    const appraisal = cents(p.appraisal);
    const current = cents(p.incomePerHour);
    const fromServer = new Map((p.businessOptions ?? []).map((o) => [o.type, o]));
    const option = (t: BusinessType) => {
      const o = fromServer.get(t);
      return o
        ? { cost: cents(o.openCost), income: cents(o.projectedIncomePerHour), competitors: o.competitors as number | null }
        : // sem o servidor: teto sem concorrentes (a concorrência só reduz)
          { cost: p.openBusinessCost ? cents(p.openBusinessCost) : businessOpenCost(appraisal), income: businessIncomePerHour(appraisal, t, 1, 0), competitors: null };
    };
    const id = `biz-${p.lotId}`;
    const select = h('select', { id, 'aria-describedby': `${id}-i` }, ...BUSINESS_TYPES.map((t) => h('option', { value: t }, businessLabel(t)))) as HTMLSelectElement;
    const info = h('small', { id: `${id}-i`, class: 'help', 'aria-live': 'polite' });
    const describe = () => {
      const t = select.value;
      if (!isBusinessType(t)) return;
      const o = option(t);
      const income = o.competitors === null ? `até ${formatMoney(o.income)}/h (sem concorrentes)` : `${formatMoney(o.income)}/h com ${o.competitors} concorrente${o.competitors === 1 ? '' : 's'} perto`;
      info.textContent = `Custo ${formatMoney(o.cost)} · renda ${formatMoney(current)}/h → ${income} · retorno ${formatPayback(o.cost, o.income - current)}.`;
    };
    select.addEventListener('change', describe);
    describe();
    const submit = h('button', { type: 'submit', class: 'btn' }, 'Abrir') as HTMLButtonElement;
    const form = h(
      'form',
      { class: 'inline-form', novalidate: true },
      h('label', { for: id }, 'Abrir negócio'),
      h('div', { class: 'row' }, select, submit),
      info,
      h('small', { class: 'help' }, `Negócios iguais num raio de ${RULES.competitionRadiusM} m dividem a clientela (até −${RULES.competitionMaxCutPct} de renda); níveis altos defendem o seu.`),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const type = select.value;
      if (!isBusinessType(type)) return;
      const o = option(type);
      void this.act({
        title: `Abrir ${businessLabel(type).toLowerCase()}?`,
        rows: [
          ['Imóvel', propertyAddress(p)],
          ['Custo de abertura', formatMoney(o.cost)],
          ...this.after(o.cost),
          ['Renda agora', `${formatMoney(current)}/h`],
          [o.competitors === null ? 'Renda com o negócio (máx.)' : 'Renda com o negócio (estimada)', `${formatMoney(o.income)}/h`],
          ...(o.competitors !== null ? ([['Concorrentes no raio', String(o.competitors)]] as [string, string][]) : []),
          ['Retorno (estimado)', formatPayback(o.cost, o.income - current)],
        ],
        warning: fundsWarning(this.balance(), o.cost),
        note: 'O custo é debitado do seu saldo e não é devolvido se você vender à prefeitura.',
        confirmLabel: 'Abrir negócio',
        run: async (key) => {
          const r = await this.store.api.openBusiness(p.lotId, type, key);
          await this.done(r.property, r.wallet, `${businessLabel(type)} aberto!`);
        },
      });
    });
    return form;
  }

  /** confirmação; recusa definitiva recarrega o imóvel (dados exibidos ficaram velhos) */
  private async act(o: ConfirmOptions) {
    await confirmAction({ onRejected: this.reload, ...o });
  }

  /** depois de uma ação: atualiza carteira, mapa de donos e o painel */
  private async done(property: PropertyView | null, wallet: Parameters<OnlineStore['applyWallet']>[0], msg: string) {
    this.onToast?.(msg);
    if (property && property.lotId === this.lotId) {
      this.seq++;
      this.render(property);
    } else if (this.lotId) this.load(this.lotId);
    await this.store.afterTrade(wallet);
  }
}

/** texto da confirmação da casa inicial (também usado no Mercado) */
export function starterNote(): string {
  return `A prefeitura paga ${RULES.starterSubsidyPct} do preço; vale uma vez por conta. A casa não pode ser vendida nem anunciada por ${RULES.starterLockDays} dias, não rende aluguel por ${RULES.starterEncumbranceDays} dias (vendida antes disso, o subsídio volta à prefeitura) e vira sua moradia se você ainda não tem uma.`;
}

/** ASK_OUT_OF_RANGE com a faixa formatada em I$ (o índice pode ter mudado) */
function askRangeError(ex: unknown): unknown {
  if (!(ex instanceof ApiError) || ex.code !== 'ASK_OUT_OF_RANGE') return ex;
  const d = ex.details as { min?: unknown; max?: unknown } | undefined;
  const min = typeof d?.min === 'string' || typeof d?.min === 'number' ? cents(String(d.min)) : null;
  const max = typeof d?.max === 'string' || typeof d?.max === 'number' ? cents(String(d.max)) : null;
  const msg = min !== null && max !== null ? `O preço precisa ficar entre ${formatMoney(min)} e ${formatMoney(max)}: a avaliação mudou. Confira a nova faixa.` : 'O preço saiu da faixa permitida: a avaliação mudou. Confira a nova faixa no painel.';
  return new ApiError(ex.status, ex.code, msg, { details: ex.details });
}
