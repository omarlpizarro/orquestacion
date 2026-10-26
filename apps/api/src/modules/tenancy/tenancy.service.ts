import { Injectable } from '@nestjs/common';
import type { Tx } from '@orq/db';
import { sql } from 'drizzle-orm';
import {
  type EnsureDefaultSiteParams,
  ensureDefaultSite,
} from '../../shared/auth/ensure-default-site.js';
import {
  hasImplicitAllSitesAccess,
  type OrgRole,
  parseSingleOrgRole,
} from '../../shared/auth/org-role.js';
import {
  findActiveSiteIds,
  findMemberForTenant,
  findMemberNames,
  findOrganizationMemberIds,
  findSiteForTenant,
  findSiteManagerMemberIds,
  hasMemberSiteAccessRow,
} from './infrastructure/site-access.repository.js';

export interface ResolveTimezoneParams {
  organizationId: string;
  siteId: string | null;
}

export interface CanAccessSiteParams {
  organizationId: string;
  memberId: string;
  role: OrgRole;
  siteId: string;
}

export type SoleSiteResolution =
  | { kind: 'single'; siteId: string }
  | { kind: 'multiple' }
  | { kind: 'none' };

export interface IsMemberAssignableParams {
  organizationId: string;
  memberId: string;
  siteId: string;
}

/**
 * Único punto por el que otro módulo llega a `site`/`organization_profile`
 * (CLAUDE.md §5): `projects` necesita la zona horaria del sitio de una
 * tarea para convertir fechas planificadas a UTC (ADR-008), pero no puede
 * tocar el esquema de `tenancy` directamente. SQL crudo, no el query
 * builder de Drizzle: ningún módulo importa `packages/db/src/schema/` de
 * otro módulo (regla dura 5), y las tablas de Drizzle son la fuente para
 * generar migraciones, no para armar consultas cruzando módulos.
 */
@Injectable()
export class TenancyService {
  async resolveTimezone(tx: Tx, params: ResolveTimezoneParams): Promise<string> {
    if (params.siteId) {
      const result = await tx.execute<{ timezone: string }>(sql`
        select timezone from site
        where id = ${params.siteId} and organization_id = ${params.organizationId}
      `);
      if (result.rows[0]) return result.rows[0].timezone;
    }

    const result = await tx.execute<{ timezone: string }>(sql`
      select timezone from organization_profile where organization_id = ${params.organizationId}
    `);
    // `organization_profile.timezone` tiene default de columna: si la fila
    // existe (siempre debería, se crea junto con la organización), esto no
    // es null. Si no existe la fila, es un dato de setup faltante, no un
    // caso de negocio a modelar acá.
    if (!result.rows[0]) {
      throw new Error(
        `organization_profile inexistente para organización ${params.organizationId}`,
      );
    }
    return result.rows[0].timezone;
  }

  /**
   * ¿Puede un miembro con este rol trabajar en este sitio? `owner` y
   * `director` sí, en todos, sin necesitar fila (`hasImplicitAllSitesAccess`);
   * `manager` y `operator` solo donde tienen una fila en `member_site_access`
   * (ADR-015: la tabla no tiene rol, el rol viene siempre de afuera). Único
   * lugar que combina las dos cosas: nadie fuera de `tenancy` mira esa tabla
   * (regla dura 5), y quien mirara solo la tabla le negaría el acceso a un
   * `owner`.
   */
  async canAccessSite(tx: Tx, params: CanAccessSiteParams): Promise<boolean> {
    if (hasImplicitAllSitesAccess(params.role)) return true;
    return hasMemberSiteAccessRow(tx, params);
  }

  /**
   * ¿Se le puede asignar una tarea de este sitio a este miembro? Que exista
   * en la organización y que pueda trabajar en el sitio, con **su** rol —
   * leído de `auth.member`, no del de quien asigna. `false` tanto si no es de
   * la organización como si no tiene acceso: quien llama no necesita
   * distinguirlos, y distinguirlos le diría a quien asigna si un id ajeno
   * corresponde a un miembro de otra organización.
   */
  async isMemberAssignable(tx: Tx, params: IsMemberAssignableParams): Promise<boolean> {
    const member = await findMemberForTenant(tx, params);
    if (!member) return false;
    return this.canAccessSite(tx, { ...params, role: parseSingleOrgRole(member.role) });
  }

