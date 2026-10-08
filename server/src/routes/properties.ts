/**
 * Imóveis: consulta, posse, casa inicial, compra/venda ao governo,
 * residência, negócios e coleta de renda.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { BUSINESS_TYPES } from '../economy/config.js';
import {
  buyFromCity,
  claimStarterHome,
  closeBusiness,
  collectIncome,
  openBusiness,
  sellToCity,
  setResidence,
  upgradeBusiness,
} from '../economy/service.js';
import { propertyView, starterHomeViews } from '../economy/views.js';
import { notFound } from '../http/errors.js';
import { emptyBody, lotIdSchema, parse } from '../http/validate.js';
import { econ } from './econ.js';

const LotParams = z.strictObject({ lotId: lotIdSchema });
const ClaimBody = z.strictObject({ lotId: lotIdSchema });
const BusinessBody = z.strictObject({ type: z.enum(BUSINESS_TYPES as [string, ...string[]]) });

export async function propertyRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { pool } = ctx;
  const ECO = { config: { auth: 'required', limit: 'economy' } } as const;

  app.get('/properties/ownership', { config: { auth: 'required' } }, async (req) => {
    const { rows } = await pool.query<{ lot_id: string; mine: boolean; listed: boolean }>(
      `SELECT p.lot_id, p.owner_id = $1 AS mine,
              EXISTS (SELECT 1 FROM listings l WHERE l.lot_id = p.lot_id AND l.status = 'active') AS listed
         FROM properties p WHERE p.owner_id IS NOT NULL ORDER BY p.lot_id`,
      [req.auth!.user.id],
    );
    return {
      owned: rows.map((r) => r.lot_id),
      mine: rows.filter((r) => r.mine).map((r) => r.lot_id),
      listed: rows.filter((r) => r.listed).map((r) => r.lot_id),
    };
  });

  app.get('/properties/:lotId', { config: { auth: 'required' } }, async (req) => {
    const { lotId } = parse(LotParams, req.params);
    const v = await propertyView(pool, lotId, req.auth!.user.id, ctx.clock());
    if (!v) throw notFound('Imóvel não encontrado.');
    return v;
  });

  app.get('/starter-homes', { config: { auth: 'required' } }, async (req) => ({
    homes: await starterHomeViews(pool, req.auth!.user.id),
  }));

  app.post('/starter-homes/claim', ECO, async (req, reply) => {
    const { lotId } = parse(ClaimBody, req.body);
    return econ(ctx, req, reply, (c, e) => claimStarterHome(c, e, lotId));
  });

  app.post('/properties/:lotId/buy', ECO, async (req, reply) => {
    const { lotId } = parse(LotParams, req.params);
    parse(emptyBody, req.body);
    return econ(ctx, req, reply, (c, e) => buyFromCity(c, e, lotId));
  });

  app.post('/properties/:lotId/sell-to-city', ECO, async (req, reply) => {
    const { lotId } = parse(LotParams, req.params);
    parse(emptyBody, req.body);
    return econ(ctx, req, reply, (c, e) => sellToCity(c, e, lotId));
  });

  app.post('/properties/:lotId/residence', ECO, async (req, reply) => {
    const { lotId } = parse(LotParams, req.params);
    parse(emptyBody, req.body);
    return econ(ctx, req, reply, (c, e) => setResidence(c, e, lotId));
  });

  app.post('/properties/:lotId/business', ECO, async (req, reply) => {
    const { lotId } = parse(LotParams, req.params);
    const { type } = parse(BusinessBody, req.body);
    return econ(ctx, req, reply, (c, e) => openBusiness(c, e, lotId, type as (typeof BUSINESS_TYPES)[number]));
  });

  // fecha o negócio (sem reembolso), p.ex. para trocar de tipo
  app.delete('/properties/:lotId/business', ECO, async (req, reply) => {
    const { lotId } = parse(LotParams, req.params);
    parse(emptyBody, req.body);
    return econ(ctx, req, reply, (c, e) => closeBusiness(c, e, lotId));
  });

  app.post('/properties/:lotId/business/upgrade', ECO, async (req, reply) => {
    const { lotId } = parse(LotParams, req.params);
    parse(emptyBody, req.body);
    return econ(ctx, req, reply, (c, e) => upgradeBusiness(c, e, lotId));
  });

  app.post('/income/collect', ECO, async (req, reply) => {
    parse(emptyBody, req.body);
    return econ(ctx, req, reply, (c, e) => collectIncome(c, e));
  });
}
