import type { Tx } from '@orq/db';
import { sql } from 'drizzle-orm';

export async function findSiteForTenant(
  tx: Tx,
  params: { organizationId: string; siteId: string },
): Promise<{ id: string } | null> {
  const result = await tx.execute<{ id: string }>(sql`
    select id from site
    where id = ${params.siteId} and organization_id = ${params.organizationId}
  `);
  return result.rows[0] ?? null;
}

/**
 * `auth.member` no tiene RLS (ADR-011: es de Better Auth, en su propio
 * esquema): nada en la base filtra por organización acá. El `organization_id`
 * de este `WHERE` es lo único que impide reconocer como propio a un miembro de
 * otro tenant — no se puede sacar.
 */
export async function findMemberForTenant(
  tx: Tx,
  params: { organizationId: string; memberId: string },
): Promise<{ id: string; role: string } | null> {
  const result = await tx.execute<{ id: string; role: string }>(sql`
    select id, role from auth.member
    where id = ${params.memberId} and organization_id = ${params.organizationId}
  `);
  return result.rows[0] ?? null;
}

export async function hasMemberSiteAccessRow(
  tx: Tx,
  params: { organizationId: string; memberId: string; siteId: string },
): Promise<boolean> {
  const result = await tx.execute<{ member_id: string }>(sql`
    select member_id from member_site_access
    where organization_id = ${params.organizationId}
      and member_id = ${params.memberId}
      and site_id = ${params.siteId}
  `);
  return result.rows.length > 0;
}
