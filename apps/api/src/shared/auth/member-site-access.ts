import { Logger } from '@nestjs/common';
import type { Tx } from '@orq/db';
import { sql } from 'drizzle-orm';
import { hasImplicitAllSitesAccess, type OrgRole, parseSingleOrgRole } from './org-role.js';

const logger = new Logger('member-site-access');

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
 * de `grantAccessToSingleSite` (hook de Better Auth, que no puede importar
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
  /** El rol tal como lo guarda Better Auth (`auth.member.role`). */
  role: string;
}

/**
 * ADR-016: si la organización tiene exactamente un sitio, un miembro de nivel
 * 2 o 3 tiene acceso a él. Con un solo sitio no hay nada que elegir, y dejar al
 * miembro sin acceso solo lo deja inútil hasta que alguien pase a otorgárselo.
 * Con más de un sitio no se adivina: alguien con autoridad decide
 * (`grant-site-access`).
 *
 * `owner` y `director` no reciben fila acá: ya trabajan en todos los sitios
 * (`hasImplicitAllSitesAccess`). Un rol desconocido, o varios roles
 * distintos, tampoco recibe nada: `parseSingleOrgRole` falla fuerte donde se
 * decide una autorización, no en un hook que corre después de que el miembro
 * ya existe. Pero eso no puede pasar en silencio: se loguea el error, y el
 * miembro queda sin acceso hasta que alguien lo resuelva.
 *
 * Idempotente y seguro de repetir, igual que `ensureDefaultSite` (ADR-013):
 * lo usan el hook de Better Auth (que no puede evitar que el miembro exista
 * si esto falla) y el script `ensure-default-sites` (backfill y reparación).
 * Devuelve si esta llamada otorgó un acceso nuevo.
 */
export async function grantAccessToSingleSite(
  tx: Tx,
  params: GrantAccessToSingleSiteParams,
): Promise<boolean> {
  let role: OrgRole;
  try {
    role = parseSingleOrgRole(params.role);
  } catch (error) {
    logger.error(
      `No se pudo interpretar el rol "${params.role}" del miembro ${params.memberId} ` +
        `(organización ${params.organizationId}): no se le otorga acceso automático.`,
      error instanceof Error ? error.stack : String(error),
    );
    return false;
  }
  if (hasImplicitAllSitesAccess(role)) return false;

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
