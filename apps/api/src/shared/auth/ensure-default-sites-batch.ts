import { newId } from '@orq/contracts';
import type { Db } from '@orq/db';
import { withSystemTransaction, withTenantTransaction } from '@orq/db';
import { sql } from 'drizzle-orm';
import { ensureDefaultSite } from './ensure-default-site.js';

export interface EnsureDefaultSitesBatchResult {
  organizationsReviewed: number;
  sitesCreated: number;
  projectsBackfilled: number;
  failed: ReadonlyArray<{ organizationId: string; error: unknown }>;
}

/**
 * ADR-013 (`docs/adr/013-project-site-id-obligatorio.md`). Dos trabajos,
 * ambos idempotentes — seguro de correr más de una vez, incluso repetido
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
 *    correr antes de que la migración
 *    `0010_project_site_id_not_null_validate.sql` llegue a un ambiente con
 *    proyectos reales: sin este backfill, el `VALIDATE CONSTRAINT` de esa
 *    migración falla apenas encuentra la primera fila vieja con `site_id`
 *    null.
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

      await withTenantTransaction(
        db,
        { organizationId, memberId, requestId: newId() },
        async (tx) => {
          const before = await tx.execute<{ id: string }>(sql`
            select id from site where organization_id = ${organizationId} limit 1
          `);
          await ensureDefaultSite(tx, { organizationId });
          if (!before.rows[0]) sitesCreated += 1;

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
          projectsBackfilled += backfilled.rows.length;
        },
      );
    } catch (error) {
      failed.push({ organizationId, error });
    }
  }

  return {
    organizationsReviewed: organizations.rows.length,
    sitesCreated,
    projectsBackfilled,
    failed,
  };
}
