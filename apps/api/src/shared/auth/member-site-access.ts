import type { Tx } from '@orq/db';
import { sql } from 'drizzle-orm';

export interface InsertMemberSiteAccessParams {
  organizationId: string;
  memberId: string;
  siteId: string;
}

/**
 * Idempotente: otorgar un acceso que el miembro ya tiene no es un error ni
 * cambia nada. Devuelve si esta llamada insertó la fila (`false` si ya
 * existía), para quien necesite contar accesos nuevos. Es el único lugar que
 * escribe en `member_site_access`, para los tres caminos que lo hacen: el
 * endpoint de otorgar acceso (`modules/tenancy`), el otorgamiento automático
 * de `grantAccessToSingleSite` (hooks de Better Auth, que no pueden importar
 * `modules/*` — mismo motivo por el que `ensure-default-site.ts` vive acá) y
 * el script operativo `ensure-default-sites`, que usa esa misma función.
 */
export async function insertMemberSiteAccess(
  tx: Tx,
  params: InsertMemberSiteAccessParams,
): Promise<boolean> {
  const result = await tx.execute<{ member_id: string }>(sql`
    insert into member_site_access (organization_id, member_id, site_id)
    values (${params.organizationId}, ${params.memberId}, ${params.siteId})
    on conflict (member_id, site_id) do nothing
    returning member_id
  `);
  return result.rows.length > 0;
}

export interface GrantAccessToSingleSiteParams {
  organizationId: string;
  memberId: string;
}

/**
 * ADR-016: si la organización tiene exactamente un sitio, todo miembro tiene
 * una fila para él, **sin excepción por rol**. Con un solo sitio no hay nada
 * que elegir, y dejar a alguien sin acceso solo lo deja inútil hasta que
 * alguien pase a otorgárselo. Con más de un sitio no se adivina: alguien con
 * autoridad decide (`grant-site-access`).
 *
 * `owner` y `director` ya trabajan en todos los sitios sin necesitar la fila,
 * pero la reciben igual: como `member_site_access` no tiene rol (ADR-015), la
 * fila sobrevive a un cambio de rol, y un `director` que pasa a `manager`
 * conserva su acceso sin que nadie intervenga. Por eso esta función no mira el
 * rol de nadie: no hay nada que interpretar, y un rol corrupto no puede dejar a
 * un miembro sin acceso.
 *
 * Idempotente y seguro de repetir, igual que `ensureDefaultSite` (ADR-013):
 * lo usan los hooks de Better Auth (que no pueden evitar que el miembro exista
 * si esto falla) y el script `ensure-default-sites` (backfill y reparación).
 * Devuelve si esta llamada otorgó un acceso nuevo.
 */
export async function grantAccessToSingleSite(
  tx: Tx,
  params: GrantAccessToSingleSiteParams,
): Promise<boolean> {
  const sites = await tx.execute<{ id: string }>(sql`
    select id from site where organization_id = ${params.organizationId} limit 2
  `);
  const [onlySite, another] = sites.rows;
  if (!onlySite || another) return false;

  return insertMemberSiteAccess(tx, {
    organizationId: params.organizationId,
    memberId: params.memberId,
    siteId: onlySite.id,
  });
}
