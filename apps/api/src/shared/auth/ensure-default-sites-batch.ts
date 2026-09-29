import { newId } from '@orq/contracts';
import type { Db } from '@orq/db';
import { withSystemTransaction, withTenantTransaction } from '@orq/db';
import { sql } from 'drizzle-orm';
import { ensureDefaultSite } from './ensure-default-site.js';
import { grantAccessToSingleSite } from './member-site-access.js';

export interface EnsureDefaultSitesBatchResult {
  organizationsReviewed: number;
  sitesCreated: number;
  projectsBackfilled: number;
  memberAccessGranted: number;
  failed: ReadonlyArray<{ organizationId: string; error: unknown }>;
}

/**
 * ADR-013 (`docs/adr/013-project-site-id-obligatorio.md`) y ADR-016. Tres
 * trabajos, todos idempotentes — seguro de correr más de una vez, incluso repetido
 * sobre la misma organización:
 *
 * 1. Crea el sitio por defecto de toda organización que todavía no tenga
 *    ninguno. Cubre tanto el backfill histórico (organizaciones creadas
 *    antes de que existiera el hook `afterCreateOrganization`) como la
 *    reparación de una organización cuyo hook falló al crearse — el hook
 *    no puede evitar que la organización se cree si el INSERT del sitio
 *    falla (ver `organization-hooks.ts`), así que esto es la forma de
 *    detectarlo y arreglarlo: cada organización que esta función encuentra
 *    sin sitio y corrige queda contada en el resultado, sea la primera
 *    corrida (todo el historial) o una corrida posterior (solo las que
 *    fallaron desde la última vez).
 * 2. Completa `site_id` en cualquier `project` que todavía lo tenga null,
 *    apuntándolo al sitio más antiguo de su organización (`order by id`:
 *    UUIDv7 ordena cronológicamente por construcción, no hace falta una
 *    columna `created_at` — que `site` no tiene, ver el ADR). Tiene que
 *    correr antes de la migración que hace `VALIDATE CONSTRAINT` +
 *    `SET NOT NULL` sobre `project.site_id` (`0009_project_site_id_check_not_valid.sql`
 *    agrega el `CHECK ... NOT VALID`; el `VALIDATE` va en un PR aparte, ver
 *    ese archivo) llegue a un ambiente con proyectos reales: sin este
 *    backfill, el `VALIDATE CONSTRAINT` falla apenas encuentra la primera
 *    fila vieja con `site_id` null.
 *
 *    **Sin uso a partir de `0010_project_site_id_not_null_validate.sql`:**
 *    desde esa migración `project.site_id` es `NOT NULL`, así que la base
 *    no admite filas con `site_id` null y este `UPDATE` nunca vuelve a
 *    encontrar nada (`projectsBackfilled` queda siempre en 0). Se deja el
 *    código en vez de borrarlo: el paso 1 sigue siendo útil por sí solo y
 *    quitar esta parte no cambia ningún comportamiento. Tampoco tiene test
 *    dedicado, ni lo va a tener: la precondición no se puede construir.
 * 3. En una organización con exactamente un sitio, da acceso a ese sitio a
 *    todo miembro que todavía no lo tenga, sin excepción por rol (ADR-016).
 *    Es la misma operación que los hooks de Better Auth hacen al crear la
 *    organización y al sumar un miembro (`grantAccessToSingleSite`, una sola
 *    implementación), así que sirve de las dos cosas: backfill de los miembros
 *    que ya existían cuando se introdujo el alcance por sitio, y reparación de
 *    un miembro cuyo otorgamiento automático falló (el hook no puede evitar que
 *    el miembro exista si falla). Con más de un sitio no adivina: eso lo decide
 *    quien otorga.
 *
 * Asegura entonces dos invariantes: toda organización tiene su sitio, y en las
 * de un solo sitio todo miembro tiene acceso a él.
 *
 * Corre con las credenciales de `app_login`, igual que la aplicación —
 * nunca con las de `app_owner` (regla dura 4): esto no es una migración de
 * esquema, son INSERT/UPDATE comunes sobre tablas con RLS forzada, así que
 * respeta la política de tenant como cualquier otro escritor. Una
 * transacción de tenant por organización (mismo patrón que los workers de
 * pg-boss, CLAUDE.md §7): `site`/`project` tienen RLS forzada, así que sin
 * `app.current_org` seteado ni sus filas son visibles. `app.current_member`
 * se resuelve al miembro más antiguo de cada organización — no queda
 * escrito en ninguna columna (`site` no tiene `created_by_member_id`
 * todavía), es solo el contexto que la regla dura 3 exige siempre, con o
 * sin RLS de por medio en la tabla puntual.
 *
 * No lanza si una organización individual falla: sigue con el resto y la
 * deja en `failed`. Un fallo de una organización no debería impedir que se
 * repare el resto.
 */
