/**
 * Mercado entre jogadores e panorama do mercado.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { CATEGORIES, ECONOMY, reais } from '../economy/config.js';
import { readAllIndices } from '../economy/indices.js';
import {
  buyListing,
  cancelListing,
  createListing,
  LISTING_IN_RANGE,
  SELECT_LISTING,
  toListingView,
  type ListingRow,
} from '../economy/service.js';
import { cached } from '../http/cache.js';
import { centsSchema, cursorSchema, emptyBody, lotIdSchema, parse, uuidSchema } from '../http/validate.js';
import { econ } from './econ.js';

const PAGE = 30;
const ListQuery = z.strictObject({ category: z.enum(CATEGORIES).optional(), cursor: cursorSchema.optional() });
const CreateBody = z.strictObject({ lotId: lotIdSchema, askPrice: centsSchema(ECONOMY.market.maxAskPrice) });
const IdParams = z.strictObject({ id: uuidSchema });

/** Preço público de venda recente: arredondado a I$ 1.000. */
const SALE_STEP = reais(1_000);
const roundSale = (v: bigint) => ((v + SALE_STEP / 2n) / SALE_STEP) * SALE_STEP;

export async function marketRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { pool } = ctx;
  const ECO = { config: { auth: 'required', limit: 'economy' } } as const;

  app.get('/market/listings', { config: { auth: 'required' } }, async (req) => {
    const q = parse(ListQuery, req.query);
    // só anúncios compráveis: ativos, não vencidos e com preço ainda dentro da faixa
    const { rows } = await pool.query<ListingRow>(
      `${SELECT_LISTING}
        WHERE l.status = 'active'
          AND l.created_at > now() - make_interval(days => $4)
          AND ${LISTING_IN_RANGE}
          AND ($1::text IS NULL OR p.category = $1)
          AND ($2::bigint IS NULL OR l.seq < $2::bigint)
        ORDER BY l.seq DESC
        LIMIT $3`,
      [q.category ?? null, q.cursor ?? null, PAGE + 1, ECONOMY.market.listingTtlDays],
    );
    const page = rows.slice(0, PAGE);
    return {
      items: page.map((r) => toListingView(r, req.auth!.user.id)),
      nextCursor: rows.length > PAGE ? page[page.length - 1]!.seq.toString() : null,
    };
  });

  app.post('/market/listings', ECO, async (req, reply) => {
    const body = parse(CreateBody, req.body);
    return econ(ctx, req, reply, (c, e) => createListing(c, e, body.lotId, body.askPrice));
  });

  app.delete('/market/listings/:id', ECO, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    parse(emptyBody, req.body);
    return econ(ctx, req, reply, (c, e) => cancelListing(c, e, id));
  });

  app.post('/market/listings/:id/buy', ECO, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    parse(emptyBody, req.body);
    return econ(ctx, req, reply, (c, e) => buyListing(c, e, id));
  });

  // público: sem lote, preço arredondado, hora cheia e com atraso (não reconstrói o histórico de ninguém);
  // sem massa monetária (com poucos jogadores revelaria saldos)
  const overview = cached(ctx.policy.publicCacheMs, async () => {
    const until = new Date(Date.now() - ctx.policy.recentSalesDelayMs);
    const [indices, sales, stats] = await Promise.all([
      readAllIndices(pool),
      pool.query<{ kind: string; category: string; amount: bigint; created_at: Date }>(
        `SELECT t.kind, p.category, t.amount, date_trunc('hour', t.created_at) AS created_at
           FROM ledger_transactions t JOIN properties p ON p.lot_id = t.lot_id
          WHERE t.kind IN ('city_purchase', 'city_sale', 'market_sale') AND t.created_at <= $1
          ORDER BY t.id DESC LIMIT 20`,
        [until],
      ),
      pool.query<{ players: number; owned: number; listings: number }>(
        `SELECT (SELECT count(*)::int FROM accounts WHERE kind = 'player') AS players,
                (SELECT count(*)::int FROM properties WHERE owner_id IS NOT NULL) AS owned,
                (SELECT count(*)::int FROM listings WHERE status = 'active') AS listings`,
      ),
    ]);
    const s = stats.rows[0]!;
    return {
      indices: Object.fromEntries(Object.entries(indices).map(([k, v]) => [k, v / ECONOMY.index.baseBp])),
      recentSales: sales.rows.map((r) => ({
        kind: r.kind,
        category: r.category,
        price: roundSale(r.amount).toString(),
        at: r.created_at.toISOString(),
      })),
      stats: { players: s.players, ownedProperties: s.owned, activeListings: s.listings },
    };
  });

  app.get('/market/overview', { config: { auth: 'none', limit: 'public' } }, () => overview());
}
