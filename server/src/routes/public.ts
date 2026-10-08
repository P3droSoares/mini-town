/**
 * Rotas públicas: saúde e ranking por patrimônio (arredondado, em cache).
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { ECONOMY } from '../economy/config.js';
import { roundSignificant } from '../economy/pricing.js';
import { cached } from '../http/cache.js';

/**
 * Patrimônio público: 2 algarismos significativos (passo mínimo I$ 1.000).
 * Somar as avaliações dos imóveis de alguém e subtrair do ranking não revela
 * mais o saldo dele (erro relativo, não absoluto).
 */
export const publicNetWorth = (v: bigint): bigint =>
  roundSignificant(v, ECONOMY.leaderboard.significantDigits, ECONOMY.leaderboard.minStep);

export async function publicRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { pool } = ctx;

  app.get('/health', { config: { auth: 'none' } }, async () => ({ ok: true }));

  // agregação sobre todos os jogadores: uma por janela de cache, não uma por requisição
  const leaderboard = cached(ctx.policy.publicCacheMs, async () => {
    const { rows } = await pool.query<{ display_name: string; net_worth: string }>(
      `SELECT display_name, nw::text AS net_worth FROM (
         SELECT u.display_name, u.created_at,
                a.balance - u.tax_debt + coalesce(sum(p.base_price * mi.index_bp / ${ECONOMY.index.baseBp}), 0) AS nw
           FROM users u
           JOIN accounts a ON a.user_id = u.id
           LEFT JOIN properties p ON p.owner_id = u.id
           LEFT JOIN market_indices mi ON mi.category = p.category
          GROUP BY u.id, a.balance
       ) t
       ORDER BY nw DESC, created_at
       LIMIT $1`,
      [ECONOMY.leaderboard.size],
    );
    return {
      items: rows.map((r, i) => ({
        rank: i + 1,
        displayName: r.display_name,
        netWorth: publicNetWorth(BigInt(r.net_worth)).toString(),
      })),
    };
  });

  app.get('/leaderboard', { config: { auth: 'none', limit: 'public' } }, () => leaderboard());
}