export async function ensureDefaultSitesForAllOrganizations(
  db: Db,
): Promise<EnsureDefaultSitesBatchResult> {
  let sitesCreated = 0;
  let projectsBackfilled = 0;
  let memberAccessGranted = 0;
  const failed: Array<{ organizationId: string; error: unknown }> = [];

  const organizations = await withSystemTransaction(db, { requestId: newId() }, (tx) =>
    tx.execute<{ id: string }>(sql`select id from auth.organization order by created_at asc`),
  );

  for (const { id: organizationId } of organizations.rows) {
    try {
      const owner = await withSystemTransaction(db, { requestId: newId() }, (tx) =>
        tx.execute<{ id: string }>(sql`
          select id from auth.member
          where organization_id = ${organizationId}
          order by created_at asc
          limit 1
        `),
      );
      const memberId = owner.rows[0]?.id;
      if (!memberId) {
        failed.push({
          organizationId,
          error: new Error('La organización no tiene ningún member.'),
        });
        continue;
      }

      // Los contadores se suman recién cuando la transacción de esta
      // organización confirmó: si algo falla más adelante y hace rollback, no
      // hay que contar como hecho lo que se deshizo.
      const done = await withTenantTransaction(
        db,
        { organizationId, memberId, requestId: newId() },
        async (tx) => {
          const before = await tx.execute<{ id: string }>(sql`
            select id from site where organization_id = ${organizationId} limit 1
          `);
          await ensureDefaultSite(tx, { organizationId });

          // Sin uso desde 0010 (`site_id` NOT NULL): no puede haber filas que
          // coincidan. Ver el comentario del punto 2 arriba.
          const backfilled = await tx.execute<{ id: string }>(sql`
            update project
            set site_id = (
              select id from site
              where site.organization_id = project.organization_id
              order by id asc
              limit 1
            )
            where organization_id = ${organizationId} and site_id is null
            returning id
          `);

          // Después de asegurar el sitio: `grantAccessToSingleSite` cuenta los
          // sitios de la organización, y el recién creado tiene que estar.
          // `auth.member` no tiene RLS (ADR-011): el filtro por organización
          // es lo único que acota esta lectura.
          const members = await tx.execute<{ id: string }>(sql`
            select id from auth.member where organization_id = ${organizationId}
          `);
          let accessGranted = 0;
          for (const member of members.rows) {
            const granted = await grantAccessToSingleSite(tx, {
              organizationId,
              memberId: member.id,
            });
            if (granted) accessGranted += 1;
          }

          return {
            siteCreated: !before.rows[0],
            projectsBackfilled: backfilled.rows.length,
            accessGranted,
          };
        },
      );
      if (done.siteCreated) sitesCreated += 1;
      projectsBackfilled += done.projectsBackfilled;
      memberAccessGranted += done.accessGranted;
    } catch (error) {
      failed.push({ organizationId, error });
    }
  }

  return {
    organizationsReviewed: organizations.rows.length,
    sitesCreated,
    projectsBackfilled,
    memberAccessGranted,
    failed,
  };
}
