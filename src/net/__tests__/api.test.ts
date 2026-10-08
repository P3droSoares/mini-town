import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api, ApiError } from '../api';
import { json, mockFetch, noContent, user, wallet } from './fetchMock';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function loggedIn(routes: Parameters<typeof mockFetch>[0]) {
  const m = mockFetch({ 'GET /auth/me': [json(200, { user, csrfToken: 'csrf-1' })], ...routes });
  const api = new Api();
  await api.me();
  return { api, ...m };
}

describe('Api', () => {
  it('401 numa rota autenticada chama onUnauthorized e esquece o CSRF', async () => {
    const { api } = await loggedIn({ 'GET /me/wallet': [json(401, { error: { code: 'UNAUTHORIZED', message: 'Faça login.' } })] });
    const spy = vi.fn();
    api.onUnauthorized = spy;
    await expect(api.wallet()).rejects.toMatchObject({ status: 401 });
    expect(spy).toHaveBeenCalledOnce();
    expect(api.hasCsrf).toBe(false);
  });

  it('401 esperado (/auth/me) não dispara onUnauthorized', async () => {
    mockFetch({ 'GET /auth/me': [json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } })] });
    const api = new Api();
    const spy = vi.fn();
    api.onUnauthorized = spy;
    expect(await api.me()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('403 BAD_CSRF: renova o token e repete UMA vez com a mesma Idempotency-Key', async () => {
    const { api, calls, routes } = await loggedIn({
      'POST /income/collect': [json(403, { error: { code: 'BAD_CSRF', message: 'CSRF' } }), json(200, { collected: '10', tax: '0', wallet })],
    });
    routes['GET /auth/me'] = [json(200, { user, csrfToken: 'csrf-2' })];
    const r = await api.collectIncome('11111111-1111-4111-8111-111111111111');
    expect(r.collected).toBe('10');
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0].headers['Idempotency-Key']).toBe('11111111-1111-4111-8111-111111111111');
    expect(posts[1].headers['Idempotency-Key']).toBe('11111111-1111-4111-8111-111111111111');
    expect(posts[0].headers['X-CSRF-Token']).toBe('csrf-1');
    expect(posts[1].headers['X-CSRF-Token']).toBe('csrf-2');
  });

  it('403 BAD_CSRF repetido não entra em laço', async () => {
    const { api, calls } = await loggedIn({ 'POST /income/collect': [json(403, { error: { code: 'BAD_CSRF', message: 'CSRF' } })] });
    await expect(api.collectIncome('k')).rejects.toMatchObject({ status: 403, code: 'BAD_CSRF' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('204 devolve undefined', async () => {
    const { api } = await loggedIn({ 'DELETE /market/listings/7': [noContent()] });
    await expect(api.cancelListing('7', 'k')).resolves.toBeUndefined();
  });

  it('resposta sem JSON (Vite puro) = offline NO_BACKEND', async () => {
    const html = () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
    mockFetch({ 'GET /health': [html], 'GET /me/wallet': [html] });
    const api = new Api();
    expect(await api.health()).toBe(false);
    await expect(api.wallet()).rejects.toSatisfy((e: unknown) => e instanceof ApiError && e.offline && e.code === 'NO_BACKEND');
  });

  it('falha de rede = offline e repetível', async () => {
    mockFetch({ 'GET /me/wallet': [new TypeError('failed to fetch')] });
    const e = await new Api().wallet().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).offline).toBe(true);
    expect((e as ApiError).retryable).toBe(true);
  });

  it('502 do proxy é offline; 503 MAINTENANCE não (economia travada, leitura ok)', async () => {
    const { api } = await loggedIn({
      'GET /me/wallet': [new Response('Bad Gateway', { status: 502, headers: { 'content-type': 'text/plain' } })],
      'POST /income/collect': [json(503, { error: { code: 'MAINTENANCE', message: 'Economia em manutenção.' } })],
    });
    const spy = vi.fn();
    api.onMaintenance = spy;
    const bad = (await api.wallet().catch((x: unknown) => x)) as ApiError;
    expect(bad.offline).toBe(true);
    const m = (await api.collectIncome('k').catch((x: unknown) => x)) as ApiError;
    expect(m.maintenance).toBe(true);
    expect(m.offline).toBe(false);
    expect(spy).toHaveBeenCalledWith(true);
  });

  it('429 traz Retry-After e não é recusa definitiva', async () => {
    const { api } = await loggedIn({ 'POST /income/collect': [json(429, { error: { code: 'RATE_LIMITED', message: 'Muitas requisições.' } }, { 'retry-after': '7' })] });
    const e = (await api.collectIncome('k').catch((x: unknown) => x)) as ApiError;
    expect(e.retryAfter).toBe(7);
    expect(e.retryable).toBe(true);
  });

  it('409 de regra é recusa definitiva', async () => {
    const { api } = await loggedIn({ 'POST /properties/ITB-1/buy': [json(409, { error: { code: 'ALREADY_OWNED', message: 'Já tem dono.' } })] });
    const e = (await api.buyFromCity('ITB-1', 'k').catch((x: unknown) => x)) as ApiError;
    expect(e.retryable).toBe(false);
    expect(e.message).toBe('Já tem dono.');
  });

  it('polling marca X-Background; ação do jogador marca X-User-Activity', async () => {
    const { api, calls } = await loggedIn({ 'GET /me/wallet': [json(200, wallet)] });
    await api.wallet(true);
    await api.wallet(false);
    const w = calls.filter((c) => c.url.endsWith('/me/wallet'));
    expect(w[0].headers['X-Background']).toBe('1');
    expect(w[0].headers['X-User-Activity']).toBeUndefined();
    expect(w[1].headers['X-User-Activity']).toBe('1');
  });

  it('logout que falha mantém a sessão; 401 no logout conta como saiu', async () => {
    const { api } = await loggedIn({ 'POST /auth/logout': [json(500, { error: { code: 'INTERNAL', message: 'Erro interno.' } })] });
    await expect(api.logout()).rejects.toBeInstanceOf(ApiError);
    expect(api.hasCsrf).toBe(true);
    const ok = await loggedIn({ 'POST /auth/logout': [json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } })] });
    await expect(ok.api.logout()).resolves.toBeUndefined();
    expect(ok.api.hasCsrf).toBe(false);
  });

  it('cancelamento externo vira ABORTED (não é offline)', async () => {
    mockFetch({ 'GET /properties/ITB-1': [json(200, {})] });
    const ctl = new AbortController();
    ctl.abort();
    const e = (await new Api().property('ITB-1', ctl.signal).catch((x: unknown) => x)) as ApiError;
    expect(e.aborted).toBe(true);
    expect(e.offline).toBe(false);
  });

  it('lotId inválido nem sai do cliente', async () => {
    const { fn } = mockFetch({});
    await expect(new Api().property('../../admin')).rejects.toMatchObject({ code: 'BAD_LOT' });
    expect(fn).not.toHaveBeenCalled();
  });
});
