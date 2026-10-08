/**
 * Rotas de autenticação: registro, login, logout, "sair de todos", sessão
 * atual e troca de senha. Mensagens genéricas, tempo de resposta mínimo.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { attemptSucceeded, beginAttempt, type AttemptKey } from '../auth/bruteForce.js';
import {
  createSession,
  recordUserIp,
  revokeAllSessions,
  revokeSession,
  revokeSessionByToken,
  userView,
} from '../auth/session.js';
import type { AppContext } from '../context.js';
import { withTx } from '../db/pool.js';
import { ECONOMY } from '../economy/config.js';
import { lockAccounts, post } from '../economy/ledger.js';
import { AppError, badRequest, tooMany } from '../http/errors.js';
import { emptyBody, parse } from '../http/validate.js';
import {
  csrfTokenFor,
  decryptEmail,
  deviceIdFor,
  emailHash,
  encryptEmail,
  newDeviceToken,
  sha256,
} from '../security/crypto.js';
import { displayNameKey, normalizeDisplayName } from '../security/displayName.js';
import {
  burnPasswordTime,
  hashPassword,
  needsRehash,
  PASSWORD_MAX,
  passwordProblem,
  verifyPassword,
} from '../security/password.js';
import { BRUTE_FORCE, DEVICE_COOKIE, DEVICE_MAX_AGE_SEC, SESSION, SESSION_COOKIE } from '../security/policy.js';

// NFKC + só alfabeto latino/dígitos (sem homóglifos de outros alfabetos)
const displayNameSchema = z
  .string()
  .max(64)
  .transform((s, ctx) => {
    const n = normalizeDisplayName(s);
    if (!n) {
      ctx.addIssue({ code: 'custom', message: 'nome inválido' });
      return z.NEVER;
    }
    return n;
  });
const emailSchema = z.email().max(254);
// limite folgado no schema; a regra de tamanho real (10–128) dá mensagem própria
const passwordSchema = z.string().min(1).max(PASSWORD_MAX * 4);

const RegisterBody = z.strictObject({ displayName: displayNameSchema, email: emailSchema, password: passwordSchema });
const LoginBody = z.strictObject({ email: z.string().max(254), password: passwordSchema });
const PasswordBody = z.strictObject({ currentPassword: passwordSchema, newPassword: passwordSchema });

const INVALID_CREDENTIALS = () => new AppError(401, 'INVALID_CREDENTIALS', 'Usuário ou senha inválidos.');
const LOCKED = (sec: number) => tooMany(sec, 'Muitas tentativas. Aguarde um pouco e tente novamente.');

/** IP de login com sucesso recente desta conta? (origem conhecida) */
async function knownIp(pool: pg.Pool, accountKey: Buffer, ipHmac: Buffer): Promise<boolean> {
  const { rows } = await pool.query<{ known: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM user_ips ui JOIN users u ON u.id = ui.user_id
        WHERE u.email_hash = $1 AND ui.ip_hmac = $2 AND ui.last_seen_at > now() - make_interval(days => $3)
     ) AS known`,
    [accountKey, ipHmac, BRUTE_FORCE.knownIpDays],
  );
  return rows[0]?.known ?? false;
}

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { cfg, pool, policy } = ctx;

  const setSessionCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: Math.floor(SESSION.absoluteMs / 1000),
    });
  const clearSessionCookie = (reply: FastifyReply) =>
    reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure: true, sameSite: 'strict' });
  /** marca o navegador como dispositivo conhecido da conta (se ainda não for) */
  const setDeviceCookie = (req: FastifyRequest, reply: FastifyReply, accountKey: Buffer) => {
    if (deviceIdFor(cfg.sessionKey, accountKey, req.cookies[DEVICE_COOKIE])) return;
    reply.setCookie(DEVICE_COOKIE, newDeviceToken(cfg.sessionKey, accountKey), {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: DEVICE_MAX_AGE_SEC,
    });
  };

  /** Garante duração mínima (mascara diferenças de caminho/tempo). */
  const padTo = async (started: number) => {
    const left = ctx.authMinResponseMs - (Date.now() - started);
    if (left > 0) await sleep(left);
  };

  // ---------------------------------------------------------------- registro
  app.post('/auth/register', { config: { auth: 'none', limit: 'register', csrf: false } }, async (req, reply) => {
    const started = Date.now();
    try {
      const body = parse(RegisterBody, req.body);
      const problem = passwordProblem(body.password, [body.displayName, body.email.split('@')[0] ?? '']);
      if (problem) throw badRequest(problem, 'WEAK_PASSWORD');
      const pwHash = await hashPassword(body.password, cfg);
      const eHash = emailHash(cfg.emailHashKey, body.email);
      const eEnc = encryptEmail(cfg.emailEncKey, cfg.emailKeyVersion, body.email);

      const out = await withTx(pool, async (c) => {
        // limite persistente de contas por rede (sobrevive a reinício), atômico por rede
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 13))', [req.netHmac.toString('hex')]);
        const lim = await c.query<{ net: number; global: number }>(
          `SELECT (SELECT count(*)::int FROM users WHERE signup_net_hmac = $1 AND created_at > now() - interval '24 hours') AS net,
                  (SELECT count(*)::int FROM users WHERE created_at > now() - interval '1 hour') AS global`,
          [req.netHmac],
        );
        if (lim.rows[0]!.net >= policy.signupPerNetPerDay) {
          throw tooMany(3600, 'Limite de contas novas desta rede atingido. Tente novamente amanhã.');
        }
        if (lim.rows[0]!.global >= policy.signupGlobalPerHour) {
          throw new AppError(503, 'REGISTRATION_PAUSED', 'Cadastros temporariamente pausados. Tente mais tarde.', {
            'retry-after': '600',
          });
        }
        const u = await c.query<{ id: string; display_name: string; created_at: Date }>(
          `INSERT INTO users (display_name, display_name_key, email_hash, email_enc, email_key_version, password_hash, signup_net_hmac)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, display_name, created_at`,
          [body.displayName, displayNameKey(body.displayName), eHash, eEnc, cfg.emailKeyVersion, pwHash, req.netHmac],
        );
        const user = u.rows[0]!;
        const a = await c.query<{ id: bigint }>(`INSERT INTO accounts (kind, user_id) VALUES ('player', $1) RETURNING id`, [
          user.id,
        ]);
        const accountId = a.rows[0]!.id;
        await lockAccounts(c, [accountId]);
        await post(c, {
          kind: 'signup_grant',
          userId: user.id,
          lotId: null,
          amount: ECONOMY.signupGrant,
          entries: [
            { account: ctx.sys.TESOURO, amount: -ECONOMY.signupGrant },
            { account: accountId, amount: ECONOMY.signupGrant },
          ],
        });
        // sessão anterior deste navegador (outra conta) morre, como no login
        await revokeSessionByToken(c, req.cookies[SESSION_COOKIE]);
        const s = await createSession(c, user.id, req.ipHmac);
        await recordUserIp(c, user.id, req.ipHmac, req.netHmac);
        await audit(c, 'register', user.id, req.ipHmac);
        return { user: { id: user.id, displayName: user.display_name, createdAt: user.created_at }, session: s };
      }).catch((err: { code?: string; constraint?: string }) => {
        if (err.code === '23505' && (err.constraint === 'users_display_name_lower' || err.constraint === 'users_display_name_key')) {
          throw new AppError(409, 'DISPLAY_NAME_TAKEN', 'Esse nome de exibição já está em uso (ou é parecido demais com outro).');
        }
        if (err.code === '23505' && err.constraint === 'users_email_hash_key') {
          // genérico: não confirma que o e-mail existe
          throw new AppError(409, 'REGISTRATION_FAILED', 'Não foi possível criar a conta com esses dados.');
        }
        throw err;
      });
      setSessionCookie(reply, out.session.token);
      setDeviceCookie(req, reply, eHash);
      // devolve o valor (sem send) para o envio acontecer depois do tempo mínimo
      reply.status(201);
      return { user: userView(out.user), csrfToken: csrfTokenFor(cfg.csrfKey, out.session.sessionId) };
    } finally {
      await padTo(started);
    }
  });

  // ---------------------------------------------------------------- login
  app.post('/auth/login', { config: { auth: 'none', limit: 'auth', csrf: false } }, async (req, reply) => {
    const started = Date.now();
    try {
      const body = parse(LoginBody, req.body);
      const accountKey = emailHash(cfg.emailHashKey, body.email);
      // origem conhecida (cookie de dispositivo ou IP de login anterior): contador próprio,
      // fora do alcance de quem só sabe o e-mail; origem desconhecida: contador da conta
      const deviceId = deviceIdFor(cfg.sessionKey, accountKey, req.cookies[DEVICE_COOKIE]);
      let trusted: Buffer | null = null;
      if (deviceId) trusted = sha256(`dev:${accountKey.toString('hex')}:${deviceId}`);
      else if (await knownIp(pool, accountKey, req.ipHmac)) {
        trusted = sha256(`ip:${accountKey.toString('hex')}:${req.ipHmac.toString('hex')}`);
      }
      const keys: AttemptKey[] = [
        { scope: 'ip', key: req.ipHmac },
        trusted ? { scope: 'device', key: trusted } : { scope: 'account', key: accountKey },
      ];
      // tentativa contada antes da verificação (atômico: rajadas paralelas não furam o limite)
      const remaining = await beginAttempt(pool, keys);
      if (remaining > 0) {
        await audit(pool, 'login_locked', null, req.ipHmac, { trusted: trusted !== null });
        throw LOCKED(remaining);
      }
      const { rows } = await pool.query<{ id: string; display_name: string; created_at: Date; password_hash: string }>(
        'SELECT id, display_name, created_at, password_hash FROM users WHERE email_hash = $1',
        [accountKey],
      );
      const user = rows[0];
      let ok = false;
      if (user) ok = await verifyPassword(user.password_hash, body.password, cfg);
      else await burnPasswordTime(body.password, cfg);
      if (!ok || !user) {
        await audit(pool, 'login_failed', user?.id ?? null, req.ipHmac);
        throw INVALID_CREDENTIALS();
      }
      await attemptSucceeded(pool, keys);
      // pepper novo/antigo ou formato sem versão: regrava com o pepper atual
      if (needsRehash(user.password_hash, cfg)) {
        await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1 AND password_hash = $3', [
          user.id,
          await hashPassword(body.password, cfg),
          user.password_hash,
        ]);
      }
      // rotação: a sessão anterior deste navegador morre
      await revokeSessionByToken(pool, req.cookies[SESSION_COOKIE]);
      const s = await createSession(pool, user.id, req.ipHmac);
      await recordUserIp(pool, user.id, req.ipHmac, req.netHmac);
      await audit(pool, 'login', user.id, req.ipHmac);
      setSessionCookie(reply, s.token);
      setDeviceCookie(req, reply, accountKey);
      return {
        user: userView({ id: user.id, displayName: user.display_name, createdAt: user.created_at }),
        csrfToken: csrfTokenFor(cfg.csrfKey, s.sessionId),
      };
    } finally {
      await padTo(started);
    }
  });

  // ---------------------------------------------------------------- logout
  app.post('/auth/logout', { config: { auth: 'none', limit: 'auth' } }, async (req, reply) => {
    parse(emptyBody, req.body);
    if (req.auth) {
      await revokeSession(pool, req.auth.sessionId);
      await audit(pool, 'logout', req.auth.user.id, req.ipHmac);
    }
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  app.post('/auth/logout-all', { config: { auth: 'required', limit: 'auth' } }, async (req, reply) => {
    parse(emptyBody, req.body);
    const auth = req.auth!;
    await revokeAllSessions(pool, auth.user.id);
    await audit(pool, 'logout_all', auth.user.id, req.ipHmac);
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- sessão atual
  app.get('/auth/me', { config: { auth: 'required' } }, async (req) => {
    const auth = req.auth!;
    const { rows } = await pool.query<{ email_enc: Buffer }>('SELECT email_enc FROM users WHERE id = $1', [auth.user.id]);
    let email: string | null = null;
    try {
      // todas as versões de chave conhecidas (a recifragem para a atual roda no job)
      email = rows[0] ? decryptEmail(cfg.emailEncKeys, rows[0].email_enc) : null;
    } catch {
      email = null;
    }
    return { user: userView(auth.user), csrfToken: csrfTokenFor(cfg.csrfKey, auth.sessionId), email };
  });

  // ---------------------------------------------------------------- troca de senha
  app.post('/auth/password', { config: { auth: 'required', limit: 'auth' } }, async (req, reply) => {
    const auth = req.auth!;
    const body = parse(PasswordBody, req.body);
    const { rows } = await pool.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [
      auth.user.id,
    ]);
    const row = rows[0]!;
    // contador próprio (sessão já autenticada): errar aqui não bloqueia o login da conta
    const keys: AttemptKey[] = [
      { scope: 'ip', key: req.ipHmac },
      { scope: 'device', key: sha256(`pw:${auth.user.id}`) },
    ];
    const remaining = await beginAttempt(pool, keys);
    if (remaining > 0) throw LOCKED(remaining);
    if (!(await verifyPassword(row.password_hash, body.currentPassword, cfg))) {
      await audit(pool, 'password_change_failed', auth.user.id, req.ipHmac);
      throw new AppError(403, 'INVALID_CREDENTIALS', 'Senha atual incorreta.');
    }
    await attemptSucceeded(pool, keys);
    const problem = passwordProblem(body.newPassword, [auth.user.displayName]);
    if (problem) throw badRequest(problem, 'WEAK_PASSWORD');
    if (body.newPassword === body.currentPassword) throw badRequest('A nova senha precisa ser diferente da atual.', 'SAME_PASSWORD');
    const pwHash = await hashPassword(body.newPassword, cfg);
    const s = await withTx(pool, async (c) => {
      await c.query('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [auth.user.id, pwHash]);
      // todas as sessões morrem, inclusive a atual (cookie possivelmente vazado): sessão nova
      await revokeAllSessions(c, auth.user.id);
      const fresh = await createSession(c, auth.user.id, req.ipHmac);
      await audit(c, 'password_changed', auth.user.id, req.ipHmac);
      return fresh;
    });
    // novo cookie; o cliente renova o CSRF em GET /api/auth/me
    setSessionCookie(reply, s.token);
    return reply.status(204).send();
  });
}
