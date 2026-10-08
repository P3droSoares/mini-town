import { ApiError, describeError, newIdempotencyKey } from '../net/api';
import { ICONS, h, iconEl, svgIcon } from './dom';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalOptions {
  title: string;
  /** classe extra da caixa (ex.: 'wide') */
  className?: string;
  /** false = Esc/fundo não fecham (ex.: operação em andamento) */
  dismissible?: boolean;
  onClose?: () => void;
}

let uid = 0;
const stack: Modal[] = [];

/** fecha todos os diálogos abertos (sessão expirou / trocou de conta) */
export function closeAllModals() {
  for (const m of [...stack].reverse()) m.close();
}

/** id do usuário da sessão atual (registrado pelo `main`) */
let sessionUser: () => string | null = () => null;
export function setSessionUserProvider(fn: () => string | null) {
  sessionUser = fn;
}

/**
 * Diálogo modal acessível: `role=dialog` + `aria-modal`, foco preso, Esc
 * fecha, foco devolvido a quem abriu. Teclas não vazam para o jogo.
 */
export class Modal {
  readonly el: HTMLElement;
  readonly box: HTMLElement;
  readonly body: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly closeBtn: HTMLButtonElement;
  dismissible: boolean;
  private opener: Element | null = null;
  private isOpen = false;

  constructor(private readonly opts: ModalOptions) {
    const id = `dlg-${++uid}`;
    this.dismissible = opts.dismissible ?? true;
    this.titleEl = h('h2', { id: `${id}-t`, class: 'dlg-title' }, opts.title);
    this.closeBtn = h('button', { type: 'button', class: 'close', 'aria-label': 'Fechar', html: svgIcon(ICONS.close), onclick: () => this.requestClose() });
    this.body = h('div', { class: 'dlg-body' });
    this.box = h(
      'div',
      { class: `dlg card ${opts.className ?? ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${id}-t` },
      h('header', { class: 'dlg-head' }, this.titleEl, this.closeBtn),
      this.body,
    );
    this.el = h('div', { class: 'dlg-backdrop' }, this.box);
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el) this.requestClose();
    });
    this.el.addEventListener('keydown', this.onKey);
    // nada do modal chega ao canvas/jogo
    for (const ev of ['keyup', 'wheel', 'pointerup', 'pointermove'] as const) this.el.addEventListener(ev, (e) => e.stopPropagation());
  }

  setTitle(t: string) {
    this.titleEl.textContent = t;
  }

  open(focus?: HTMLElement | null) {
    if (this.isOpen) return;
    this.isOpen = true;
    this.opener = document.activeElement;
    stack.push(this);
    document.body.append(this.el);
    requestAnimationFrame(() => {
      this.el.classList.add('show');
      (focus ?? this.box.querySelector<HTMLElement>('[autofocus]') ?? this.firstFocusable())?.focus();
    });
  }

  get opened() {
    return this.isOpen;
  }

  /** Esc / fundo / botão fechar */
  requestClose() {
    if (this.dismissible) this.close();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    const i = stack.indexOf(this);
    if (i >= 0) stack.splice(i, 1);
    this.el.remove();
    this.el.classList.remove('show');
    if (this.opener instanceof HTMLElement && this.opener.isConnected) this.opener.focus();
    this.opts.onClose?.();
  }

  private firstFocusable(): HTMLElement | null {
    const list = this.focusables();
    // pula o "fechar" do cabeçalho quando há outro alvo
    return list.find((e) => e !== this.closeBtn) ?? list[0] ?? null;
  }

  private focusables(): HTMLElement[] {
    return [...this.box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => !e.hidden && e.offsetParent !== null);
  }

  private onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (stack[stack.length - 1] !== this) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.requestClose();
    } else if (e.key === 'Tab') {
      const list = this.focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
}

/** caixa de mensagem de erro/aviso (amarelo + ícone; texto via textContent) */
export function errorBox(): { el: HTMLElement; show: (msg: string | null) => void } {
  const text = h('span');
  const el = h('div', { class: 'err-box', role: 'alert', hidden: true }, iconEl(ICONS.alert), text);
  return {
    el,
    show: (msg) => {
      text.textContent = msg ?? '';
      el.hidden = !msg;
    },
  };
}

/** aviso em destaque (amarelo + ícone), sem role=alert (parte do conteúdo) */
export function warnBox(msg: string): HTMLElement {
  return h('div', { class: 'err-box' }, iconEl(ICONS.alert), h('span', {}, msg));
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return describeError(e);
  console.error(e);
  return 'Algo deu errado. Tente de novo.';
}

