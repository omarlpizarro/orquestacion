import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { newId } from '@orq/contracts';
import { type Db, withTenantTransaction } from '@orq/db';
import { type PostgresHarness, startPostgresHarness } from '@orq/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AUTH } from '../src/shared/auth/auth.tokens.js';
import type { Auth } from '../src/shared/auth/build-auth.js';
import { ensureDefaultSitesForAllOrganizations } from '../src/shared/auth/ensure-default-sites-batch.js';
import { mountBetterAuth } from '../src/shared/auth/mount-better-auth.js';
import { DB } from '../src/shared/database/database.tokens.js';
import { resolveTenantIdentity } from '../src/shared/request-context/request-context.middleware.js';
import { signUpAndCreateOrg } from './helpers/sign-up-and-create-org.js';

/**
 * ADR-013. Contra Postgres real, con `app_login` (harness), como el resto
 * de los tests de integración.
 *
 * Lo que NO prueba este archivo, a propósito: el backfill de `project` con
 * `site_id` null (`ensureDefaultSitesForAllOrganizations`) no tiene un test
 * dedicado, porque no se puede construir la precondición contra el esquema
 * ya migrado — `0009_project_site_id_check_not_valid.sql` agrega un CHECK
 * `NOT VALID`, que no revisa filas existentes pero sí exige `site_id` en
 * toda fila NUEVA desde que se aplica (eso es lo que "NOT VALID" separa:
 * el escaneo del historial, no la validación hacia adelante). Ningún
 * INSERT puede dejar una fila en ese estado en este harness — ni siquiera
 * con el dueño del esquema, un CHECK no es una policy de RLS, no hay
 * bypass. Ese camino del código solo importa para un ambiente real que
 * migra estando atrasado, con filas que ya existían antes de este archivo
 * — exactamente lo que la separación en despliegues (ver ese archivo)
 * existe para manejar con cuidado, no algo que un Testcontainers fresco
 * pueda reproducir.
 */
describe('ensureDefaultSitesForAllOrganizations (integración)', () => {
  let harness: PostgresHarness;
  let app: NestFastifyApplication;
  let auth: Auth;
  let db: Db;

  beforeAll(async () => {
    harness = await startPostgresHarness();
    process.env.DATABASE_URL = harness.appConnectionUri;
    process.env.DATABASE_APP_ROLE = 'app_login';
    process.env.BETTER_AUTH_SECRET = 'test_secret_'.padEnd(32, 'x');
    process.env.BETTER_AUTH_URL = 'http://localhost:3000';

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
      logger: false,
    });
    auth = app.get<Auth>(AUTH);
    db = app.get<Db>(DB);
    mountBetterAuth(app, auth);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await harness.stop();
  });

  async function sitesOf(organizationId: string, memberId: string) {
    return withTenantTransaction(db, { organizationId, memberId, requestId: newId() }, (tx) =>
      tx.execute<{ id: string; name: string; timezone: string }>(sql`
        select id, name, timezone from site where organization_id = ${organizationId}
      `),
    );
  }

  it('el hook afterCreateOrganization deja exactamente un sitio por defecto', async () => {
    const org = await signUpAndCreateOrg(app, 'Frigorífico Hook');
    const tenant = await resolveTenantIdentity(auth, { cookie: org.cookie });
    if (!tenant) throw new Error('esperaba tenant resuelto tras crear la organización');

    const result = await sitesOf(org.organizationId, tenant.memberId);

    expect(result.rows).toEqual([
      expect.objectContaining({
        name: 'Sede principal',
        timezone: 'America/Argentina/Buenos_Aires',
      }),
    ]);
  });

  it('un proyecto sin site_id se rechaza: el CHECK NOT VALID de ADR-013 igual exige site_id en toda fila nueva', async () => {
    const org = await signUpAndCreateOrg(app, 'Frigorífico Sin Sitio');
    const tenant = await resolveTenantIdentity(auth, { cookie: org.cookie });
    if (!tenant) throw new Error('esperaba tenant resuelto tras crear la organización');

    const insert = withTenantTransaction(
      db,
      { organizationId: org.organizationId, memberId: tenant.memberId, requestId: newId() },
      (tx) =>
        tx.execute(sql`
          insert into project (id, organization_id, created_by_member_id, code, name)
          values (${newId()}, ${org.organizationId}, ${tenant.memberId}, 'PRY-1', 'Sin sitio')
        `),
    );

    await expect(insert).rejects.toThrow(/violates check constraint "project_site_id_not_null"/);
  });

  it('repara una organización cuyo sitio se perdió, sin duplicarlo si se corre dos veces', async () => {
    const org = await signUpAndCreateOrg(app, 'Frigorífico Reparación');
    const tenant = await resolveTenantIdentity(auth, { cookie: org.cookie });
    if (!tenant) throw new Error('esperaba tenant resuelto tras crear la organización');

    // Simula el caso que ADR-013 documenta como no evitable por el hook: la
    // organización existe pero se quedó sin sitio (acá, borrándolo a mano
    // en vez de forzando una falla real del hook — ver organization-hooks.spec.ts
    // para la prueba de que el hook no traga ese error).
    await withTenantTransaction(
      db,
      { organizationId: org.organizationId, memberId: tenant.memberId, requestId: newId() },
      (tx) => tx.execute(sql`delete from site where organization_id = ${org.organizationId}`),
    );
    expect((await sitesOf(org.organizationId, tenant.memberId)).rows).toHaveLength(0);

    const firstRun = await ensureDefaultSitesForAllOrganizations(db);
    expect(firstRun.failed).toEqual([]);
    expect(firstRun.sitesCreated).toBeGreaterThanOrEqual(1);
    expect((await sitesOf(org.organizationId, tenant.memberId)).rows).toHaveLength(1);

    const secondRun = await ensureDefaultSitesForAllOrganizations(db);
    expect(secondRun.failed).toEqual([]);
    expect(secondRun.sitesCreated).toBe(0);
    expect((await sitesOf(org.organizationId, tenant.memberId)).rows).toHaveLength(1);
  });
});
