/**
 * Erros de domínio → resposta `{ error: { code, message } }` sem stack trace.
 */
import type { FastifyError, FastifyInstance } from 'fastify';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const badRequest = (message = 'Requisição inválida.', code = 'BAD_REQUEST') =>
  new AppError(400, code, message);
export const unauthorized = (message = 'Faça login para continuar.') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Operação não permitida.', code = 'FORBIDDEN') => new AppError(403, code, message);
export const notFound = (message = 'Não encontrado.') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const tooMany = (retryAfterSec: number, message = 'Muitas requisições. Tente novamente em instantes.') =>
  new AppError(429, 'RATE_LIMITED', message, { 'retry-after': String(Math.max(1, Math.ceil(retryAfterSec))) });

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/** Instala tratadores de erro e 404 padronizados. */
export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError | Error, req, reply) => {
    if (err instanceof AppError) {
      for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
      return reply.status(err.status).send(errorBody(err.code, err.message));
    }
    const fe = err as FastifyError;
    // erros do próprio Fastify (corpo grande, JSON malformado, content-type...)
    if (typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) {
      const map: Record<number, [string, string]> = {
        400: ['BAD_REQUEST', 'Requisição inválida.'],
        404: ['NOT_FOUND', 'Não encontrado.'],
        413: ['PAYLOAD_TOO_LARGE', 'Corpo da requisição grande demais.'],
        415: ['UNSUPPORTED_MEDIA_TYPE', 'Envie o corpo como application/json.'],
      };
      const [code, message] = map[fe.statusCode] ?? ['BAD_REQUEST', 'Requisição inválida.'];
      return reply.status(fe.statusCode).send(errorBody(code, message));
    }
    req.log.error({ err }, 'erro interno');
    return reply.status(500).send(errorBody('INTERNAL', 'Erro interno. Tente novamente.'));
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send(errorBody('NOT_FOUND', 'Rota não encontrada.')));
}