/** aviso quando o saldo conhecido não cobre o gasto estimado (o servidor decide) */
export function fundsWarning(balance: bigint, cost: bigint): string | null {
  return cost > balance ? 'Seu saldo parece insuficiente para esta operação.' : null;
}

/**
 * Botão com estado de carregamento (aria-busy + rótulo temporário). Guarda e
 * devolve os nós filhos (ícone, spans) — nunca achata o conteúdo em texto.
 */
const savedContent = new WeakMap<HTMLButtonElement, Node[]>();
export function setBusy(btn: HTMLButtonElement, busy: boolean, label?: string) {
  if (busy) {
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.classList.add('busy');
    if (label && !savedContent.has(btn)) {
      savedContent.set(btn, [...btn.childNodes]);
      btn.textContent = label;
    }
  } else {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.classList.remove('busy');
    const nodes = savedContent.get(btn);
    if (nodes) {
      btn.replaceChildren(...nodes);
      savedContent.delete(btn);
    }
  }
}

/** troca o rótulo de um botão (descarta conteúdo guardado por `setBusy`) */
function setLabel(btn: HTMLButtonElement, label: string) {
  savedContent.delete(btn);
  btn.textContent = label;
}

export interface ConfirmOptions {
  title: string;
  /** linhas de detalhe: [rótulo, valor] */
  rows?: [string, string][];
  note?: string;
  /** avisos em destaque (ex.: saldo insuficiente, negócio será fechado) */
  warning?: string | (string | null)[] | null;
  confirmLabel: string;
  busyLabel?: string;
  /** ação irreversível com perda (vender à prefeitura): botão de risco */
  danger?: boolean;
  /** executa a ação; recebe a chave de idempotência fixa deste diálogo */
  run: (idempotencyKey: string) => Promise<void>;
  /** recusa definitiva do servidor (4xx de regra): recarregar os dados exibidos */
  onRejected?: (e: ApiError) => void;
}

/**
 * Confirmação antes de gastar. A mesma `Idempotency-Key` é reusada ao tentar
 * de novo após resultado incerto (rede, 5xx, 429) — sem cobrar duas vezes.
 * Recusa definitiva (4xx de regra): mostra o motivo, troca o botão por
 * "Fechar" e avisa `onRejected`. A confirmação pertence ao usuário que a
 * abriu: se a sessão mudar, ela é abortada. Resolve `true` se concluída.
 */
export function confirmAction(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let rejected = false;
    let key = newIdempotencyKey();
    const owner = sessionUser();
    const err = errorBox();
    const modal = new Modal({ title: o.title, className: 'confirm', onClose: () => resolve(done) });
    const ok = h('button', { type: 'submit', class: `btn ${o.danger ? 'danger' : 'primary'}` }, o.danger ? iconEl(ICONS.alert) : null, h('span', {}, o.confirmLabel)) as HTMLButtonElement;
    const cancel = h('button', { type: 'button', class: 'btn', onclick: () => modal.requestClose() }, 'Cancelar') as HTMLButtonElement;
    const warnings = (Array.isArray(o.warning) ? o.warning : [o.warning]).filter((w): w is string => !!w);
    const form = h(
      'form',
      { class: 'confirm-form', novalidate: true },
      o.rows?.length ? h('dl', { class: 'kv' }, ...o.rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])) : null,
      o.note ? h('p', { class: 'muted' }, o.note) : null,
      ...warnings.map(warnBox),
      err.el,
      h('div', { class: 'actions' }, cancel, ok),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (ok.disabled) return;
      if (rejected) return modal.close();
      // outra conta entrou nesta aba depois que o diálogo abriu: aborta
      if (sessionUser() !== owner) return modal.close();
      err.show(null);
      setBusy(ok, true, o.busyLabel ?? 'Processando…');
      cancel.disabled = true;
      modal.dismissible = false;
      try {
        await o.run(key);
        done = true;
        modal.dismissible = true;
        modal.close();
      } catch (ex) {
        setBusy(ok, false);
        cancel.disabled = false;
        modal.dismissible = true;
        if (!modal.opened) return;
        err.show(errorMessage(ex));
        if (ex instanceof ApiError && !ex.retryable) {
          // recusa definitiva: repetir não adianta; dados exibidos estão velhos
          rejected = true;
          key = newIdempotencyKey();
          ok.className = 'btn';
          setLabel(ok, 'Fechar');
          cancel.hidden = true;
          o.onRejected?.(ex);
        } else {
          // resultado incerto: repete com a MESMA chave (o servidor não cobra duas vezes)
          setLabel(ok, 'Tentar de novo');
        }
        ok.focus();
      }
    });
    modal.body.append(form);
    // ação com perda: foco começa no "Cancelar"
    modal.open(o.danger ? cancel : ok);
  });
}
