import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { newId } from '@orq/contracts';
import { type Db, withTenantTransaction } from '@orq/db';
import { type PostgresHarness, startPostgresHarness } from '@orq/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { localDayWindow } from '../src/modules/projects/domain/local-day-window.js';
import { DEFAULT_ORGANIZATION_TIMEZONE } from '../src/modules/tenancy/tenancy.service.js';
import { AUTH } from '../src/shared/auth/auth.tokens.js';
import type { Auth } from '../src/shared/auth/build-auth.js';
import { mountBetterAuth } from '../src/shared/auth/mount-better-auth.js';
import { DB } from '../src/shared/database/database.tokens.js';
import { resolveTenantIdentity } from '../src/shared/request-context/request-context.middleware.js';
import { getDefaultSiteId } from './helpers/get-default-site-id.js';
import { signUpAndCreateOrg } from './helpers/sign-up-and-create-org.js';

/**
 * ADR-013 (aclaración): Better Auth no crea `organization_profile`, así que una organización recién
 * creada no tiene perfil. "Mi Día" tiene que resolver "hoy" igual: con la zona del sitio por defecto, y
 * con America/Argentina/Buenos_Aires si tampoco hay sitio.
 *
 * Se prueba con una tarea que cae dentro del "hoy" de la zona esperada y fuera del "hoy" de la otra: una
 * zona mal resuelta se nota en la respuesta, no solo en el valor devuelto por un método interno.
 */
