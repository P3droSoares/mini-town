/**
 * Boot do server: valida ambiente, (opcionalmente) aplica migrações e
 * sincroniza o catálogo com o papel dono, e sobe a API só com o papel app.
 *
 * MIGRATION_DATABASE_URL fica só no one-shot `npm run migrate` (serviço
 * `migrate` do compose); o server só confere a versão do esquema. Se vier no
 * ambiente (compatibilidade de dev; produção recusa no loadConfig), é usada
 * no boot e apagada de process.env — o que NÃO a tira de /proc/<pid>/environ
 * nem do ambiente do container: não entregue a credencial do dono à API.
 */
import { buildApp } from './app.js';
import { loadConfig, type AppConfig } from './config.js';
import { assertPeppersAvailable, assertSchemaCurrent, prepareDatabase, waitForDb } from './db/bootstrap.js';
import { createPool } from './db/pool.js';
import { loadSystemAccounts } from './economy/ledger.js';
import { startJobs } from './jobs.js';
import { AUTH_MIN_RESPONSE_MS, DEFAULT_POLICY } from './security/policy.js';
import { DEFAULT_LIMITS, RateLimiter } from './security/rateLimit.js';

async function main(): Promise<void> {
  let cfg: AppConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  // credencial do dono (DDL) não fica no ambiente do processo da API
  delete process.env.MIGRATION_DATABASE_URL;
  const ownerUrl = cfg.migrationDatabaseUrl;
  cfg.migrationDatabaseUrl = null;
  if (ownerUrl) await prepareDatabase(ownerUrl, cfg, (m) => console.log(m));

  let logPoolError = (err: Error) => console.error('erro no pool do Postgres:', err.message);
  const pool = createPool(cfg.databaseUrl, cfg, { max: 20, onError: (err) => logPoolError(err) });
  await waitForDb(pool, (m) => console.log(m));
  await assertSchemaCurrent(pool);
  await assertPeppersAvailable(pool, cfg);
  const sys = await loadSystemAccounts(pool);
  const limiter = new RateLimiter();
  const app = await buildApp(
    {
      cfg,
      pool,
      sys,
      limiter,
      limits: DEFAULT_LIMITS,
      policy: DEFAULT_POLICY,
      authMinResponseMs: AUTH_MIN_RESPONSE_MS,
      clock: () => new Date(),
    },
    {
      level: cfg.logLevel,
      // sem IP, cookies ou query string nos logs
      serializers: {
        req: (r) => ({ id: r.id, method: r.method, url: String(r.url).split('?')[0] }),
        res: (r) => ({ statusCode: r.statusCode }),
      },
    },
  );
  logPoolError = (err) => app.log.error({ err }, 'erro no pool do Postgres');
  const jobs = startJobs(pool, app.log, () => new Date(), cfg);

  let closing = false;
  const shutdown = async (sig: string, code = 0) => {
    if (closing) return;
    closing = true;
    app.log.info(`recebido ${sig}, encerrando`);
    // encerramento preso não pode travar o processo (tsx watch espera a saída)
    setTimeout(() => {
      app.log.error('encerramento demorou demais; saindo à força');
      process.exit(1);
    }, 10_000).unref();
    try {
      await app.close();
      await jobs.stop();
      limiter.close();
      await pool.end();
    } catch (err) {
      app.log.error({ err }, 'falha no encerramento');
      code = 1;
    }
    process.exit(code);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => {
    app.log.fatal({ err }, 'promessa rejeitada sem tratamento');
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'exceção não tratada');
    void shutdown('uncaughtException', 1);
  });

  await app.listen({ host: cfg.host, port: cfg.port });
}

main().catch((err) => {
  console.error('falha no boot:', err instanceof Error ? err.message : err);
  process.exit(1);
});
