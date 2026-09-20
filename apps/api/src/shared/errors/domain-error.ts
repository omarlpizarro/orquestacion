/**
 * CLAUDE.md §8: un tipo de error de dominio por caso, con un `code` estable
 * y un `message` en español. `domain/` tira subclases de esta clase, nunca
 * `HttpException` ni `ORPCError` directamente — eso lo traduce el borde
 * (controller u oRPC handler).
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  constructor(
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}
