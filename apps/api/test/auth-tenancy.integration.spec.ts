import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { type Db, withTenantTransaction } from '@orq/db';
import { type PostgresHarness, startPostgresHarness } from '@orq/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AUTH } from '../src/shared/auth/auth.tokens.js';
import type { Auth } from '../src/shared/auth/build-auth.js';
import { mountBetterAuth } from '../src/shared/auth/mount-better-auth.js';
import { DB } from '../src/shared/database/database.tokens.js';
import { resolveTenantIdentity } from '../src/shared/request-context/request-context.middleware.js';
import { signUpAndCreateOrg } from './helpers/sign-up-and-create-org.js';

/**
 * A diferencia de `packages/db/test/tenant-isolation.integration.spec.ts`
 * (que prueba el mecanismo de RLS con orgs sintéticas), este archivo prueba
 * la cadena completa con organizaciones reales creadas a través de Better
 * Auth: firma que ADR-010 (organization_id `text`) y ADR-011 (esquema
 * `auth` separado) funcionan juntos de punta a punta, no solo cada uno por
 * separado.
 */
describe('auth + tenancy (integración)', () => {
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

  it('el alta y la creación de organización devuelven un organizationId real (no uuid)', async () => {
    const { organizationId } = await signUpAndCreateOrg(app, 'Org Uno');

    // ADR-010: es un id opaco de Better Auth, no un UUID.
    expect(organizationId).toMatch(/^[a-zA-Z0-9]+$/);
    expect(organizationId).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('resolveTenantIdentity devuelve el organizationId/memberId reales de la sesión activa', async () => {
    const { cookie, organizationId } = await signUpAndCreateOrg(app, 'Org Dos');

    const tenant = await resolveTenantIdentity(auth, { cookie });

    expect(tenant?.organizationId).toBe(organizationId);
    expect(typeof tenant?.memberId).toBe('string');
    expect(tenant?.memberId.length).toBeGreaterThan(0);
  });

  it('resolveTenantIdentity devuelve undefined sin cookie de sesión', async () => {
    const tenant = await resolveTenantIdentity(auth, {});
    expect(tenant).toBeUndefined();
  });

  it('aisla organization_profile y site entre dos organizaciones reales de Better Auth', async () => {
    const orgA = await signUpAndCreateOrg(app, 'Org Tres');
    const orgB = await signUpAndCreateOrg(app, 'Org Cuatro');
    const tenantA = await resolveTenantIdentity(auth, { cookie: orgA.cookie });
    const tenantB = await resolveTenantIdentity(auth, { cookie: orgB.cookie });
    if (!tenantA || !tenantB) throw new Error('esperaba tenant resuelto para ambas orgs');

    await withTenantTransaction(db, { ...tenantA, requestId: randomUUID() }, (tx) =>
      tx.execute(sql`
        insert into organization_profile (organization_id, industry)
        values (${tenantA.organizationId}, 'construccion')
      `),
    );
    await withTenantTransaction(db, { ...tenantB, requestId: randomUUID() }, (tx) =>
      tx.execute(sql`
        insert into organization_profile (organization_id, industry)
        values (${tenantB.organizationId}, 'agro')
      `),
    );

    const seenByA = await withTenantTransaction(db, { ...tenantA, requestId: randomUUID() }, (tx) =>
      tx.execute<{ organization_id: string }>(
        sql`select organization_id from organization_profile`,
      ),
    );
    expect(seenByA.rows).toEqual([{ organization_id: tenantA.organizationId }]);

    const seenByB = await withTenantTransaction(db, { ...tenantB, requestId: randomUUID() }, (tx) =>
      tx.execute<{ organization_id: string }>(
        sql`select organization_id from organization_profile`,
      ),
    );
    expect(seenByB.rows).toEqual([{ organization_id: tenantB.organizationId }]);
  });

  it('nadie puede leer las membresías de una organización ajena: sin RLS en auth.member (ADR-011), el aislamiento depende solo del código', async () => {
    const orgA = await signUpAndCreateOrg(app, 'Org Cinco');
    const orgB = await signUpAndCreateOrg(app, 'Org Seis');
    const fastify = app.getHttpAdapter().getInstance();

    // Better Auth expone `list-members` con un `organizationId` que el
    // caller elige — no necesariamente el de su sesión activa. Si el
    // código que lo resuelve no verificara la membresía del que pregunta,
    // esto devolvería las membresías de orgB sin que ninguna policy de
    // base lo frenara: `auth.member` no tiene `organization_id` bajo RLS.
    const response = await fastify.inject({
      method: 'GET',
      url: `/api/auth/organization/list-members?organizationId=${orgB.organizationId}`,
      headers: { cookie: orgA.cookie },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).not.toHaveProperty('members');
  });

  it('las tablas de Better Auth (esquema auth) no tienen RLS: ADR-011', async () => {
    const result = await app.get<Db>(DB).execute<{ relname: string; rls_enabled: boolean }>(sql`
      select c.relname, c.relrowsecurity as rls_enabled
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'auth' and c.relkind = 'r'
    `);

    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.rls_enabled).toBe(false);
    }
  });
});
