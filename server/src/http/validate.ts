/**
 * Validação estrita de entrada (zod). Campos extras, tipos errados e
 * dinheiro fracionário são rejeitados com 400.
 */
import { z } from 'zod';
import { AppError } from './errors.js';

export const LOT_ID_RE = /^ITB-[A-Z0-9-]{1,40}$/;
export const lotIdSchema = z.string().max(44).regex(LOT_ID_RE);
export const uuidSchema = z.uuid();
/** Cursor numérico (id de lançamento/anúncio), opaco para o cliente. */
export const cursorSchema = z.string().regex(/^[0-9]{1,18}$/);

/** Valor em centavos: inteiro positivo; aceita number inteiro ou string de dígitos. */
export const centsSchema = (max: bigint) =>
  z
    .union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9][0-9]{0,17}$/)])
    .transform((v) => BigInt(v))
    .refine((v) => v > 0n && v <= max, { message: 'valor fora do limite' });

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first && first.path.length ? ` (${first.path.join('.')})` : '';
    throw new AppError(400, 'VALIDATION', `Dados inválidos${where}.`);
  }
  return r.data;
}

/** Rotas sem corpo: aceitam ausência de corpo ou `{}` vazio. */
export const emptyBody = z.union([z.undefined(), z.null(), z.strictObject({})]);
