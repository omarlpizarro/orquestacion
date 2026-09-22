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
import { mountBetterAuth } from '../src/shared/auth/mount-better-auth.js';
import { DB } from '../src/shared/database/database.tokens.js';
import { resolveTenantIdentity } from '../src/shared/request-context/request-context.middleware.js';
import { signUpAndCreateOrg } from './helpers/sign-up-and-create-org.js';

/**
 * Slice de referencia (docs/phase-2-brief.md, PR 1): create-task de punta a
 * punta contra Postgres real, con la misma identidad de conexión que usa la
 * app en producción (`app_login`, vía el harness) — nunca el dueño del
 * esquema.
 */
describe('POST /projects/tasks (integración)', () => {
  let harness: PostgresHarness;
  let app: NestFastifyApplication;
  let db: Db;
  let organizationId: string;
  let memberId: string;
  let cookie: string;
  let projectId: string;

  beforeAll(async () => {
    harness = await startPostgresHarness();
    process.env.DATABASE_URL = harness.appConnectionUri;
    process.env.DATABASE_APP_ROLE = 'app_login';
    process.env.BETTER_AUTH_SECRET = 'test_secret_'.padEnd(32, 'x');
    process.env.BETTER_AUTH_URL = 'http://localhost:3000';

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
      logger: false,
    });
    const auth = app.get<Auth>(AUTH);
    db = app.get<Db>(DB);
    mountBetterAuth(app, auth);
    await app.init();

    const org = await signUpAndCreateOrg(app, 'Constructora Sur');
    cookie = org.cookie;
    organizationId = org.organizationId;
    const tenant = await resolveTenantIdentity(auth, { cookie });
    if (!tenant) throw new Error('esperaba tenant resuelto tras crear la organización');
    memberId = tenant.memberId;

    // organization_profile no lo crea Better Auth (es nuestra tabla, 1 a 1
    // con auth.organization): el slice de onboarding que la crea es de una
    // fase posterior (CLAUDE.md §14). Se inserta a mano para que
    // resolveTimezone tenga de dónde resolver — usa su default
    // (America/Argentina/Buenos_Aires, UTC-3) a propósito.
    await withTenantTransaction(db, { organizationId, memberId, requestId: newId() }, (tx) =>
      tx.execute(sql`
        insert into organization_profile (organization_id, industry)
        values (${organizationId}, 'construccion')
      `),
    );

    projectId = newId();
    await withTenantTransaction(db, { organizationId, memberId, requestId: newId() }, (tx) =>
      tx.execute(sql`
        insert into project (id, organization_id, created_by_member_id, code, name)
        values (${projectId}, ${organizationId}, ${memberId}, 'PRY-1', 'Frente Norte')
      `),
    );
  });

  afterAll(async () => {
    await app.close();
    await harness.stop();
  });

  function post(payload: Record<string, unknown>) {
    return app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/projects/tasks',
      headers: { cookie },
      payload,
    });
  }

  async function countTasksWithTitle(title: string): Promise<number> {
    const result = await withTenantTransaction(
      db,
      { organizationId, memberId, requestId: newId() },
      (tx) =>
        tx.execute<{ count: string }>(
          sql`select count(*)::text as count from task where title = ${title}`,
        ),
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  it('crea la tarea, la persiste con app_login y devuelve su forma pública', async () => {
    const response = await post({
      client_mutation_id: newId(),
      id: newId(),
      project_id: projectId,
      title: 'Excavar cimientos',
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      title: 'Excavar cimientos',
      status: 'pending',
      criticality: 'normal',
      parent_task_id: null,
      position: 'a0',
      version: 1,
    });
    expect(await countTasksWithTitle('Excavar cimientos')).toBe(1);
  });

  it('convierte planned_end_at de hora local (del sitio o, sin sitio, de la organización) a UTC', async () => {
    const response = await post({
      client_mutation_id: newId(),
      id: newId(),
      project_id: projectId,
      title: 'Colocar encofrado',
      planned_end_at: '2026-09-29T08:00:00',
    });

    expect(response.statusCode, response.body).toBe(200);
    // organization_profile.timezone default: America/Argentina/Buenos_Aires (UTC-3).
    expect(response.json().planned_end_at).toBe('2026-09-29T11:00:00.000Z');
  });

  it('el mismo client_mutation_id dos veces produce un solo efecto', async () => {
    const payload = {
      client_mutation_id: newId(),
      id: newId(),
      project_id: projectId,
      title: 'Idempotente',
    };

    const first = await post(payload);
    const second = await post(payload);

    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(await countTasksWithTitle('Idempotente')).toBe(1);
  });

  it('responde NOT_FOUND si el proyecto no existe', async () => {
    const response = await post({
      client_mutation_id: newId(),
      id: newId(),
      project_id: newId(),
      title: 'Tarea sin proyecto',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().data).toMatchObject({ domain_code: 'project_not_found' });
  });

  it('crea una subtarea con path bajo la del padre', async () => {
    const parentId = newId();
    await post({
      client_mutation_id: newId(),
      id: parentId,
      project_id: projectId,
      title: 'Tarea raíz',
    });

    const child = await post({
      client_mutation_id: newId(),
      id: newId(),
      project_id: projectId,
      parent_task_id: parentId,
      title: 'Subtarea',
    });

    expect(child.statusCode, child.body).toBe(200);
    expect(child.json().parent_task_id).toBe(parentId);
  });

  it('responde NOT_FOUND si la tarea padre no existe', async () => {
    const response = await post({
      client_mutation_id: newId(),
      id: newId(),
      project_id: projectId,
      parent_task_id: newId(),
      title: 'Subtarea huérfana',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().data).toMatchObject({ domain_code: 'parent_task_not_found' });
  });

  it('responde UNPROCESSABLE_CONTENT al superar los tres niveles de profundidad (ADR-006)', async () => {
    let parentId: string | undefined;
    for (let level = 0; level < 3; level++) {
      const response = await post({
        client_mutation_id: newId(),
        id: newId(),
        project_id: projectId,
        parent_task_id: parentId,
        title: `Nivel ${level}`,
      });
      expect(response.statusCode, response.body).toBe(200);
      parentId = response.json().id;
    }

    const fourthLevel = await post({
      client_mutation_id: newId(),
      id: newId(),
      project_id: projectId,
      parent_task_id: parentId,
      title: 'Cuarto nivel, no debería entrar',
    });

    expect(fourthLevel.statusCode).toBe(422);
    expect(fourthLevel.json().data).toMatchObject({ domain_code: 'max_depth_exceeded' });
  });
});
