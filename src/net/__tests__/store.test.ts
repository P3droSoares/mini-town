// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_MS, OnlineStore } from '../store';
import { json, mockFetch, noContent, user, wallet } from './fetchMock';

const own = (mine: string[] = [], listed: string[] = []) => json(200, { owned: [...mine, ...listed], mine, listed });
const down = () => new Response('Bad Gateway', { status: 502, headers: { 'content-type': 'text/plain' } });

const stores: OnlineStore[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function online(extra: Parameters<typeof mockFetch>[0] = {}) {
  const m = mockFetch({
    'GET /health': [json(200, { ok: true })],
    'GET /auth/me': [json(200, { user, csrfToken: 'c' })],
    'GET /me/wallet': [json(200, wallet)],
    'GET /properties/ownership': [own(['ITB-1'])],
    ...extra,
  });
  const store = new OnlineStore();
  stores.push(store);
  await store.connect();
  expect(store.status).toBe('online');
  return { store, ...m };
}

describe('OnlineStore', () => {
  it('sem backend: offline sem lançar', async () => {
    mockFetch({ 'GET /health': [new TypeError('offline')] });
    const store = new OnlineStore();
    stores.push(store);
    await store.connect();
    expect(store.status).toBe('offline');
  });

  it('logout que falha NÃO limpa o estado local (o cookie ainda vale)', async () => {
    const { store } = await online({ 'POST /auth/logout': [json(503, { error: { code: 'HTTP_503', message: 'fora' } })] });
    await expect(store.logout()).rejects.toBeTruthy();
    expect(store.status).toBe('online');
    expect(store.user?.id).toBe(user.id);
  });

  it('logout confirmado limpa tudo', async () => {
    const { store } = await online({ 'POST /auth/logout': [noContent()] });
    await store.logout();
    expect(store.status).toBe('anonymous');
    expect(store.user).toBeNull();
    expect(store.mine.size).toBe(0);
  });

  it('502 transitório no polling: "reconectando", sem cair para offline', async () => {
    const { store, routes } = await online();
    routes['GET /me/wallet'] = [down()];
    await store.refreshWallet();
    expect(store.status).toBe('online');
    expect(store.reconnecting).toBe(true);
    // servidor volta: a sonda de /health refaz as consultas e limpa o aviso
    routes['GET /me/wallet'] = [json(200, wallet)];
    await vi.advanceTimersByTimeAsync(7000);
    expect(store.reconnecting).toBe(false);
    expect(store.status).toBe('online');
  });

  it('servidor fora de verdade: offline depois de várias falhas e reconexão automática', async () => {
    const { store, routes } = await online();
    routes['GET /me/wallet'] = [down()];
    routes['GET /health'] = [down()];
    await store.refreshWallet();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.status).toBe('offline');
    // volta sozinho, sem clique
    routes['GET /health'] = [json(200, { ok: true })];
    routes['GET /me/wallet'] = [json(200, wallet)];
    await vi.advanceTimersByTimeAsync(70_000);
    expect(store.status).toBe('online');
    expect(store.user?.id).toBe(user.id);
  });

  it('503 MAINTENANCE numa ação marca manutenção sem derrubar a sessão', async () => {
    const { store } = await online({ 'POST /income/collect': [json(503, { error: { code: 'MAINTENANCE', message: 'Economia em manutenção.' } })] });
    await expect(store.api.collectIncome('k')).rejects.toBeTruthy();
    expect(store.maintenance).toBe(true);
    expect(store.status).toBe('online');
  });

  it('mapa de donos só é emitido quando muda', async () => {
    const { store } = await online();
    const spy = vi.fn();
    store.on('ownership', spy);
    await store.refreshOwnership();
    expect(spy).not.toHaveBeenCalled();
  });

  it('resposta velha do polling não sobrescreve a carteira de uma operação', async () => {
    let release!: () => void;
    const { store, routes } = await online();
    routes['GET /me/wallet'] = [
      () => {
        // a resposta "chega" depois da operação
        return new Response(new ReadableStream({ start: (c) => void (release = () => (c.enqueue(new TextEncoder().encode(JSON.stringify({ ...wallet, balance: '1' }))), c.close())) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    ];
    const p = store.refreshWallet();
    await vi.advanceTimersByTimeAsync(0);
    store.applyWallet({ ...wallet, balance: '999' });
    release();
    await p;
    expect(store.wallet?.balance).toBe('999');
  });

  it('jogador ausente: polling para (a sessão pode expirar por inatividade)', async () => {
    const { store, calls } = await online();
    const before = calls.filter((c) => c.url.endsWith('/me/wallet')).length;
    await vi.advanceTimersByTimeAsync(IDLE_MS + 5 * 60_000);
    const polled = calls.filter((c) => c.url.endsWith('/me/wallet')).slice(before);
    // polls só enquanto ativo (e marcados como de fundo)
    expect(polled.length).toBeGreaterThan(0);
    expect(polled.every((c) => c.headers['X-Background'] === '1')).toBe(true);
    const last = polled.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls.filter((c) => c.url.endsWith('/me/wallet')).slice(before).length).toBe(last);
    expect(store.idle).toBe(true);
    // voltou a mexer: atualiza na hora
    window.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((c) => c.url.endsWith('/me/wallet')).slice(before).length).toBe(last + 1);
  });

  it('401 em segundo plano volta para anônimo com aviso de sessão expirada', async () => {
    const { store, routes } = await online();
    routes['GET /me/wallet'] = [json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } })];
    await store.refreshWallet();
    expect(store.status).toBe('anonymous');
    expect(store.expiredMessage).toMatch(/expirou/);
  });
});
