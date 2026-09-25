import type { Tx } from '@orq/db';
import { sql } from 'drizzle-orm';

export interface PriorMutation {
  entityId: string | null;
  result: 'applied' | 'rejected' | 'duplicate';
  rejectionReason: string | null;
}

export interface RecordMutationParams {
  clientMutationId: string;
  organizationId: string;
  memberId: string;
  kind: string;
  entityId: string | null;
  result: 'applied' | 'rejected' | 'duplicate';
  rejectionReason?: string;
}

/**
 * ADR-007: todo endpoint de escritura pasa por estas dos funciones, dentro
 * de la misma transacción que hace la mutación real. `findPriorMutation`
 * primero; si devuelve algo, el handler reconstruye la respuesta anterior
 * en vez de repetir el efecto. Si no, aplica la mutación y llama a
 * `recordMutation` antes de que la transacción haga commit.
 */
export async function findPriorMutation(
  tx: Tx,
  clientMutationId: string,
): Promise<PriorMutation | null> {
  const result = await tx.execute<{
    entity_id: string | null;
    result: 'applied' | 'rejected' | 'duplicate';
    rejection_reason: string | null;
  }>(sql`
    select entity_id, result, rejection_reason from mutation_log
    where client_mutation_id = ${clientMutationId}
  `);
  const row = result.rows[0];
  if (!row) return null;
  return { entityId: row.entity_id, result: row.result, rejectionReason: row.rejection_reason };
}

export async function recordMutation(tx: Tx, params: RecordMutationParams): Promise<void> {
  await tx.execute(sql`
    insert into mutation_log
      (client_mutation_id, organization_id, member_id, kind, entity_id, result, rejection_reason)
    values (
      ${params.clientMutationId}, ${params.organizationId}, ${params.memberId}, ${params.kind},
      ${params.entityId}, ${params.result}, ${params.rejectionReason ?? null}
    )
  `);
}
