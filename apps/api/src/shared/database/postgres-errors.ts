/** SQLSTATE de Postgres para una violación de unicidad (PK o UNIQUE). */
export const UNIQUE_VIOLATION = '23505';

/** Hasta dónde se sigue la cadena de `cause`: un error de driver no anida más que esto. */
const MAX_CAUSE_DEPTH = 5;

/**
 * `pg` adjunta el SQLSTATE de Postgres como `.code` en el error que tira, pero
 * `drizzle-orm` (0.45) envuelve ese error en un `DrizzleQueryError` y lo deja en
 * `.cause`: el `.code` de afuera es `undefined`. Verificado contra Postgres real
 * (`tx.execute` dentro de `withTenantTransaction`: `code=undefined`,
 * `cause.code='23505'`). Por eso se sigue la cadena de `cause` y no solo el
 * primer nivel. Nunca se tipa (viene de `DatabaseError` sin exportar), así que
 * se chequea a mano en vez de con `instanceof`.
 */
export function hasPostgresErrorCode(error: unknown, code: string): boolean {
  return findPostgresError(error)?.code === code;
}

/**
 * El nombre de la constraint violada (`.constraint` del error de `pg`), para
 * distinguir qué unicidad falló cuando una tabla tiene más de una.
 */
export function postgresErrorConstraint(error: unknown): string | undefined {
  const found = findPostgresError(error);
  return typeof found?.constraint === 'string' ? found.constraint : undefined;
}

function findPostgresError(error: unknown): { code: string; constraint?: unknown } | undefined {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== 'object' || current === null) return undefined;
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') {
      return { code: candidate.code, constraint: candidate.constraint };
    }
    current = candidate.cause;
  }
  return undefined;
}
