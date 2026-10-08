import { ApiError } from '../net/api';
import type { OnlineStore } from '../net/store';
import { ICONS, h, svgIcon } from './dom';
import { Modal, errorBox, errorMessage, setBusy } from './modal';

type Mode = 'login' | 'register';

// regras só de UX: o servidor é a autoridade (e devolve a mensagem final)
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,22}[\p{L}\p{N}]$/u;
const PASS_MIN = 10;
const PASS_MAX = 128;

/**
 * Tela de conta (entrar / criar conta) sobre o mapa. Senha nunca é guardada:
 * campos são limpos ao concluir; a sessão é o cookie HttpOnly.
 * Esc / "Explorar sem conta" fecha e deixa só a exploração.
 */
export class AuthDialog {
  private readonly modal: Modal;
  private mode: Mode = 'login';
  private readonly tabs: Record<Mode, HTMLButtonElement>;
  private readonly name: Field;
  private readonly email: Field;
  private readonly pass: Field;
  private readonly pass2: Field;
  private readonly submit: HTMLButtonElement;
  private readonly err = errorBox();
  private readonly notice: HTMLElement;
  /** aviso fixo do cadastro (sem recuperação de senha) */
  private readonly regNote: HTMLElement;
  /** "Entrar com este e-mail" depois de REGISTRATION_FAILED */
  private readonly switchBtn: HTMLButtonElement;
  private readonly form: HTMLFormElement;
  private busy = false;
  /** concluiu login/cadastro */
  onDone: (() => void) | null = null;

