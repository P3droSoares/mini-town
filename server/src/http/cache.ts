/**
 * Cache em memória de uma resposta (TTL) com "single-flight": chamadas
 * simultâneas durante o recálculo compartilham a mesma promessa.
 */
export function cached<T>(ttlMs: number, load: () => Promise<T>, now: () => number = Date.now): () => Promise<T> {
  let value: { at: number; v: T } | null = null;
  let inflight: Promise<T> | null = null;
  return () => {
    if (ttlMs > 0 && value && now() - value.at < ttlMs) return Promise.resolve(value.v);
    inflight ??= load()
      .then((v) => {
        value = { at: now(), v };
        return v;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}
