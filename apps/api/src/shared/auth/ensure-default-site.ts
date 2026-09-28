import { newId } from '@orq/contracts';
import type { Tx } from '@orq/db';
import { sql } from 'drizzle-orm';

export interface EnsureDefaultSiteParams {
  organizationId: string;
}

/**
 * ADR-013 (`docs/adr/013-project-site-id-obligatorio.md`): toda
 * organización tiene al menos un `site`. Idempotente — no hace nada si la
 * organización ya tiene alguno, sea el que creó una llamada anterior o uno
 * que ya existía por otra vía — así que es seguro llamarla más de una vez
 * para la misma organización.
 *
 * Dos llamadores, ninguno pasa por Nest: vive en `shared/auth`, no en
 * `modules/tenancy`, porque el llamador principal es el hook
 * `afterCreateOrganization` de Better Auth (`organization-hooks.ts`, mismo
 * directorio) — infraestructura de auth, no puede importar `modules/*`
 * (esa dirección no existe en ningún otro lugar de `shared/`, y agregarla
 * acá rompería el sentido en que `shared/` es más bajo nivel que
 * `modules/`, no al revés). El segundo llamador es
 * `packages/db/scripts/ensure-default-sites.ts` (backfill de
 * organizaciones existentes y reparación si el hook llegó a fallar).
 * `TenancyService.ensureDefaultSite` (`modules/tenancy`) es un envoltorio
 * delgado sobre esta misma función para quien la necesite vía DI de Nest —
 * mismo patrón que `resolveTimezone`.
 *
 * El nombre `'Sede principal'` y la zona horaria son un valor por defecto
 * editable después (no hay todavía un endpoint de `site` para eso) — ver
 * "En contra, asumido" en el ADR.
 */
export async function ensureDefaultSite(tx: Tx, params: EnsureDefaultSiteParams): Promise<void> {
  const existing = await tx.execute<{ id: string }>(sql`
    select id from site where organization_id = ${params.organizationId} limit 1
  `);
  if (existing.rows[0]) return;

  await tx.execute(sql`
    insert into site (id, organization_id, name, timezone, is_active)
    values (
      ${newId()},
      ${params.organizationId},
      'Sede principal',
      'America/Argentina/Buenos_Aires',
      true
    )
  `);
}
