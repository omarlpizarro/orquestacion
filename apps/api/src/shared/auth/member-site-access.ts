import type { Tx } from '@orq/db';
import { sql } from 'drizzle-orm';
import { hasImplicitAllSitesAccess, type OrgRole, parseSingleOrgRole } from './org-role.js';

export interface InsertMemberSiteAccessParams {
  organizationId: string;
  memberId: string;
  siteId: string;
}

/**
 * Idempotente: otorgar un acceso que el miembro ya tiene no es un error ni
 * cambia nada. Es el único lugar que escribe en `member_site_access`, para
 * los dos caminos que lo hacen: el endpoint de otorgar acceso
 * (`modules/tenancy`) y el otorgamiento automático de
 * `grantAccessToSingleSite` (hook de Better Auth, que no puede importar
 * `modules/*` — mismo motivo por el que `ensure-default-site.ts` vive acá).
 */
export async function insertMemberSiteAccess(
  tx: Tx,
  params: InsertMemberSiteAccessParams,
): Promise<void> {
  await tx.execute(sql`
    insert into member_site_access (organization_id, member_id, site_id)
    values (${params.organizationId}, ${params.memberId}, ${params.siteId})
    on conflict (member_id, site_id) do nothing
  `);
}

export interface GrantAccessToSingleSiteParams {
  organizationId: string;
  memberId: string;
  /** El rol tal como lo guarda Better Auth (`auth.member.role`). */
  role: string;
}

/**
 * ADR-016: si la organización tiene exactamente un sitio, un miembro nuevo
 * de nivel 2 o 3 recibe acceso a él automáticamente. Con un solo sitio no hay
 * nada que elegir, y dejar al miembro sin acceso solo lo deja inútil hasta que
 * alguien pase a otorgárselo. Con más de un sitio no se adivina: alguien con
 * autoridad decide (`grant-site-access`).
 *
 * `owner` y `director` no reciben fila: ya trabajan en todos los sitios
 * (`hasImplicitAllSitesAccess`). Un rol desconocido, o varios roles
 * distintos, tampoco recibe nada acá: `parseSingleOrgRole` falla fuerte donde
 * se decide una autorización, no en un hook que corre después de que el
 * miembro ya existe.
 *
 * Idempotente y seguro de repetir, igual que `ensureDefaultSite` (ADR-013): el
 * hook no puede evitar que el miembro exista si esto falla, así que la
 * reparación es volver a correrlo.
 */
export async function grantAccessToSingleSite(
  tx: Tx,
  params: GrantAccessToSingleSiteParams,
): Promise<void> {
  let role: OrgRole;
  try {
    role = parseSingleOrgRole(params.role);
  } catch {
    return;
  }
  if (hasImplicitAllSitesAccess(role)) return;

  const sites = await tx.execute<{ id: string }>(sql`
    select id from site where organization_id = ${params.organizationId} limit 2
  `);
  const [onlySite, another] = sites.rows;
  if (!onlySite || another) return;

  await insertMemberSiteAccess(tx, {
    organizationId: params.organizationId,
    memberId: params.memberId,
    siteId: onlySite.id,
  });
}
