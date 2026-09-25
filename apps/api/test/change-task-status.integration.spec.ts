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
import { addMemberWithRole } from './helpers/add-member-with-role.js';
import { signUpAndCreateOrg } from './helpers/sign-up-and-create-org.js';

/**
 * change-task-status: primer slice que cruza `projects` (máquina de
 * estados, PR de `task-status-transitions.ts`) y `collaboration`
 * (`CollaborationService.createTaskUpdate`, ADR-012) en una misma
 * transacción. Contra Postgres real con `app_login`, igual que el slice de
 * referencia.
 */
describe('PATCH /projects/tasks/:id/status (integración)', () => {
  let harness: PostgresHarness;
  let app: NestFastifyApplication;
  let auth: Auth;
  let db: Db;
  let organizationId: string;
  let ownerCookie: string;
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
    auth = app.get<Auth>(AUTH);
    db = app.get<Db>(DB);
    mountBetterAuth(app, auth);
    await app.init();

    const org = await signUpAndCreateOrg(app, 'Constructora Cambio de Estado');
    ownerCookie = org.cookie;
    organizationId = org.organizationId;
    const tenant = await resolveTenantIdentity(auth, { cookie: ownerCookie });
    if (!tenant) throw new Error('esperaba tenant resuelto tras crear la organización');

    await withTenantTransaction(
      db,
      { organizationId, memberId: tenant.memberId, requestId: newId() },
      (tx) =>
        tx.execute(sql`
          insert into organization_profile (organization_id, industry)
          values (${organizationId}, 'construccion')
        `),
    );

    projectId = newId();
    await withTenantTransaction(
      db,
      { organizationId, memberId: tenant.memberId, requestId: newId() },
      (tx) =>
        tx.execute(sql`
          insert into project (id, organization_id, created_by_member_id, code, name)
          values (${projectId}, ${organizationId}, ${tenant.memberId}, 'PRY-1', 'Frente Cambio')
        `),
    );
  });

  afterAll(async () => {
    await app.close();
    await harness.stop();
  });

  async function createTask(payload: Record<string, unknown>) {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/projects/tasks',
        headers: { cookie: ownerCookie },
        payload: {
          client_mutation_id: newId(),
          id: newId(),
          project_id: projectId,
          title: 'Tarea de prueba',
          ...payload,
        },
      });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ id: string; version: number }>();
  }

  function changeStatus(cookie: string, taskId: string, payload: Record<string, unknown>) {
    return app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'PATCH',
        url: `/projects/tasks/${taskId}/status`,
        headers: { cookie },
        payload: { client_mutation_id: newId(), ...payload },
      });
  }

  async function taskUpdatesFor(taskId: string) {
    const rows = await withTenantTransaction(
      db,
      { organizationId, memberId: newId(), requestId: newId() },
      (tx) =>
        tx.execute<{ kind: string; body: string | null; metadata: unknown }>(sql`
          select kind, body, metadata from task_update
          where task_id = ${taskId} order by created_at asc
        `),
    );
    return rows.rows;
  }

  it('cambia el estado, avanza version, y deja un task_update de tipo status_change con from/to', async () => {
    const task = await createTask({});

    const response = await changeStatus(ownerCookie, task.id, {
      to_status: 'in_progress',
      expected_version: task.version,
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ status: 'in_progress', version: task.version + 1 });

    const updates = await taskUpdatesFor(task.id);
    expect(updates).toEqual([
      { kind: 'status_change', body: null, metadata: { from: 'pending', to: 'in_progress' } },
    ]);
  });

  it('responde CONFLICT si expected_version no coincide', async () => {
    const task = await createTask({});

    const response = await changeStatus(ownerCookie, task.id, {
      to_status: 'in_progress',
      expected_version: task.version + 1,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().data).toMatchObject({ domain_code: 'task_version_mismatch' });
  });

  it('responde NOT_FOUND si la tarea no existe', async () => {
    const response = await changeStatus(ownerCookie, newId(), {
      to_status: 'in_progress',
      expected_version: 1,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().data).toMatchObject({ domain_code: 'task_not_found' });
  });

  it('responde UNPROCESSABLE_CONTENT para una transición que no existe (pending -> done directo)', async () => {
    const task = await createTask({});

    const response = await changeStatus(ownerCookie, task.id, {
      to_status: 'done',
      expected_version: task.version,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().data).toMatchObject({ domain_code: 'invalid_task_status_transition' });
  });

  it('bloquear sin motivo responde UNPROCESSABLE_CONTENT; con motivo aplica y guarda un task_update block_report', async () => {
    const task = await createTask({});
    const started = await changeStatus(ownerCookie, task.id, {
      to_status: 'in_progress',
      expected_version: task.version,
    });
    const startedBody = started.json();

    const withoutReason = await changeStatus(ownerCookie, task.id, {
      to_status: 'blocked',
      expected_version: startedBody.version,
    });
    expect(withoutReason.statusCode).toBe(422);
    expect(withoutReason.json().data).toMatchObject({ domain_code: 'reason_required' });

    const withReason = await changeStatus(ownerCookie, task.id, {
      to_status: 'blocked',
      expected_version: startedBody.version,
      reason: 'Falta el permiso municipal',
    });
    expect(withReason.statusCode, withReason.body).toBe(200);

    const updates = await taskUpdatesFor(task.id);
    expect(updates.at(-1)).toEqual({
      kind: 'block_report',
      body: 'Falta el permiso municipal',
      metadata: { from: 'in_progress', to: 'blocked' },
    });
  });

  it('un operator no asignado responde FORBIDDEN (requiere ser el asignado)', async () => {
    const task = await createTask({});
    const operator = await addMemberWithRole(app, auth, {
      organizationId,
      role: 'operator',
      label: 'Capataz sin asignar',
    });

    const response = await changeStatus(operator.cookie, task.id, {
      to_status: 'in_progress',
      expected_version: task.version,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().data).toMatchObject({
      domain_code: 'task_status_transition_requires_assignee',
    });
  });

  it('un operator asignado sí puede transicionar su propia tarea', async () => {
    const operator = await addMemberWithRole(app, auth, {
      organizationId,
      role: 'operator',
      label: 'Capataz asignado',
    });
    const task = await createTask({ assignee_member_id: operator.memberId });

    const response = await changeStatus(operator.cookie, task.id, {
      to_status: 'in_progress',
      expected_version: task.version,
    });

    expect(response.statusCode, response.body).toBe(200);
  });

  it('completar la tarea fija actual_end_at con la hora del servidor; reabrirla (con motivo) lo limpia de nuevo', async () => {
    const task = await createTask({});
    const inProgress = await changeStatus(ownerCookie, task.id, {
      to_status: 'in_progress',
      expected_version: task.version,
    });
    expect(inProgress.statusCode, inProgress.body).toBe(200);
    const done = await changeStatus(ownerCookie, task.id, {
      to_status: 'done',
      expected_version: inProgress.json().version,
    });
    expect(done.statusCode, done.body).toBe(200);

    const afterDone = await withTenantTransaction(
      db,
      { organizationId, memberId: newId(), requestId: newId() },
      (tx) =>
        tx.execute<{ actual_end_at: string | null }>(
          sql`select actual_end_at from task where id = ${task.id}`,
        ),
    );
    expect(afterDone.rows[0]?.actual_end_at).not.toBeNull();

    const reopened = await changeStatus(ownerCookie, task.id, {
      to_status: 'in_progress',
      expected_version: done.json().version,
      reason: 'Se cerró por error, falta terminar una parte',
    });
    expect(reopened.statusCode, reopened.body).toBe(200);

    const afterReopen = await withTenantTransaction(
      db,
      { organizationId, memberId: newId(), requestId: newId() },
      (tx) =>
        tx.execute<{ actual_end_at: string | null }>(
          sql`select actual_end_at from task where id = ${task.id}`,
        ),
    );
    expect(afterReopen.rows[0]?.actual_end_at).toBeNull();

    const updates = await taskUpdatesFor(task.id);
    expect(updates.at(-1)).toMatchObject({ kind: 'reopen' });
  });

  it('un operator no puede reabrir una tarea done, aunque sea el asignado', async () => {
    const operator = await addMemberWithRole(app, auth, {
      organizationId,
      role: 'operator',
      label: 'Capataz que no puede reabrir',
    });
    const task = await createTask({ assignee_member_id: operator.memberId });
    const inProgress = await changeStatus(operator.cookie, task.id, {
      to_status: 'in_progress',
      expected_version: task.version,
    });
    expect(inProgress.statusCode, inProgress.body).toBe(200);
    const done = await changeStatus(operator.cookie, task.id, {
      to_status: 'done',
      expected_version: inProgress.json().version,
    });
    expect(done.statusCode, done.body).toBe(200);

    const reopenAttempt = await changeStatus(operator.cookie, task.id, {
      to_status: 'in_progress',
      expected_version: done.json().version,
      reason: 'Intento no autorizado',
    });

    expect(reopenAttempt.statusCode).toBe(403);
    expect(reopenAttempt.json().data).toMatchObject({
      domain_code: 'task_status_transition_forbidden',
    });
  });

  it('el mismo client_mutation_id dos veces produce un solo efecto (un solo task_update)', async () => {
    const task = await createTask({});
    const payload = { to_status: 'in_progress', expected_version: task.version };
    const clientMutationId = newId();

    const first = await changeStatus(ownerCookie, task.id, {
      client_mutation_id: clientMutationId,
      ...payload,
    });
    const second = await changeStatus(ownerCookie, task.id, {
      client_mutation_id: clientMutationId,
      ...payload,
    });

    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await taskUpdatesFor(task.id)).toHaveLength(1);
  });
});
