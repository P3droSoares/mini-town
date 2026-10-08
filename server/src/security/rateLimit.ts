/**
 * Limite de taxa em memória (token bucket por chave). Suficiente para uma
 * instância do server; com várias instâncias, mover para o Postgres/Redis.
 */

export interface Rule {
  /** capacidade (rajada máxima) */
  capacity: number;
  /** janela em segundos para recarregar a capacidade inteira */
  perSeconds: number;
}

export interface RateLimits {
  /** toda rota, por IP */
  ip: Rule;
  /** toda rota autenticada, por usuário */
  user: Rule;
  /** login/logout/troca de senha, por IP */
  authIp: Rule;
  /** criação de contas, por rede (IPv4 exato / IPv6 /64) */
  registerIp: Rule;
  /** rotas públicas pesadas (ranking, panorama), por IP */
  publicIp: Rule;
  /** operações econômicas, por usuário */
  economyUser: Rule;
  /** operações econômicas, por IP */
  economyIp: Rule;
}

export const DEFAULT_LIMITS: RateLimits = {
  ip: { capacity: 300, perSeconds: 60 },
  user: { capacity: 240, perSeconds: 60 },
  authIp: { capacity: 20, perSeconds: 60 },
  registerIp: { capacity: 5, perSeconds: 3600 },
  publicIp: { capacity: 30, perSeconds: 60 },
  economyUser: { capacity: 40, perSeconds: 60 },
  economyIp: { capacity: 120, perSeconds: 60 },
};

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly now: () => number = Date.now) {
    // limpeza de baldes cheios (memória limitada)
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  /** Consome 1 ficha. Retorna 0 se permitido, senão segundos até liberar. */
  take(key: string, rule: Rule): number {
    const t = this.now();
    const rate = rule.capacity / (rule.perSeconds * 1000);
    const b = this.buckets.get(key) ?? { tokens: rule.capacity, at: t };
    b.tokens = Math.min(rule.capacity, b.tokens + (t - b.at) * rate);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return 0;
    }
    this.buckets.set(key, b);
    return (1 - b.tokens) / rate / 1000;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, b] of this.buckets) if (t - b.at > 3_600_000) this.buckets.delete(k);
  }

  close(): void {
    clearInterval(this.timer);
  }
}
