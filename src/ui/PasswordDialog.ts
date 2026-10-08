import type { OnlineStore } from '../net/store';
import { field, setFieldError } from './AuthDialog';
import { h } from './dom';
import { Modal, errorBox, errorMessage, setBusy } from './modal';

const PASS_MIN = 10;

/** Trocar senha (o servidor revoga as outras sessões). */
export function openPasswordDialog(store: OnlineStore, onDone: (msg: string) => void) {
  const modal = new Modal({ title: 'Trocar senha' });
  const cur = field('Senha atual', { type: 'password', autocomplete: 'current-password', maxlength: '128' }, '', true);
  const next = field('Nova senha', { type: 'password', autocomplete: 'new-password', maxlength: '128' }, `Mínimo de ${PASS_MIN} caracteres.`, true);
  const next2 = field('Repita a nova senha', { type: 'password', autocomplete: 'new-password', maxlength: '128' });
  const err = errorBox();
  const ok = h('button', { type: 'submit', class: 'btn primary' }, 'Salvar nova senha') as HTMLButtonElement;
  const cancel = h('button', { type: 'button', class: 'btn', onclick: () => modal.requestClose() }, 'Cancelar') as HTMLButtonElement;
  const form = h(
    'form',
    { novalidate: true, class: 'auth-form' },
    cur.wrap,
    next.wrap,
    next2.wrap,
    h('p', { class: 'muted' }, 'Ao trocar a senha, as sessões em outros aparelhos são encerradas.'),
    err.el,
    h('div', { class: 'actions' }, cancel, ok),
  );
  for (const f of [cur, next, next2]) f.input.addEventListener('input', () => setFieldError(f, null));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ok.disabled) return;
    err.show(null);
    const checks: [typeof cur, string | null][] = [
      [cur, cur.input.value ? null : 'Informe a senha atual.'],
      [next, next.input.value.length < PASS_MIN ? `A nova senha precisa de pelo menos ${PASS_MIN} caracteres.` : next.input.value === cur.input.value ? 'A nova senha deve ser diferente da atual.' : null],
      [next2, next2.input.value !== next.input.value ? 'As senhas não conferem.' : null],
    ];
    let first: HTMLInputElement | null = null;
    for (const [f, m] of checks) {
      setFieldError(f, m);
      if (m && !first) first = f.input;
    }
    if (first) return first.focus();
    setBusy(ok, true, 'Salvando…');
    cancel.disabled = true;
    modal.dismissible = false;
    try {
      await store.api.changePassword(cur.input.value, next.input.value);
      // renova o token CSRF da sessão atual (pode ter rotacionado)
      await store.api.me().catch(() => null);
      modal.dismissible = true;
      modal.close();
      onDone('Senha alterada. Outras sessões foram encerradas.');
    } catch (ex) {
      err.show(errorMessage(ex));
    } finally {
      for (const f of [cur, next, next2]) if (!modal.opened) f.input.value = '';
      setBusy(ok, false);
      cancel.disabled = false;
      modal.dismissible = true;
    }
  });
  modal.body.append(form);
  modal.open(cur.input);
}