describe('Mi Día sin organization_profile (integración)', () => {
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

  interface Fixture {
    cookie: string;
    organizationId: string;
    memberId: string;
    projectId: string;
    siteId: string;
  }

  async function newOrganizationWithoutProfile(name: string): Promise<Fixture> {
    const org = await signUpAndCreateOrg(app, name);
    const tenant = await resolveTenantIdentity(auth, { cookie: org.cookie });
    if (!tenant) throw new Error('esperaba tenant resuelto tras crear la organización');
    const base = { organizationId: org.organizationId, memberId: tenant.memberId };
    const siteId = await getDefaultSiteId(db, base);
    const projectId = newId();
    await withTenantTransaction(db, { ...base, requestId: newId() }, async (tx) => {
      const profile = await tx.execute(
        sql`select 1 from organization_profile where organization_id = ${base.organizationId}`,
      );
      expect(profile.rows, 'el hook no debe crear el perfil (ADR-013)').toHaveLength(0);
      await tx.execute(sql`
        insert into project (id, organization_id, site_id, created_by_member_id, code, name)
        values (${projectId}, ${base.organizationId}, ${siteId}, ${base.memberId}, 'PRY-1', 'Obra')
      `);
    });
    return { cookie: org.cookie, ...base, projectId, siteId };
  }

  async function setSiteTimezone(fixture: Fixture, timezone: string): Promise<void> {
    await withTenantTransaction(
      db,
      { organizationId: fixture.organizationId, memberId: fixture.memberId, requestId: newId() },
      (tx) => tx.execute(sql`update site set timezone = ${timezone} where id = ${fixture.siteId}`),
    );
  }

  /** Tarea pendiente, asignada a quien consulta, con inicio en `plannedStartAt`. */
  async function insertTaskStartingAt(fixture: Fixture, plannedStartAt: string): Promise<string> {
    const id = newId();
    await withTenantTransaction(
      db,
      { organizationId: fixture.organizationId, memberId: fixture.memberId, requestId: newId() },
      (tx) =>
        tx.execute(sql`
          insert into task (
            id, organization_id, created_by_member_id, project_id, title, status,
            assignee_member_id, planned_start_at, position
          ) values (
            ${id}, ${fixture.organizationId}, ${fixture.memberId}, ${fixture.projectId},
            'Depende de la zona', 'pending', ${fixture.memberId}, ${plannedStartAt},
            ${`a${id.slice(0, 8)}`}
          )
        `),
    );
    return id;
  }

  async function myDayTaskIds(fixture: Fixture): Promise<string[]> {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/projects/tasks/my-day',
        headers: { cookie: fixture.cookie },
      });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ tasks: Array<{ id: string }> }>().tasks.map((task) => task.id);
  }

  /**
   * Un instante dentro del "hoy" de `inside` y fuera del "hoy" de `outside`. Va en planned_start_at: en
   * planned_end_at, un borde en el pasado la marcaría vencida, y vencida no depende de la zona.
   */
  function instantInsideOnly(inside: string, outside: string): string {
    const now = new Date();
    const insideWindow = localDayWindow(now, inside);
    const outsideWindow = localDayWindow(now, outside);
    const insideStartMs = new Date(insideWindow.startUtc).getTime();
    const outsideStartMs = new Date(outsideWindow.startUtc).getTime();
    const outsideEndMs = new Date(outsideWindow.endUtc).getTime();
    return new Date(
      (outsideStartMs > insideStartMs ? insideStartMs : outsideEndMs) + 60_000,
    ).toISOString();
  }

  it('una organización nueva, sin perfil, resuelve "hoy" con la zona de su sitio por defecto', async () => {
    const fixture = await newOrganizationWithoutProfile('Obra sin perfil');
    // El sitio por defecto nace en Buenos Aires; se lo pasa a Tokio para que la zona del sitio y la de
    // último recurso se distingan en la respuesta.
    await setSiteTimezone(fixture, 'Asia/Tokyo');
    const insideTokyoOnly = await insertTaskStartingAt(
      fixture,
      instantInsideOnly('Asia/Tokyo', DEFAULT_ORGANIZATION_TIMEZONE),
    );
    const insideBuenosAiresOnly = await insertTaskStartingAt(
      fixture,
      instantInsideOnly(DEFAULT_ORGANIZATION_TIMEZONE, 'Asia/Tokyo'),
    );

    const ids = await myDayTaskIds(fixture);

    expect(ids).toContain(insideTokyoOnly);
    expect(ids).not.toContain(insideBuenosAiresOnly);
  });

  it('con el sitio por defecto tal como lo crea el hook, "hoy" es el de Buenos Aires', async () => {
    const fixture = await newOrganizationWithoutProfile('Obra recién creada');
    const insideBuenosAires = await insertTaskStartingAt(
      fixture,
      instantInsideOnly(DEFAULT_ORGANIZATION_TIMEZONE, 'Asia/Tokyo'),
    );

    expect(await myDayTaskIds(fixture)).toContain(insideBuenosAires);
  });

  it('sin perfil y sin sitio activo cae en America/Argentina/Buenos_Aires', async () => {
    const fixture = await newOrganizationWithoutProfile('Obra sin sitio');
    await setSiteTimezone(fixture, 'Asia/Tokyo');
    // Sin sitio activo no queda zona de sitio que consultar; si cayera en Tokio, la tarea de Buenos Aires
    // no aparecería.
    await withTenantTransaction(
      db,
      { organizationId: fixture.organizationId, memberId: fixture.memberId, requestId: newId() },
      (tx) => tx.execute(sql`update site set is_active = false where id = ${fixture.siteId}`),
    );
    const insideBuenosAiresOnly = await insertTaskStartingAt(
      fixture,
      instantInsideOnly(DEFAULT_ORGANIZATION_TIMEZONE, 'Asia/Tokyo'),
    );

    expect(await myDayTaskIds(fixture)).toContain(insideBuenosAiresOnly);
  });

  it('con perfil, gana la zona del perfil sobre la del sitio', async () => {
    const fixture = await newOrganizationWithoutProfile('Obra con perfil');
    await setSiteTimezone(fixture, 'Asia/Tokyo');
    await withTenantTransaction(
      db,
      { organizationId: fixture.organizationId, memberId: fixture.memberId, requestId: newId() },
      (tx) =>
        tx.execute(sql`
          insert into organization_profile (organization_id, industry, timezone)
          values (${fixture.organizationId}, 'agro', 'America/Lima')
        `),
    );
    const insideLimaOnly = await insertTaskStartingAt(
      fixture,
      instantInsideOnly('America/Lima', 'Asia/Tokyo'),
    );

    expect(await myDayTaskIds(fixture)).toContain(insideLimaOnly);
  });
});
