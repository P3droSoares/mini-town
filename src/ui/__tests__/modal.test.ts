// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../net/api';
import { h, iconEl, ICONS } from '../dom';
import { closeAllModals, confirmAction, setBusy, setSessionUserProvider } from '../modal';

const flush = () => new Promise((r) => setTimeout(r, 0));
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

function confirmButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('.confirm-form button[type=submit]')!;
}
async function submit() {
  confirmButton().closest('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
}

afterEach(() => {
  closeAllModals();
  setSessionUserProvider(() => null);
});

describe('setBusy', () => {
  it('devolve ícone e spans (não achata o botão em texto)', () => {
    const amt = h('span', { class: 'amt' }, 'I$ 12');
    const b = h('button', {}, iconEl(ICONS.coins), h('span', { class: 'lbl' }, 'Coletar'), amt) as HTMLButtonElement;
    setBusy(b, true, 'Coletando…');
    expect(b.textContent).toBe('Coletando…');
    setBusy(b, false);
    expect(b.querySelector('svg')).not.toBeNull();
    expect(b.querySelector('.amt')).toBe(amt);
    expect(amt.isConnected || b.contains(amt)).toBe(true);
    // sem rótulo: só estado
    setBusy(b, true);
    expect(b.disabled).toBe(true);
    expect(b.querySelector('.amt')).toBe(amt);
    setBusy(b, false);
    expect(b.disabled).toBe(false);
  });
});

describe('confirmAction', () => {
  it('falha incerta (rede/500) repete com a MESMA chave', async () => {
    const keys: string[] = [];
    const run = vi.fn(async (k: string) => {
      keys.push(k);
      if (keys.length === 1) throw new ApiError(0, 'NETWORK', 'sem rede');
      if (keys.length === 2) throw new ApiError(500, 'INTERNAL', 'erro');
    });
    const done = confirmAction({ title: 'Comprar?', confirmLabel: 'Comprar', run });
    await frame();
    await submit();
    expect(confirmButton().textContent).toBe('Tentar de novo');
    await submit();
    await submit();
    expect(await done).toBe(true);
    expect(new Set(keys).size).toBe(1);
  });

  it('recusa definitiva (409): "Fechar", avisa onRejected e não repete', async () => {
    const run = vi.fn(async () => {
      throw new ApiError(409, 'ALREADY_OWNED', 'Já tem dono.');
    });
    const onRejected = vi.fn();
    const done = confirmAction({ title: 'Comprar?', confirmLabel: 'Comprar', run, onRejected });
    await frame();
    await submit();
    expect(onRejected).toHaveBeenCalledOnce();
    expect(confirmButton().textContent).toBe('Fechar');
    expect(document.querySelector('.err-box[role=alert]')?.textContent).toContain('Já tem dono.');
    await submit();
    expect(run).toHaveBeenCalledOnce();
    expect(await done).toBe(false);
  });

  it('outra conta entrou depois de abrir: aborta sem executar', async () => {
    let id = 'a';
    setSessionUserProvider(() => id);
    const run = vi.fn(async () => {});
    const done = confirmAction({ title: 'Comprar?', confirmLabel: 'Comprar', run });
    await frame();
    id = 'b';
    await submit();
    expect(run).not.toHaveBeenCalled();
    expect(await done).toBe(false);
  });

  it('closeAllModals fecha confirmações abertas (sessão expirou)', async () => {
    const done = confirmAction({ title: 'Comprar?', confirmLabel: 'Comprar', run: async () => {} });
    await frame();
    closeAllModals();
    expect(document.querySelector('.dlg-backdrop')).toBeNull();
    expect(await done).toBe(false);
  });
});