  /**
   * ¿Existe en la organización? Para decidir si un miembro explícito de un
   * proyecto es asignable aunque no tenga acceso al sitio (ADR-017 §8): el
   * hecho de figurar en `project_member` no prueba que siga siendo de la
   * organización (no hay FK hacia `auth.member`, ADR-010).
   */
  async isMemberInOrganization(
    tx: Tx,
    params: { organizationId: string; memberId: string },
  ): Promise<boolean> {
    return (await findMemberForTenant(tx, params)) !== null;
  }

  /**
   * Los `manager` con acceso a un sitio (ADR-019: a quién avisar de un bloqueo en un proyecto de
   * sitio). Solo `manager`: `owner` y `director` trabajan en todos los sitios sin fila, y no por
   * eso son audiencia.
   */
  listSiteManagerMemberIds(
    tx: Tx,
    params: { organizationId: string; siteId: string },
  ): Promise<string[]> {
    return findSiteManagerMemberIds(tx, params);
  }

  /**
   * De estos ids, los que siguen siendo miembros de la organización: el hecho de figurar en
   * `project_member` no prueba que lo sean (no hay FK hacia `auth.member`, ADR-010).
   */
  filterOrganizationMemberIds(
    tx: Tx,
    params: { organizationId: string; memberIds: string[] },
  ): Promise<string[]> {
    return findOrganizationMemberIds(tx, params);
  }

  /**
   * Los nombres de estos miembros, solo de los que son de la organización (ADR-019 y brief: los
   * clientes resuelven nombres en lote, una consulta por pantalla). Sin repetir y en el orden en que
   * se pidieron; los ids que faltan no vuelven.
   */
  async listMemberNames(
    tx: Tx,
    params: { organizationId: string; memberIds: readonly string[] },
  ): Promise<Array<{ id: string; name: string }>> {
    const requested = [...new Set(params.memberIds)];
    const found = new Map(
      (
        await findMemberNames(tx, { organizationId: params.organizationId, memberIds: requested })
      ).map((member) => [member.id, member.name] as const),
    );
    return requested.flatMap((id) => {
      const name = found.get(id);
      return name === undefined ? [] : [{ id, name }];
    });
  }

  /** ¿Existe este sitio en la organización? Para validar un `site_id` que llega en un pedido. */
  async siteExists(tx: Tx, params: { organizationId: string; siteId: string }): Promise<boolean> {
    return (await findSiteForTenant(tx, params)) !== null;
  }

  /**
   * El sitio por defecto de una organización con un solo sitio activo (los
   * formularios no preguntan lo que el sistema ya sabe). Si no tiene ninguno
   * —el hook `afterCreateOrganization` pudo fallar después de que Better Auth
   * confirmó la organización, ADR-013— lo repara con `ensureDefaultSite`, que
   * es idempotente, en vez de dejar al usuario trabado. Con más de uno no
   * elige: lo tiene que decidir quien llama.
   */
  async resolveSoleSite(tx: Tx, params: { organizationId: string }): Promise<SoleSiteResolution> {
    let siteIds = await findActiveSiteIds(tx, params);
    if (siteIds.length === 0) {
      await ensureDefaultSite(tx, params);
      siteIds = await findActiveSiteIds(tx, params);
    }
    const [only, other] = siteIds;
    if (only && !other) return { kind: 'single', siteId: only };
    if (only && other) return { kind: 'multiple' };
    // `ensureDefaultSite` no crea nada si la organización ya tiene un sitio,
    // aunque esté desactivado: ahí no hay ninguno activo que usar por defecto.
    return { kind: 'none' };
  }

  /**
   * Envoltorio delgado sobre `shared/auth/ensure-default-site.ts` (ADR-013)
   * para quien lo necesite vía DI de Nest — mismo patrón que
   * `resolveTimezone`. La lógica real vive en `shared/` porque el llamador
   * principal (el hook `afterCreateOrganization` de Better Auth) no puede
   * importar `modules/*`.
   */
  ensureDefaultSite(tx: Tx, params: EnsureDefaultSiteParams): Promise<void> {
    return ensureDefaultSite(tx, params);
  }
}
