import type { Tx } from '@orq/db';
import { sql } from 'drizzle-orm';

/**
 * ADR-017: hay UNA sola implementación del cálculo de acceso, la de la base
 * (`app_has_full_project_access`), y el código no la reescribe en TypeScript.
 * La función lee `app.current_org` y `app.current_member` de la transacción,
 * así que responde por quien abrió `tx`, nunca por un id que se le pase.
 */
export async function hasFullProjectAccess(
  tx: Tx,
  params: { projectId: string },
): Promise<boolean> {
  const result = await tx.execute<{ ok: boolean }>(
    sql`select app_has_full_project_access(${params.projectId}) as ok`,
  );
  return result.rows[0]?.ok === true;
}

/**
 * ¿Es miembro explícito (no borrado) del proyecto? Para decidir si se le puede
 * asignar una tarea aunque no tenga acceso al sitio (ADR-017 §8). Lee
 * `project_member` con la identidad de quien llama: si esa persona no ve la
 * lista de miembros, la respuesta es `false`, que es el lado seguro.
 */
export async function isExplicitProjectMember(
  tx: Tx,
  params: { organizationId: string; projectId: string; memberId: string },
): Promise<boolean> {
  const result = await tx.execute<{ member_id: string }>(sql`
    select member_id from project_member
    where organization_id = ${params.organizationId}
      and project_id = ${params.projectId}
      and member_id = ${params.memberId}
      and deleted_at is null
  `);
  return result.rows.length > 0;
}
