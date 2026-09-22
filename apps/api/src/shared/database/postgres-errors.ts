/** SQLSTATE de Postgres para una violación de unicidad (PK o UNIQUE). */
export const UNIQUE_VIOLATION = '23505';

/**
 * `pg` adjunta el SQLSTATE de Postgres como `.code` en el error que tira.
 * Nunca lo tipa (viene de `DatabaseError` sin exportar), así que se chequea
 * a mano en vez de con `instanceof`.
 */
export function hasPostgresErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code
  );
}
