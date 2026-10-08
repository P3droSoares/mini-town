/**
 * Verificação periódica dos invariantes contábeis. Divergência = log de
 * alarme + trava das operações econômicas (modo manutenção). A liberação é
 * manual (papel dono), depois de investigar.
 *
 * Incremental: a cada execução só os lançamentos depois do ponto de
 * verificação (`ledger_checkpoint`) são somados; uma vez por dia (ou sem
 * ponto) a verificação é completa, sem timeout de comando.
 */
import type pg from 'pg';
import { audit } from '../audit.js';
import { ECONOMY } from './config.js';

export interface InvariantReport {
  ok: boolean;
  mode: 'full' | 'incremental';
  unbalancedTx: string[];
  balanceMismatch: string[];
  negativePlayers: number;
  /** débitos em conta de sistema por tipo de transação não autorizado */
  unauthorizedDebits: string[];
  /** usuários sem exatamente um bônus de cadastro */
  signupMismatch: number;
  /** imóveis cujo dono não bate com a última transação de posse (só na completa) */
  ownershipMismatch: string[];
  /** anúncios ativos de quem não é dono */
  listingMismatch: string[];
  /** residências em imóvel que não é do usuário */
  residenceMismatch: number;
  /** soma dos saldos fora do TESOURO (jogadores + IMPOSTOS + TAXAS + GOVERNO) */
  moneySupply: string;
  /** emissão registrada no razão (= −saldo do TESOURO) */
  emission: string;
  /** emissão esperada por fontes independentes: bônus × contas + subsídios − devolvidos + renda + ajustes */
  expectedEmission: string;
  /** alertas de taxa (não travam): emissão por hora, saldo do GOVERNO */
  alerts: string[];
}

const HORIZON_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const JOB_LOCK = 7_420_313;

interface Checkpoint {
  last_entry_id: bigint;
  last_tx_id: bigint;
  income_total: string;
  adjust_total: string;
  full_checked_at: Date | null;
}

/**
 * Executa a verificação. `null` = outra instância já está verificando.
 * `opts.full` força a verificação completa.
 */
