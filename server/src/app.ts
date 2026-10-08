/**
 * Montagem do Fastify: parser JSON estrito, cabeçalhos de segurança, limite
 * de taxa, sessão, Origin + CSRF e as rotas da API.
 */
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import sjson from 'secure-json-parse';
import { loadSession } from './auth/session.js';
import type { AppContext } from './context.js';
import { AppError, forbidden, installErrorHandling, tooMany, unauthorized } from './http/errors.js';
import { authRoutes } from './routes/auth.js';
import { marketRoutes } from './routes/market.js';
import { meRoutes } from './routes/me.js';
import { propertyRoutes } from './routes/properties.js';
import { publicRoutes } from './routes/public.js';
import { csrfMatches, ipHmac, netHmac } from './security/crypto.js';
import { proxyTrust } from './security/proxy.js';
import { SESSION_COOKIE } from './security/policy.js';

export const BODY_LIMIT = 16 * 1024;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function securityHeaders(appOrigin: string): Record<string, string> {
  const h: Record<string, string> = {
    // a API só devolve JSON: nada pode ser carregado/embutido a partir dela
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'x-frame-options': 'DENY',
    'cache-control': 'no-store',
  };
  if (appOrigin.startsWith('https://')) h['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

export async function buildApp(
  ctx: AppContext,
  logger: FastifyServerOptions['logger'] = false,
): Promise<FastifyInstance> {
  const { cfg, pool, limiter, limits } = ctx;
  const app = Fastify({
    logger,
    // X-Forwarded-For só de um par da lista (Caddy) e até N saltos; conexão direta = IP do socket
    trustProxy: proxyTrust(cfg.trustProxyHops, cfg.trustedProxies),
    bodyLimit: BODY_LIMIT,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    requestIdHeader: false,
    return503OnClosing: true,
    routerOptions: { maxParamLength: 64 },
  });

  installErrorHandling(app);
  await app.register(cookie);

  // só JSON; text/plain (requisição "simples" sem preflight) fica de fora. Corpo vazio = undefined.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: BODY_LIMIT }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, sjson.parse(text, undefined, { protoAction: 'error', constructorAction: 'error' }));
    } catch {
      done(new AppError(400, 'BAD_JSON', 'JSON inválido.'), undefined);
    }
  });

  app.decorateRequest('auth', null);
  app.decorateRequest('ipHmac', null as unknown as Buffer);
  app.decorateRequest('netHmac', null as unknown as Buffer);

  // fail-closed: toda rota de /api declara a política de acesso; esquecer = não sobe
  app.addHook('onRoute', (r) => {
    const cfgAuth = (r.config as { auth?: unknown } | undefined)?.auth;
    if (r.url.startsWith('/api') && cfgAuth !== 'none' && cfgAuth !== 'required') {
      throw new Error(`rota ${r.method} ${r.url} sem config.auth ('none' | 'required')`);
    }
  });

  const headers = securityHeaders(cfg.appOrigin);
  app.addHook('onSend', async (_req, reply) => {
    reply.headers(headers);
  });

  app.addHook('onRequest', async (req) => {
    const ipKey = ipHmac(cfg.sessionKey, req.ip);
    req.ipHmac = ipKey;
    req.netHmac = netHmac(cfg.sessionKey, req.ip);
    const ipTag = ipKey.toString('base64url');
    const rc = req.routeOptions.config;

    let wait = limiter.take(`ip:${ipTag}`, limits.ip);
    if (wait) throw tooMany(wait);
    if (rc.limit === 'auth') wait = limiter.take(`auth:${ipTag}`, limits.authIp);
    // cadastro por rede: um /64 de IPv6 inteiro conta como um cliente
    else if (rc.limit === 'register') wait = limiter.take(`reg:${req.netHmac.toString('base64url')}`, limits.registerIp);
    else if (rc.limit === 'public') wait = limiter.take(`pub:${ipTag}`, limits.publicIp);
    else if (rc.limit === 'economy') wait = limiter.take(`eco:${ipTag}`, limits.economyIp);
    if (wait) throw tooMany(wait);

    const unsafe = !SAFE_METHODS.has(req.method);
    // toda escrita exige Origin igual ao do app (bloqueia CSRF entre sites)
    if (unsafe && req.headers.origin !== cfg.appOrigin) {
      throw forbidden('Origem da requisição não permitida.', 'BAD_ORIGIN');
    }

    req.auth = await loadSession(pool, req.cookies[SESSION_COOKIE]);
    // padrão é exigir sessão (rota fora de /api, ex.: 404, cai aqui sem config)
    if (rc.auth !== 'none' && !req.auth) {
      if (req.routeOptions.url !== undefined) throw unauthorized();
    }

    // CSRF: com sessão, toda escrita leva o token da sessão (login/registro não têm sessão ainda)
    if (unsafe && req.auth && rc.csrf !== false) {
      const presented = req.headers['x-csrf-token'];
      if (typeof presented !== 'string' || !csrfMatches(cfg.csrfKey, req.auth.sessionId, presented)) {
        throw forbidden('Token CSRF inválido.', 'BAD_CSRF');
      }
    }

    if (req.auth) {
      wait = limiter.take(`user:${req.auth.user.id}`, limits.user);
      if (!wait && rc.limit === 'economy') wait = limiter.take(`ecou:${req.auth.user.id}`, limits.economyUser);
      if (wait) throw tooMany(wait);
    }
  });

  await app.register(
    async (api) => {
      await publicRoutes(api, ctx);
      await authRoutes(api, ctx);
      await meRoutes(api, ctx);
      await propertyRoutes(api, ctx);
      await marketRoutes(api, ctx);
    },
    { prefix: '/api' },
  );

  return app;
}
