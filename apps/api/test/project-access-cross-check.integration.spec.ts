import { randomUUID } from 'node:crypto';
import { type Tx, withTenantTransaction } from '@orq/db';
import {
  insertAuthMember,
  insertAuthOrganization,
  type PostgresHarness,
  startPostgresHarness,
} from '@orq/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenancyService } from '../src/modules/tenancy/tenancy.service.js';
import { hasImplicitAllSitesAccess, ORG_ROLES } from '../src/shared/auth/org-role.js';

/**
 * ADR-017 §3: las funciones de RLS resuelven el rol y el acceso al sitio EN LA
 * BASE, y el código de la aplicación (`hasImplicitAllSitesAccess`,
 * `TenancyService.canAccessSite`) los resuelve en TypeScript. Son dos
 * definiciones de lo mismo; este test las cruza para que no puedan divergir sin
 * que algo se ponga rojo. Toda combinación de rol × fila en `member_site_access`.
 */
describe('la base y el código coinciden en quién tiene acceso (ADR-017)', () => {
  let harness: PostgresHarness;
  const tenancy = new TenancyService();
  const suffix = randomUUID().replaceAll('-', '');
  const organizationId = `org_${suffix}`;
  const siteId = randomUUID();
  const openProjectId = randomUUID();
  const reservedProjectId = randomUUID();

  const memberId = (role: string, hasRow: boolean) =>
    `${role}_${hasRow ? 'row' : 'norow'}_${suffix}`;
  const combinations = ORG_ROLES.flatMap((role) =>
    [true, false].map((hasRow) => ({ role, hasRow })),
  );

  const as = <T>(member: string, run: (tx: Tx) => Promise<T>) =>
    withTenantTransaction(
      harness.db,
      { organizationId, memberId: member, requestId: randomUUID() },
      run,
    );

  beforeAll(async () => {
    harness = await startPostgresHarness();
    await insertAuthOrganization(harness.ownerDb, { id: organizationId });
    for (const { role, hasRow } of combinations) {
      await insertAuthMember(harness.ownerDb, {
        organizationId,
        memberId: memberId(role, hasRow),
        role,
      });
    }
    const admin = memberId('owner', true);
    await as(admin, async (tx) => {
      await tx.execute(sql`
        insert into site (id, organization_id, name, timezone)
        values (${siteId}, ${organizationId}, 'Sitio', 'America/Argentina/Buenos_Aires')
      `);
      for (const { role, hasRow } of combinations) {
        // owner y director no necesitan fila (ADR-016), pero tenerla no cambia nada.
        if (!hasRow) continue;
        await tx.execute(sql`
          insert into member_site_access (organization_id, member_id, site_id)
          values (${organizationId}, ${memberId(role, true)}, ${siteId})
        `);
      }
      for (const [id, code, visibility] of [
        [openProjectId, 'ABIERTO', 'site'],
        [reservedProjectId, 'RESERVADO', 'reserved'],
      ] as const) {
        await tx.execute(sql`
          insert into project (id, organization_id, site_id, created_by_member_id, code, name, visibility)
          values (${id}, ${organizationId}, ${siteId}, ${admin}, ${code}, ${code}, ${visibility})
        `);
      }
    });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it.each(combinations)('$role, con fila de sitio: $hasRow', async ({ role, hasRow }) => {
    const member = memberId(role, hasRow);
    const { isPrivileged, fullOnOpen, fullOnReserved, canAccessSite } = await as(
      member,
      async (tx) => {
        const row = (
          await tx.execute<{
            privileged: boolean;
            open: boolean;
            reserved: boolean;
          }>(sql`
            select app_is_privileged() as privileged,
                   app_has_full_project_access(${openProjectId}) as open,
                   app_has_full_project_access(${reservedProjectId}) as reserved
          `)
        ).rows[0];
        return {
          isPrivileged: row?.privileged,
          fullOnOpen: row?.open,
          fullOnReserved: row?.reserved,
          // Misma pregunta, contestada por el código de la aplicación.
          canAccessSite: await tenancy.canAccessSite(tx, {
            organizationId,
            memberId: member,
            role,
            siteId,
          }),
        };
      },
    );

    // La base reconoce al privilegiado igual que el código.
    expect(isPrivileged).toBe(hasImplicitAllSitesAccess(role));
    // Acceso completo a un proyecto abierto al sitio == poder trabajar en el sitio.
    expect(fullOnOpen).toBe(canAccessSite);
    // Un proyecto reservado solo lo ve completo el privilegiado (nadie es miembro).
    expect(fullOnReserved).toBe(hasImplicitAllSitesAccess(role));
  });
});