export async function checkInvariants(pool: pg.Pool, opts: { full?: boolean } = {}): Promise<InvariantReport> {
  const c = await pool.connect();
  let broken = false;
  try {
    // foto consistente de todas as tabelas
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    // uma verificação por vez (várias instâncias / ticks atrasados): espera a outra terminar
    await c.query('SELECT pg_advisory_xact_lock($1)', [JOB_LOCK]);
    const now = (await c.query<{ now: Date }>('SELECT now() AS now')).rows[0]!.now;
    const cp = (await c.query<Checkpoint>('SELECT * FROM ledger_checkpoint WHERE id = 1')).rows[0];
    const full = opts.full || !cp || !cp.full_checked_at || now.getTime() - cp.full_checked_at.getTime() > DAY_MS;
    if (full) await c.query(`SET LOCAL statement_timeout = 0`);
    const lastEntry = full ? 0n : cp!.last_entry_id;
    const lastTx = full ? 0n : cp!.last_tx_id;
    const horizon = new Date(now.getTime() - HORIZON_MS);
    const sys = new Map(
      (await c.query<{ id: bigint; code: string }>(`SELECT id, code FROM accounts WHERE kind = 'system'`)).rows.map((r) => [
        r.code,
        r.id,
      ]),
    );

    // até onde o ponto pode avançar: nada mais novo que o horizonte (transações em voo)
    const newLastEntry = BigInt(
      (
        await c.query<{ v: string }>(
          `SELECT coalesce((SELECT min(id) - 1 FROM ledger_entries WHERE id > $1 AND created_at >= $2),
                           (SELECT max(id) FROM ledger_entries WHERE id > $1), $1)::text AS v`,
          [lastEntry.toString(), horizon],
        )
      ).rows[0]!.v,
    );
    const newLastTx = BigInt(
      (
        await c.query<{ v: string }>(
          `SELECT coalesce((SELECT min(id) - 1 FROM ledger_transactions WHERE id > $1 AND created_at >= $2),
                           (SELECT max(id) FROM ledger_transactions WHERE id > $1), $1)::text AS v`,
          [lastTx.toString(), horizon],
        )
      ).rows[0]!.v,
    );

    const unbalanced = await c.query<{ id: bigint }>(
      `SELECT t.id FROM ledger_transactions t LEFT JOIN ledger_entries e ON e.tx_id = t.id
        WHERE t.id > $1
        GROUP BY t.id HAVING coalesce(sum(e.amount), 0) <> 0 OR count(e.id) < 2
        ORDER BY t.id LIMIT 20`,
      [lastTx.toString()],
    );
    const unauthorized = await c.query<{ id: bigint }>(
      `SELECT DISTINCT t.id FROM ledger_transactions t
         JOIN ledger_entries e ON e.tx_id = t.id JOIN accounts a ON a.id = e.account_id
        WHERE t.id > $1 AND a.kind = 'system' AND e.amount < 0
          AND NOT ((a.code = 'TESOURO' AND t.kind IN ('signup_grant', 'starter_home', 'income', 'adjustment'))
                OR (a.code = 'GOVERNO' AND t.kind = 'city_sale'))
        ORDER BY t.id LIMIT 20`,
      [lastTx.toString()],
    );

    // saldos: ponto + lançamentos novos; o que é ≤ newLastEntry entra no próximo ponto
    const base = new Map<string, bigint>();
    if (!full) {
      const { rows } = await c.query<{ account_id: bigint; balance: string }>(
        'SELECT account_id, balance::text AS balance FROM ledger_checkpoint_balances',
      );
      for (const r of rows) base.set(r.account_id.toString(), BigInt(r.balance));
    }
    const deltas = await c.query<{ account_id: bigint; all_delta: string; settled: string }>(
      `SELECT account_id, sum(amount)::text AS all_delta,
              coalesce(sum(amount) FILTER (WHERE id <= $2), 0)::text AS settled
         FROM ledger_entries WHERE id > $1 GROUP BY account_id`,
      [lastEntry.toString(), newLastEntry.toString()],
    );
    const current = new Map(base);
    const nextBase = new Map(base);
    for (const d of deltas.rows) {
      const k = d.account_id.toString();
      current.set(k, (current.get(k) ?? 0n) + BigInt(d.all_delta));
      nextBase.set(k, (nextBase.get(k) ?? 0n) + BigInt(d.settled));
    }
    const players = await c.query<{ id: bigint; balance: bigint }>(`SELECT id, balance FROM accounts WHERE kind = 'player'`);
    const mismatch: string[] = [];
    let negative = 0;
    let playerSum = 0n;
    for (const p of players.rows) {
      playerSum += p.balance;
      if (p.balance < 0n) negative++;
      if (p.balance !== (current.get(p.id.toString()) ?? 0n) && mismatch.length < 20) mismatch.push(p.id.toString());
    }
    const sysBal = (code: string) => current.get(sys.get(code)?.toString() ?? '') ?? 0n;
    const emission = -sysBal('TESOURO');
    const supply = playerSum + sysBal('IMPOSTOS') + sysBal('TAXAS') + sysBal('GOVERNO');

    // emissão esperada por fontes que não são os lançamentos do TESOURO
    const totals = await c.query<{ income: string; adjust: string; income_settled: string; adjust_settled: string }>(
      `SELECT coalesce(sum(t.amount) FILTER (WHERE t.kind = 'income'), 0)::text AS income,
              coalesce(sum(t.amount) FILTER (WHERE t.kind = 'income' AND t.id <= $2), 0)::text AS income_settled,
              coalesce(sum(-e.amount) FILTER (WHERE t.kind = 'adjustment'), 0)::text AS adjust,
              coalesce(sum(-e.amount) FILTER (WHERE t.kind = 'adjustment' AND t.id <= $2), 0)::text AS adjust_settled
         FROM ledger_transactions t
         LEFT JOIN ledger_entries e ON e.tx_id = t.id AND t.kind = 'adjustment' AND e.account_id = $3
        WHERE t.id > $1 AND t.kind IN ('income', 'adjustment')`,
      [lastTx.toString(), newLastTx.toString(), (sys.get('TESOURO') ?? 0n).toString()],
    );
    const t = totals.rows[0]!;
    const incomeBase = full ? 0n : BigInt(cp!.income_total);
    const adjustBase = full ? 0n : BigInt(cp!.adjust_total);
    const fixed = await c.query<{ players: string; subsidies: string; signup_bad: number }>(
      `SELECT (SELECT count(*) FROM accounts WHERE kind = 'player')::text AS players,
              (SELECT coalesce(sum(subsidy - subsidy_repaid), 0) FROM starter_claims)::text AS subsidies,
              (SELECT count(*)::int FROM users u
                WHERE NOT EXISTS (SELECT 1 FROM ledger_transactions g WHERE g.user_id = u.id AND g.kind = 'signup_grant'))
                AS signup_bad`,
    );
    const f = fixed.rows[0]!;
    const expected =
      BigInt(f.players) * ECONOMY.signupGrant +
      BigInt(f.subsidies) +
      incomeBase +
      BigInt(t.income) +
      adjustBase +
      BigInt(t.adjust);

    const listingBad = await c.query<{ id: string }>(
      `SELECT l.id FROM listings l JOIN properties p ON p.lot_id = l.lot_id
        WHERE l.status = 'active' AND p.owner_id IS DISTINCT FROM l.seller_id LIMIT 20`,
    );
    const residenceBad = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users u
        WHERE u.residence_lot_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM properties p WHERE p.lot_id = u.residence_lot_id AND p.owner_id = u.id)`,
    );
    // posse (completa): a última transação de posse de cada lote explica o dono atual
    let ownershipBad: string[] = [];
    if (full) {
      const own = await c.query<{ lot_id: string }>(
        `SELECT p.lot_id FROM properties p
           LEFT JOIN LATERAL (
             SELECT t.kind, t.user_id FROM ledger_transactions t
              WHERE t.lot_id = p.lot_id AND t.kind IN ('starter_home', 'city_purchase', 'market_sale', 'city_sale')
              ORDER BY t.id DESC LIMIT 1) last ON true
          WHERE (p.owner_id IS NOT NULL AND (last.kind IS NULL OR last.kind = 'city_sale' OR last.user_id <> p.owner_id))
             OR (p.owner_id IS NULL AND last.kind IS NOT NULL AND last.kind <> 'city_sale')
          LIMIT 20`,
      );
      ownershipBad = own.rows.map((r) => r.lot_id);
    }

    // alertas de taxa (não travam a economia, mas ficam no log e na auditoria)
    const alerts: string[] = [];
    const hourly = await c.query<{ v: string }>(
      `SELECT coalesce(-sum(amount), 0)::text AS v FROM ledger_entries WHERE account_id = $1 AND created_at > $2`,
      [(sys.get('TESOURO') ?? 0n).toString(), new Date(now.getTime() - 3_600_000)],
    );
    if (BigInt(hourly.rows[0]!.v) > ECONOMY.alerts.maxEmissionPerHour) alerts.push(`emissão na última hora: ${hourly.rows[0]!.v}`);
    if (sysBal('GOVERNO') < ECONOMY.alerts.minGovernmentBalance) alerts.push(`saldo do GOVERNO: ${sysBal('GOVERNO')}`);

    const report: InvariantReport = {
      ok: false,
      mode: full ? 'full' : 'incremental',
      unbalancedTx: unbalanced.rows.map((r) => r.id.toString()),
      balanceMismatch: mismatch,
      negativePlayers: negative,
      unauthorizedDebits: unauthorized.rows.map((r) => r.id.toString()),
      signupMismatch: f.signup_bad,
      ownershipMismatch: ownershipBad,
      listingMismatch: listingBad.rows.map((r) => r.id),
      residenceMismatch: residenceBad.rows[0]!.n,
      moneySupply: supply.toString(),
      emission: emission.toString(),
      expectedEmission: expected.toString(),
      alerts,
    };
    report.ok =
      report.unbalancedTx.length === 0 &&
      report.balanceMismatch.length === 0 &&
      report.negativePlayers === 0 &&
      report.unauthorizedDebits.length === 0 &&
      report.signupMismatch === 0 &&
      report.ownershipMismatch.length === 0 &&
      report.listingMismatch.length === 0 &&
      report.residenceMismatch === 0 &&
      supply === emission &&
      emission === expected;

    // só avança o ponto de verificação se tudo bateu
    if (report.ok) {
      await c.query(
        `INSERT INTO ledger_checkpoint (id, last_entry_id, last_tx_id, income_total, adjust_total, full_checked_at, updated_at)
         VALUES (1, $1, $2, $3, $4, $5, now())
         ON CONFLICT (id) DO UPDATE SET last_entry_id = $1, last_tx_id = $2, income_total = $3, adjust_total = $4,
           full_checked_at = coalesce($5, ledger_checkpoint.full_checked_at), updated_at = now()`,
        [
          newLastEntry.toString(),
          newLastTx.toString(),
          (incomeBase + BigInt(t.income_settled)).toString(),
          (adjustBase + BigInt(t.adjust_settled)).toString(),
          full ? now : null,
        ],
      );
      const ids = [...nextBase.keys()];
      if (ids.length) {
        await c.query(
          `INSERT INTO ledger_checkpoint_balances (account_id, balance)
           SELECT * FROM unnest($1::bigint[], $2::numeric[])
           ON CONFLICT (account_id) DO UPDATE SET balance = EXCLUDED.balance`,
          [ids, ids.map((k) => nextBase.get(k)!.toString())],
        );
      }
    }
    await c.query('COMMIT');
    return report;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    c.release(broken);
  }
}

/**
 * Trava/destrava a economia. Travar usa a função do banco (o papel app só
 * consegue travar); destravar exige o papel dono (UPDATE direto).
 */
export async function setEconomyLock(pool: pg.Pool, locked: boolean, reason: string): Promise<void> {
  if (locked) {
    await pool.query('SELECT economy_lock($1)', [reason]);
    return;
  }
  await pool.query(`UPDATE system_flags SET value = $1, updated_at = now() WHERE key = 'economy_lock'`, [
    JSON.stringify({ locked: false, reason, at: new Date().toISOString() }),
  ]);
}

export async function isEconomyLocked(pool: pg.Pool): Promise<boolean> {
  const { rows } = await pool.query<{ locked: boolean }>(
    `SELECT coalesce((value->>'locked')::boolean, false) AS locked FROM system_flags WHERE key = 'economy_lock'`,
  );
  return rows[0]?.locked ?? false;
}

type JobLog = { error: (o: object, m: string) => void; info: (o: object, m: string) => void; warn?: (o: object, m: string) => void };

/** Roda a verificação e trava a economia se algo divergir. */
export async function runInvariantJob(pool: pg.Pool, log: JobLog, opts: { full?: boolean } = {}): Promise<InvariantReport> {
  const report = await checkInvariants(pool, opts);
  if (report.alerts.length) {
    (log.warn ?? log.error)({ alerts: report.alerts }, 'ALARME: taxa da economia fora do esperado');
    await audit(pool, 'economy_alert', null, null, { alerts: report.alerts });
  }
  if (!report.ok) {
    log.error({ report }, 'ALARME: invariante contábil violado — economia travada');
    if (!(await isEconomyLocked(pool))) {
      await setEconomyLock(pool, true, 'invariante contábil violado');
      await audit(pool, 'invariant_violation', null, null, { ...report });
    }
  }
  return report;
}
