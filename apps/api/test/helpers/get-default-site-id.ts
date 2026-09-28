import { randomUUID } from 'node:crypto';
import type { Db } from '@orq/db';
import { withTenantTransaction } from '@orq/db';
import { sql } from 'drizzle-orm';

/**
 * ADR-013: `signUpAndCreateOrg` ya deja un sitio por defecto creado (vía el
 * hook `afterCreateOrganization`), así que los tests que insertan un
 * `project` a mano lo necesitan para `site_id` (`NOT NULL` desde ADR-013).
 * No asume el nombre `'Sede principal'` — toma el que exista, para no
 * acoplar los tests a ese valor por defecto.
 */
export async function getDefaultSiteId(
  db: Db,
  params: { organizationId: string; memberId: string },
): Promise<string> {
  const result = await withTenantTransaction(db, { ...params, requestId: randomUUID() }, (tx) =>
    tx.execute<{ id: string }>(sql`select id from site limit 1`),
  );
  const siteId = result.rows[0]?.id;
  if (!siteId) {
    throw new Error(
      `La organización ${params.organizationId} no tiene ningún site — ¿falló el hook afterCreateOrganization?`,
    );
  }
  return siteId;
}
