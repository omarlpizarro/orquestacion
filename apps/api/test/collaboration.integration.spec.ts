import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { newId } from '@orq/contracts';
import { type Db, withTenantTransaction } from '@orq/db';
import { type PostgresHarness, startPostgresHarness } from '@orq/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { CollaborationService } from '../src/modules/collaboration/collaboration.module.js';
import { AUTH } from '../src/shared/auth/auth.tokens.js';
import type { Auth } from '../src/shared/auth/build-auth.js';
import { mountBetterAuth } from '../src/shared/auth/mount-better-auth.js';
import { DB } from '../src/shared/database/database.tokens.js';
import { resolveTenantIdentity } from '../src/shared/request-context/request-context.middleware.js';
import { signUpAndCreateOrg } from './helpers/sign-up-and-create-org.js';

/**
 * Prerequisito de PR 4 (change-task-status): `CollaborationService` es el
 * único punto por el que `projects` va a poder dejar constancia de un
 * `block_report`/`reopen` (ADR-012) en `task_update`. Sin endpoint propio
 * todavía (mismo criterio que PR 2), así que se instancia directo — no tiene
 * dependencias de Nest más allá de `Tx`, no hace falta resolverla del
 * contenedor de DI para probarla.
 *
 * Igual que el slice de referencia (create-task.integration.spec.ts): contra
 * Postgres real, con `app_login`, nunca con el dueño del esquema.
 */
describe('CollaborationService.createTaskUpdate (integración)', () => {
  let harness: PostgresHarness;
  let app: NestFastifyApplication;
  let auth: Auth;
  let db: Db;
  let organizationId: string;
  let memberId: string;
  let taskId: string;
  const service = new CollaborationService();

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

    const org = await signUpAndCreateOrg(app, 'Constructora Este');
    organizationId = org.organizationId;
    const tenant = await resolveTenantIdentity(auth, { cookie: org.cookie });
    if (!tenant) throw new Error('esperaba tenant resuelto tras crear la organización');
    memberId = tenant.memberId;

    const projectId = newId();
    taskId = newId();
    await withTenantTransaction(
      db,
      { organizationId, memberId, requestId: newId() },
      async (tx) => {
        await tx.execute(sql`
        insert into project (id, organization_id, created_by_member_id, code, name)
        values (${projectId}, ${organizationId}, ${memberId}, 'PRY-1', 'Frente Este')
      `);
        await tx.execute(sql`
        insert into task (id, organization_id, created_by_member_id, project_id, title, position)
        values (${taskId}, ${organizationId}, ${memberId}, ${projectId}, 'Levantar muro', 'a0')
      `);
      },
    );
  });

  afterAll(async () => {
    await app.close();
    await harness.stop();
  });

  it('inserta el task_update y devuelve su forma', async () => {
    const id = newId();
    const row = await withTenantTransaction(
      db,
      { organizationId, memberId, requestId: newId() },
      (tx) =>
        service.createTaskUpdate(tx, {
          id,
          organizationId,
          createdByMemberId: memberId,
          taskId,
          kind: 'block_report',
          body: 'Falta el permiso municipal',
        }),
    );

    expect(row).toMatchObject({
      id,
      taskId,
      kind: 'block_report',
      body: 'Falta el permiso municipal',
    });
    expect(typeof row.createdAt).toBe('string');
  });

  it('rechaza un kind que no está en task_update_kind_check', async () => {
    await expect(
      withTenantTransaction(db, { organizationId, memberId, requestId: newId() }, (tx) =>
        service.createTaskUpdate(tx, {
          id: newId(),
          organizationId,
          createdByMemberId: memberId,
          taskId,
          // @ts-expect-error — se prueba justamente el valor que el tipo ya prohíbe.
          kind: 'not_a_real_kind',
          body: null,
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('una segunda organización no ve los task_update de la primera (RLS)', async () => {
    const otherOrg = await signUpAndCreateOrg(app, 'Constructora Oeste');
    const otherTenant = await resolveTenantIdentity(auth, { cookie: otherOrg.cookie });
    if (!otherTenant) throw new Error('esperaba tenant resuelto para la segunda organización');

    const rows = await withTenantTransaction(
      db,
      {
        organizationId: otherOrg.organizationId,
        memberId: otherTenant.memberId,
        requestId: newId(),
      },
      (tx) => tx.execute(sql`select id from task_update where task_id = ${taskId}`),
    );

    expect(rows.rows).toEqual([]);
  });
});
