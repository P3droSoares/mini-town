/**
 * Sessões no servidor: token aleatório no cookie, só o SHA-256 no banco.
 * Inatividade de 30 min, absoluto de 7 dias, revogação individual ou total.
 */
import type pg from 'pg';
import { newSessionToken, sha256, SESSION_TOKEN_RE } from '../security/crypto.js';
import { SESSION } from '../security/policy.js';

export interface SessionUser {
  id: string;
  displayName: string;
  createdAt: Date;
}

export interface AuthInfo {
  sessionId: string;
  user: SessionUser;
}

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export async function createSession(
  db: Queryable,
  userId: string,
  ipHmac: Buffer | null,
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const { token, hash } = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION.absoluteMs);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, ip_hmac, expires_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, hash, ipHmac, expiresAt],
  );
  return { token, sessionId: rows[0]!.id, expiresAt };
}

/** Resolve o cookie numa sessão válida (e renova a atividade). */
export async function loadSession(db: Queryable, token: string | undefined): Promise<AuthInfo | null> {
  if (!token || !SESSION_TOKEN_RE.test(token)) return null;
  const { rows } = await db.query<{
    id: string;
    user_id: string;
    display_name: string;
    created_at: Date;
    last_seen_at: Date;
  }>(
    `SELECT s.id, s.user_id, s.last_seen_at, u.display_name, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(secs => $2)`,
    [sha256(token), SESSION.idleMs / 1000],
  );
  const r = rows[0];
  if (!r) return null;
  if (Date.now() - r.last_seen_at.getTime() > SESSION.touchEveryMs) {
    await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [r.id]);
  }
  return { sessionId: r.id, user: { id: r.user_id, displayName: r.display_name, createdAt: r.created_at } };
}

export async function revokeSessionByToken(db: Queryable, token: string | undefined): Promise<void> {
  if (!token || !SESSION_TOKEN_RE.test(token)) return;
  await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
    sha256(token),
  ]);
}

export async function revokeSession(db: Queryable, sessionId: string): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

/** Revoga todas as sessões do usuário (exceto, opcionalmente, a atual). */
export async function revokeAllSessions(db: Queryable, userId: string, exceptSessionId?: string): Promise<void> {
  await db.query(
    `UPDATE sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [userId, exceptSessionId ?? null],
  );
}

export const userView = (u: SessionUser) => ({
  id: u.id,
  displayName: u.displayName,
  createdAt: u.createdAt.toISOString(),
});

/** Registra a rede usada pela conta (contas ligadas no mercado, origem conhecida no login). */
export async function recordUserIp(db: Queryable, userId: string, ipHmac: Buffer, netHmac: Buffer): Promise<void> {
  await db.query(
    `INSERT INTO user_ips (user_id, ip_hmac, net_hmac) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, ip_hmac) DO UPDATE SET last_seen_at = now()`,
    [userId, ipHmac, netHmac],
  );
}
