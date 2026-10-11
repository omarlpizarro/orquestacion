import type { Logger } from '@nestjs/common';
import { domainErrorData } from '@orq/contracts';
import type { z } from 'zod';
import { DomainError } from './domain-error.js';

type DomainErrorResponder = (options: {
  message: string;
  data: z.infer<typeof domainErrorData>;
}) => Error;

/**
 * Traduce un `DomainError` al error tipado del contrato de oRPC (CLAUDE.md §8):
 * `DomainError.code` es la clave del mapa de errores del contrato y `data` ya
 * tiene la forma de `domainErrorData`. Cualquier otro error se relanza tal cual.
 *
 * Si un `DomainError` usa un `code` que el contrato no declaró es un descuido
 * nuestro, no del cliente: se loguea y sale como 422 en vez de que oRPC intente
 * llamar a `undefined` y explote como un 500 opaco.
 */
export function rethrowDomainError(
  error: unknown,
  errors: { UNPROCESSABLE_CONTENT: DomainErrorResponder } & object,
  logger: Logger,
  slice: string,
): never {
  if (!(error instanceof DomainError)) throw error;

  const respond = (errors as Record<string, DomainErrorResponder | undefined>)[error.code];
  if (!respond) {
    logger.error(
      `DomainError con code "${error.code}" no está declarado en el contrato de ${slice}.`,
    );
    throw errors.UNPROCESSABLE_CONTENT({
      message: error.message,
      data: { domain_code: 'unmapped_domain_error' },
    });
  }
  throw respond({ message: error.message, data: domainErrorData.parse(error.data) });
}
