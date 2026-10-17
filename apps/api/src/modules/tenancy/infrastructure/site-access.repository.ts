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

/**
 * Hasta dos sitios activos: alcanza para distinguir "ninguno", "uno solo" y "más
 * de uno" sin traer todos. `site` no tiene `deleted_at`; un sitio desactivado
 * (`is_active = false`) no se elige por defecto.
 */
export async function findActiveSiteIds(
  tx: Tx,
  params: { organizationId: string },
): Promise<string[]> {
  const result = await tx.execute<{ id: string }>(sql`
    select id from site
    where organization_id = ${params.organizationId} and is_active
    order by id
    limit 2
  `);
  return result.rows.map((row) => row.id);
}

/**
 * Los `manager` con acceso a un sitio. El rol se compara por su valor completo: un miembro con
 * varios roles queda afuera, el mismo lado seguro que `app_is_privileged()` (menos acceso, y
 * acá menos avisos). `auth.member` no tiene RLS (ADR-011): el `organization_id` de este `WHERE`
 * es lo único que impide reconocer a un miembro de otro tenant.
 */
export async function findSiteManagerMemberIds(
  tx: Tx,
  params: { organizationId: string; siteId: string },
): Promise<string[]> {
  const result = await tx.execute<{ member_id: string }>(sql`
    select a.member_id
      from member_site_access a
      join auth.member m on m.id = a.member_id and m.organization_id = a.organization_id
     where a.organization_id = ${params.organizationId}
       and a.site_id = ${params.siteId}
       and m.role = 'manager'
     order by a.member_id
  `);
  return result.rows.map((row) => row.member_id);
}

/**
 * De estos ids, los que siguen siendo miembros de la organización. Mismo aviso que arriba sobre
 * `auth.member` y el `WHERE` por organización.
 */
export async function findOrganizationMemberIds(
  tx: Tx,
  params: { organizationId: string; memberIds: string[] },
): Promise<string[]> {
  if (params.memberIds.length === 0) return [];
  // `sql.param(array)`: drizzle expande un arreglo común en `(a, b, c)`, no en un parámetro.
  const result = await tx.execute<{ id: string }>(sql`
    select id from auth.member
     where organization_id = ${params.organizationId}
       and id = any(${sql.param(params.memberIds)}::text[])
     order by id
  `);
  return result.rows.map((row) => row.id);
}
