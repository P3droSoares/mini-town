import { vi } from 'vitest';

/** chamada registrada pelo mock de fetch */
export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = Response | (() => Response) | Error;

/**
 * `fetch` falso: respostas por "MÉTODO /caminho" (fila; a última se repete).
 * Guarda as chamadas para conferir cabeçalhos (CSRF, Idempotency-Key...).
 */
export function mockFetch(routes: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.replace(/^\/api/, '').split('?')[0];
    calls.push({ method, url, headers: { ...(init.headers as Record<string, string>) }, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const q = routes[`${method} ${path}`];
    if (!q?.length) return json(404, { error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
    const r = q.length > 1 ? q.shift()! : q[0];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r.clone();
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn, routes };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export const noContent = () => new Response(null, { status: 204 });

export const user = { id: '00000000-0000-4000-8000-000000000001', displayName: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' };
export const wallet = { balance: '3000000', netWorth: '3000000', pendingIncome: '0', starterAvailable: true, taxDebt: '0', marketUnlockAt: null };