  constructor(private readonly store: OnlineStore) {
    this.modal = new Modal({ title: 'Itabirito Online', className: 'auth' });
    this.name = field('Nome no jogo', { type: 'text', autocomplete: 'nickname', maxlength: '24', spellcheck: 'false' }, 'Público no ranking. 3 a 24 letras, números, espaço, ponto, - ou _.');
    this.email = field('E-mail', { type: 'email', autocomplete: 'email', inputmode: 'email', maxlength: '254', spellcheck: 'false', autocapitalize: 'none' });
    this.pass = field('Senha', { type: 'password', autocomplete: 'current-password', maxlength: String(PASS_MAX) }, '', true);
    this.pass2 = field('Repita a senha', { type: 'password', autocomplete: 'new-password', maxlength: String(PASS_MAX) });

    const tab = (m: Mode, label: string) =>
      h('button', { type: 'button', role: 'tab', id: `auth-tab-${m}`, 'aria-controls': 'auth-form', class: 'tab', onclick: () => this.setMode(m, true) }, label) as HTMLButtonElement;
    this.tabs = { login: tab('login', 'Entrar'), register: tab('register', 'Criar conta') };
    const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Acesso' }, this.tabs.login, this.tabs.register);
    tablist.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      this.setMode(this.mode === 'login' ? 'register' : 'login', true);
    });

    this.submit = h('button', { type: 'submit', class: 'btn primary block' }, 'Entrar') as HTMLButtonElement;
    this.notice = h('p', { class: 'notice', hidden: true });
    this.regNote = h('p', { class: 'muted reg-note' }, 'Guarde sua senha: não há recuperação por e-mail. Esqueceu, perdeu a conta.');
    this.switchBtn = h('button', { type: 'button', class: 'btn block', hidden: true, onclick: () => this.loginWithEmail() }, 'Entrar com este e-mail') as HTMLButtonElement;
    this.form = h(
      'form',
      { id: 'auth-form', role: 'tabpanel', class: 'auth-form', novalidate: true },
      this.notice,
      this.name.wrap,
      this.email.wrap,
      this.pass.wrap,
      this.pass2.wrap,
      this.regNote,
      this.err.el,
      this.switchBtn,
      this.submit,
    ) as HTMLFormElement;
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.onSubmit();
    });
    // limpa o erro do campo ao digitar
    for (const f of [this.name, this.email, this.pass, this.pass2]) f.input.addEventListener('input', () => setFieldError(f, null));

    this.modal.body.append(
      h('p', { class: 'lead' }, 'Compre imóveis, abra negócios e suba no ranking da cidade.'),
      tablist,
      this.form,
      h(
        'div',
        { class: 'auth-foot' },
        h('button', { type: 'button', class: 'btn ghost', onclick: () => this.modal.requestClose() }, 'Explorar sem conta'),
      ),
    );
    this.setMode('login', false);
  }

  get opened() {
    return this.modal.opened;
  }

  open(mode: Mode = this.mode, message?: string | null) {
    this.setMode(mode, false);
    this.notice.textContent = message ?? '';
    this.notice.hidden = !message;
    this.err.show(null);
    this.modal.open(this.mode === 'register' ? this.name.input : this.email.input);
  }

  close() {
    this.clearSecrets();
    this.modal.close();
  }

  private setMode(m: Mode, focus: boolean) {
    if (this.busy) return;
    this.mode = m;
    const reg = m === 'register';
    for (const [k, t] of Object.entries(this.tabs) as [Mode, HTMLButtonElement][]) {
      t.setAttribute('aria-selected', String(k === m));
      t.tabIndex = k === m ? 0 : -1;
      t.classList.toggle('active', k === m);
    }
    this.form.setAttribute('aria-labelledby', `auth-tab-${m}`);
    this.name.wrap.hidden = !reg;
    this.pass2.wrap.hidden = !reg;
    this.regNote.hidden = !reg;
    this.switchBtn.hidden = true;
    this.pass.input.autocomplete = reg ? 'new-password' : 'current-password';
    this.pass.help = reg ? `Mínimo de ${PASS_MIN} caracteres. Evite senhas comuns.` : '';
    this.submit.textContent = reg ? 'Criar conta' : 'Entrar';
    this.modal.setTitle(reg ? 'Criar conta' : 'Entrar');
    this.err.show(null);
    for (const f of [this.name, this.email, this.pass, this.pass2]) setFieldError(f, null);
    if (focus) {
      this.notice.hidden = true;
      this.tabs[m].focus();
    }
  }

  /** validação local (só UX): devolve o primeiro campo inválido */
  private validate(): Field | null {
    const reg = this.mode === 'register';
    const errs: [Field, string | null][] = [];
    if (reg) {
      const n = this.name.input.value.trim();
      errs.push([this.name, !n ? 'Informe um nome.' : !NAME_RE.test(n) ? 'Use 3 a 24 caracteres: letras, números, espaço, ponto, - ou _.' : null]);
    }
    const em = this.email.input.value.trim();
    errs.push([this.email, !em ? 'Informe o e-mail.' : !EMAIL_RE.test(em) ? 'E-mail inválido.' : null]);
    const p = this.pass.input.value;
    errs.push([this.pass, !p ? 'Informe a senha.' : reg && p.length < PASS_MIN ? `A senha precisa de pelo menos ${PASS_MIN} caracteres.` : p.length > PASS_MAX ? 'Senha longa demais.' : null]);
    if (reg) errs.push([this.pass2, this.pass2.input.value !== p ? 'As senhas não conferem.' : null]);
    let first: Field | null = null;
    for (const [f, m] of errs) {
      setFieldError(f, m);
      if (m && !first) first = f;
    }
    return first;
  }

  private async onSubmit() {
    if (this.busy) return;
    this.err.show(null);
    this.switchBtn.hidden = true;
    const bad = this.validate();
    if (bad) {
      bad.input.focus();
      return;
    }
    const reg = this.mode === 'register';
    this.busy = true;
    this.modal.dismissible = false;
    this.form.setAttribute('aria-busy', 'true');
    const inputs = [this.name, this.email, this.pass, this.pass2].map((f) => f.input);
    inputs.forEach((i) => (i.readOnly = true));
    setBusy(this.submit, true, reg ? 'Criando conta…' : 'Entrando…');
    try {
      const email = this.email.input.value.trim();
      if (reg) await this.store.register(this.name.input.value.trim(), email, this.pass.input.value);
      else await this.store.login(email, this.pass.input.value);
      this.busy = false;
      this.modal.dismissible = true;
      this.close();
      this.onDone?.();
    } catch (e) {
      this.showServerError(e);
    } finally {
      this.busy = false;
      this.modal.dismissible = true;
      this.form.removeAttribute('aria-busy');
      inputs.forEach((i) => (i.readOnly = false));
      setBusy(this.submit, false);
    }
  }

  /**
   * Erro do servidor no campo certo: nome repetido aponta o nome (senhas
   * ficam); erro de senha/credencial limpa as senhas; e-mail já cadastrado
   * oferece "Entrar com este e-mail"; 429 mostra os segundos de espera.
   */
  private showServerError(e: unknown) {
    const code = e instanceof ApiError ? e.code : '';
    const msg = errorMessage(e);
    const reg = this.mode === 'register';
    if (code === 'DISPLAY_NAME_TAKEN' && reg) {
      setFieldError(this.name, msg);
      this.name.input.focus();
      return;
    }
    if (code === 'WEAK_PASSWORD' && reg) {
      setFieldError(this.pass, msg);
      this.pass.input.value = '';
      this.pass2.input.value = '';
      this.pass.input.focus();
      return;
    }
    this.err.show(msg);
    if (code === 'REGISTRATION_FAILED' && reg) {
      // e-mail provavelmente já tem conta: caminho óbvio é entrar
      this.switchBtn.hidden = false;
      this.switchBtn.focus();
      return;
    }
    if (code === 'INVALID_CREDENTIALS') {
      this.pass.input.value = '';
      this.pass2.input.value = '';
      this.pass.input.focus();
      return;
    }
    this.submit.focus();
  }

  /** troca para "Entrar" mantendo o e-mail digitado */
  private loginWithEmail() {
    const email = this.email.input.value;
    this.setMode('login', false);
    this.email.input.value = email;
    this.clearSecrets();
    this.pass.input.focus();
  }

  private clearSecrets() {
    this.pass.input.value = '';
    this.pass2.input.value = '';
  }
}

