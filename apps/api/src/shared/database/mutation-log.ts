import type { Tx } from '@orq/db';
import { sql } from 'drizzle-orm';
import { MutationIdReusedError } from '../errors/mutation-id-reused.error.js';

export interface PriorMutation {
  kind: string;
  entityId: string | null;
  result: 'applied' | 'rejected' | 'duplicate';
  rejectionReason: string | null;
}

export interface ClaimMutationParams {
  clientMutationId: string;
  organizationId: string;
  memberId: string;
  kind: string;
  /** El id de lo que la mutación crea o toca: lo conoce el pedido, no hace falta esperar a aplicarla. */
  entityId: string | null;
}

export type ClaimMutationResult =
  | { claimed: true }
  /** Otro pedido con el mismo `client_mutation_id` ya confirmó: hay que reconstruir su respuesta. */
  | { claimed: false; prior: PriorMutation };

/**
 * ADR-007, patrón "se reserva la mutación antes de leer": tiene que ser la
 * **primera sentencia** de la transacción de todo endpoint de escritura.
 *
 * `INSERT ... ON CONFLICT (client_mutation_id) DO NOTHING`: si otro pedido con el
 * mismo id está en vuelo, Postgres hace esperar a este hasta que aquel confirme
 * o haga rollback.
 * - Si el otro confirmó, este no inserta nada (`claimed: false`): la mutación ya
 *   se aplicó y la respuesta se reconstruye de lo registrado, sin error ni
 *   reintento.
 * - Si el otro hizo rollback (una regla de dominio lo rechazó), este inserta y
 *   sigue como si fuera el primero.
 * - Si la transacción de este pedido falla después, el rollback se lleva la
 *   reserva: un reintento con el mismo id empieza de cero.
 *
 * Reservar **antes** de leer el estado es lo que cierra la carrera. Con el orden
 * viejo (leer, aplicar, registrar al final) el pedido duplicado leía el estado
 * ya cambiado por el primero y respondía un error de dominio (409 de versión, o
 * 422 por una transición que ya no existe) en vez de la respuesta del primero.
 *
 * `mutation_log` tiene RLS por organización. Si el id ya lo usó otra
 * organización la fila existe pero no se ve: no hay nada que reconstruir y se
 * rechaza (`MutationIdReusedError`) sin decir de quién era.
 *
 * Lo registrado tiene que ser **la misma operación** que la de este pedido: mismo
 * `kind` y mismo `entity_id`. Un id reusado para otra cosa (crear la tarea A y
 * después cambiar el estado de la tarea B con el mismo id) no es un reintento, y
 * devolver la respuesta de A como si fuera la de B es peor que rechazarlo. Es una
 * mitigación parcial de CLAUDE.md §13 #6: un reintento con el mismo `kind` y la
 * misma entidad pero datos distintos (otro `to_status` sobre la misma tarea)
 * sigue devolviendo el resultado anterior en silencio.
 */
export async function claimMutation(
  tx: Tx,
  params: ClaimMutationParams,
): Promise<ClaimMutationResult> {
  const inserted = await tx.execute(sql`
    insert into mutation_log
      (client_mutation_id, organization_id, member_id, kind, entity_id, result)
    values (
      ${params.clientMutationId}, ${params.organizationId}, ${params.memberId}, ${params.kind},
      ${params.entityId}, 'applied'
    )
    on conflict (client_mutation_id) do nothing
    returning client_mutation_id
  `);
  if (inserted.rows.length > 0) return { claimed: true };

  const prior = await findPriorMutation(tx, params.clientMutationId);
  if (!prior || !isSameOperation(prior, params)) throw new MutationIdReusedError();
  return { claimed: false, prior };
}

/**
 * Los ids se comparan en minúsculas: `entity_id` es una columna `uuid` (Postgres
 * lo devuelve en minúsculas) y el cliente puede haber mandado el id en mayúsculas.
 */
function isSameOperation(
  prior: PriorMutation,
  params: Pick<ClaimMutationParams, 'kind' | 'entityId'>,
): boolean {
  return (
    prior.kind === params.kind &&
    (prior.entityId?.toLowerCase() ?? null) === (params.entityId?.toLowerCase() ?? null)
  );
}

export async function findPriorMutation(
  tx: Tx,
  clientMutationId: string,
): Promise<PriorMutation | null> {
  const result = await tx.execute<{
    kind: string;
    entity_id: string | null;
    result: 'applied' | 'rejected' | 'duplicate';
    rejection_reason: string | null;
  }>(sql`
    select kind, entity_id, result, rejection_reason from mutation_log
    where client_mutation_id = ${clientMutationId}
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    kind: row.kind,
    entityId: row.entity_id,
    result: row.result,
    rejectionReason: row.rejection_reason,
  };
}
