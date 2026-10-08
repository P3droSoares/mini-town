/**
 * Dados do próprio jogador (o usuário vem sempre da sessão, nunca do cliente).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { playerAccountId } from '../economy/ledger.js';
import { ownedPropertyRows, walletView } from '../economy/views.js';
import { cursorSchema, parse } from '../http/validate.js';

const PAGE = 50;
const TxQuery = z.strictObject({ cursor: cursorSchema.optional() });

export async function meRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { pool } = ctx;

  app.get('/me/wallet', { config: { auth: 'required' } }, async (req) => walletView(pool, req.auth!.user.id, ctx.clock()));

  app.get('/me/properties', { config: { auth: 'required' } }, async (req) => {
    const { views } = await ownedPropertyRows(pool, req.auth!.user.id, ctx.clock());
    return { properties: views };
  });

  app.get('/me/transactions', { config: { auth: 'required' } }, async (req) => {
    const q = parse(TxQuery, req.query);
    const accountId = await playerAccountId(pool, req.auth!.user.id);
    const { rows } = await pool.query<{ id: bigint; amount: bigint; kind: string; lot_id: string | null; created_at: Date }>(
      `SELECT e.id, e.amount, t.kind, t.lot_id, t.created_at
         FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.tx_id
        WHERE e.account_id = $1 AND ($2::bigint IS NULL OR e.id < $2::bigint)
        ORDER BY e.id DESC
        LIMIT $3`,
      [accountId.toString(), q.cursor ?? null, PAGE + 1],
    );
    const page = rows.slice(0, PAGE);
    return {
      items: page.map((r) => ({
        id: r.id.toString(),
        kind: r.kind,
        lotId: r.lot_id,
        amount: r.amount.toString(),
        createdAt: r.created_at.toISOString(),
      })),
      nextCursor: rows.length > PAGE ? page[page.length - 1]!.id.toString() : null,
    };
  });
}