let fid = 0;

export interface Field {
  input: HTMLInputElement;
  wrap: HTMLElement;
  msg: HTMLElement;
  /** texto de ajuda exibido quando não há erro */
  help: string;
}

/** campo rotulado com mensagem de ajuda/erro associada (aria-describedby) */
export function field(label: string, attrs: Record<string, string>, help = '', reveal = false): Field {
  const id = `f-${++fid}`;
  const input = h('input', { id, name: id, required: true, ...attrs }) as HTMLInputElement;
  const msg = h('small', { id: `${id}-m`, class: 'help', hidden: !help }, help);
  input.setAttribute('aria-describedby', msg.id);
  const control = h('div', { class: 'control' }, input);
  if (reveal) {
    // mostrar/ocultar senha
    const btn = h('button', { type: 'button', class: 'reveal', 'aria-label': 'Mostrar senha', 'aria-pressed': 'false', html: svgIcon(ICONS.eye) }) as HTMLButtonElement;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
      btn.innerHTML = svgIcon(show ? ICONS.eyeOff : ICONS.eye);
    });
    control.append(btn);
  }
  const wrap = h('div', { class: 'field' }, h('label', { for: id }, label), control, msg);
  return { input, wrap, msg, help };
}

/** erro do campo (null = volta ao texto de ajuda) */
export function setFieldError(f: Field, m: string | null) {
  f.input.setAttribute('aria-invalid', String(!!m));
  f.wrap.classList.toggle('invalid', !!m);
  f.msg.classList.toggle('is-err', !!m);
  f.msg.textContent = m ?? f.help;
  f.msg.hidden = !(m ?? f.help);
}
