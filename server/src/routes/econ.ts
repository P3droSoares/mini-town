/**
 * Adaptador HTTP → operação econômica (idempotente, transacional).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../context.js';
import { playerAccountId } from '../economy/ledger.js';
import { runEconomic, type EconResult } from '../economy/runner.js';
import type { EconCtx } from '../economy/service.js';

export async function econ(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  fn: (c: pg.PoolClient, e: EconCtx) => Promise<EconResult>,
): Promise<FastifyReply> {
  const userId = req.auth!.user.id;
  const accountId = await playerAccountId(ctx.pool, userId);
  // `now` vem do runner, lido depois das travas (e de novo a cada repetição da transação)
  const out = await runEconomic(ctx.pool, req, userId, ctx.clock, (c, now) =>
    fn(c, { sys: ctx.sys, userId, accountId, ipHmac: req.ipHmac, now }),
  );
  if (out.replayed) reply.header('idempotent-replayed', 'true');
  if (out.status === 204) return reply.status(204).send();
  return reply.status(out.status).send(out.body);
}
