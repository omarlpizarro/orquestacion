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
 * `add-task-comment` (RF-E2, solo texto) con la visibilidad de ADR-017: comentan
 * quienes ven la tarea (acceso completo, o "solo asignado" en sus propias tareas);
 * quien no la ve recibe 404. Postgres real, `app_login`.
 */
describe('POST /projects/tasks/{task_id}/comments (integración)', () => {
  let harness: PostgresHarness;
  let app: NestFastifyApplication;
  let auth: Auth;
  let db: Db;

  let organizationId: string;
  let owner: { cookie: string; memberId: string };
  let explicit: { cookie: string; memberId: string };
  let assigned: { cookie: string; memberId: string };
  let manager: { cookie: string; memberId: string };
  let outsider: { cookie: string; memberId: string };

  let projectId: string;
  let ownTask: { id: string; version: number }; // asignada a `assigned`
  let otherTask: { id: string; version: number }; // sin asignar

  function call(cookie: string, method: 'GET' | 'POST', url: string, payload?: object) {
    return app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers: { cookie },
        ...(payload ? { payload: payload as Record<string, unknown> } : {}),
      });
  }

  async function createTask(extra: Record<string, unknown> = {}) {
    const response = await call(owner.cookie, 'POST', '/projects/tasks', {
      client_mutation_id: newId(),
      id: newId(),
      project_id: projectId,
      title: 'Tarea',
      ...extra,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ id: string; version: number }>();
  }

  const comment = (
    cookie: string,
    taskId: string,
    body: string,
    overrides: Record<string, unknown> = {},
  ) =>
    call(cookie, 'POST', `/projects/tasks/${taskId}/comments`, {
      client_mutation_id: newId(),
      id: newId(),
      body,
      ...overrides,
    });

  async function commentsOn(taskId: string) {
    const result = await withTenantTransaction(
      db,
      { organizationId, memberId: owner.memberId, requestId: newId() },
      (tx) =>
        tx.execute<{ id: string; body: string; created_by_member_id: string }>(sql`
          select id, body, created_by_member_id from task_update
           where task_id = ${taskId} and kind = 'comment' order by created_at, id
        `),
    );
    return result.rows;
  }

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

    const org = await signUpAndCreateOrg(app, 'Constructora Comentarios');
    organizationId = org.organizationId;
    const tenant = await resolveTenantIdentity(auth, { cookie: org.cookie });
    if (!tenant) throw new Error('esperaba tenant resuelto tras crear la organización');
    owner = { cookie: org.cookie, memberId: tenant.memberId };

    const add = (role: 'manager' | 'operator', label: string) =>
      addMemberWithRole(app, auth, { organizationId, role, label });
    explicit = await add('operator', 'Miembro explícito');
    assigned = await add('operator', 'Operario asignado');
    manager = await add('manager', 'Gerente del sitio');
    outsider = await add('operator', 'Operario ajeno');

    projectId = newId();
    const project = await call(owner.cookie, 'POST', '/projects', {
      client_mutation_id: newId(),
      id: projectId,
      code: 'PRY-COMENT',
      name: 'Proyecto reservado',
    });
    expect(project.statusCode, project.body).toBe(200);
    const member = await call(owner.cookie, 'POST', `/projects/${projectId}/members`, {
      client_mutation_id: newId(),
      member_id: explicit.memberId,
    });
    expect(member.statusCode, member.body).toBe(200);

    ownTask = await createTask({ assignee_member_id: assigned.memberId });
    otherTask = await createTask();
  });

  afterAll(async () => {
    await app.close();
    await harness.stop();
  });

  describe('crear el comentario', () => {
    it('devuelve la novedad (kind comment, texto recortado, autor) y aparece en la tarea', async () => {
      const task = await createTask();

      const response = await comment(owner.cookie, task.id, '  Llegó el camión con el hormigón \n');

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        task_id: task.id,
        kind: 'comment',
        body: 'Llegó el camión con el hormigón',
        metadata: {},
        created_by_member_id: owner.memberId,
      });
      const read = await call(owner.cookie, 'GET', `/projects/tasks/${task.id}`);
      expect(read.json().updates).toHaveLength(1);
      expect(read.json().updates[0]).toMatchObject({
        id: response.json().id,
        kind: 'comment',
        body: 'Llegó el camión con el hormigón',
      });
    });

    it.each(['', '   ', '\t\n'])(
      'un cuerpo vacío o de solo espacios (%j) se rechaza con 400 y no inserta',
      async (body) => {
        const task = await createTask();

        const response = await comment(owner.cookie, task.id, body);

        expect(response.statusCode, response.body).toBe(400);
        expect(await commentsOn(task.id)).toEqual([]);
      },
    );

    it('el mismo client_mutation_id dos veces produce una sola novedad y la misma respuesta', async () => {
      const task = await createTask();
      const payload = { client_mutation_id: newId(), id: newId(), body: 'Una sola vez' };
      const url = `/projects/tasks/${task.id}/comments`;

      const first = await call(owner.cookie, 'POST', url, payload);
      const retry = await call(owner.cookie, 'POST', url, payload);

      expect(first.statusCode, first.body).toBe(200);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toEqual(first.json());
      expect(await commentsOn(task.id)).toHaveLength(1);
    });

    it('dos pedidos simultáneos con el mismo client_mutation_id: los dos responden igual y hay una sola novedad', async () => {
      const task = await createTask();
      const payload = { client_mutation_id: newId(), id: newId(), body: 'Simultáneo' };
      const url = `/projects/tasks/${task.id}/comments`;

      const [first, second] = await Promise.all([
        call(owner.cookie, 'POST', url, payload),
        call(owner.cookie, 'POST', url, payload),
      ]);

      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(await commentsOn(task.id)).toHaveLength(1);
    });

    it('el mismo id de mutación para comentar OTRA tarea no devuelve la respuesta de la primera: 409', async () => {
      const taskA = await createTask();
      const taskB = await createTask();
      const reused = newId();
      const sharedCommentId = newId();
      const first = await comment(owner.cookie, taskA.id, 'En A', {
        client_mutation_id: reused,
        id: sharedCommentId,
      });
      expect(first.statusCode, first.body).toBe(200);

      const response = await comment(owner.cookie, taskB.id, 'En B', {
        client_mutation_id: reused,
        id: sharedCommentId,
      });

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().data).toMatchObject({ domain_code: 'client_mutation_id_reused' });
      expect(await commentsOn(taskB.id)).toEqual([]);
    });

    it('el mismo id de mutación para otra operación (cambiar un estado) tampoco: 409', async () => {
      const task = await createTask();
      const reused = newId();
      const first = await comment(owner.cookie, task.id, 'Primero', { client_mutation_id: reused });
      expect(first.statusCode, first.body).toBe(200);

      const response = await call(owner.cookie, 'POST', '/projects/tasks', {
        client_mutation_id: reused,
        id: newId(),
        project_id: projectId,
        title: 'Otra operación',
      });

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().data).toMatchObject({ domain_code: 'client_mutation_id_reused' });
    });

    it('reusar el id de la novedad con otro client_mutation_id responde 409 task_comment_id_taken', async () => {
      const task = await createTask();
      const commentId = newId();
      await comment(owner.cookie, task.id, 'Primera', { id: commentId });

      const response = await comment(owner.cookie, task.id, 'Segunda', { id: commentId });

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().data).toMatchObject({ domain_code: 'task_comment_id_taken' });
      expect(await commentsOn(task.id)).toHaveLength(1);
    });

    it('una regla de dominio que rechaza se lleva la reserva: reintentar el mismo id con una tarea que sí existe anda', async () => {
      const reused = newId();
      const commentId = newId();
      const missing = await comment(owner.cookie, newId(), 'A nadie', {
        client_mutation_id: reused,
        id: commentId,
      });
      expect(missing.statusCode, missing.body).toBe(404);

      const task = await createTask();
      const retry = await comment(owner.cookie, task.id, 'Ahora sí', {
        client_mutation_id: reused,
        id: commentId,
      });

      expect(retry.statusCode, retry.body).toBe(200);
      expect(await commentsOn(task.id)).toHaveLength(1);
    });
  });

  describe('visibilidad (ADR-017)', () => {
    it('quien tiene acceso completo (miembro explícito) comenta cualquier tarea del proyecto', async () => {
      for (const task of [ownTask, otherTask]) {
        const response = await comment(explicit.cookie, task.id, 'Desde acceso completo');
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().created_by_member_id).toBe(explicit.memberId);
      }
    });

    it('"solo asignado" comenta SU tarea', async () => {
      const response = await comment(assigned.cookie, ownTask.id, 'Avance en mi tarea');

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        kind: 'comment',
        created_by_member_id: assigned.memberId,
      });
    });

    it('"solo asignado" no comenta una tarea que no es suya: 404, no 403, y no inserta nada', async () => {
      const before = await commentsOn(otherTask.id);

      const response = await comment(assigned.cookie, otherTask.id, 'En la ajena');

      expect(response.statusCode, response.body).toBe(404);
      expect(response.json().data).toMatchObject({ domain_code: 'task_not_found' });
      expect(await commentsOn(otherTask.id)).toEqual(before);
    });

    it.each([
      ['un operario que no ve el proyecto', () => outsider],
      ['un manager del sitio de un proyecto reservado donde no es miembro', () => manager],
    ])('%s recibe 404', async (_label, who) => {
      const response = await comment(who().cookie, ownTask.id, 'No debería poder');

      expect(response.statusCode, response.body).toBe(404);
    });

    it('otra organización recibe 404', async () => {
      const other = await signUpAndCreateOrg(app, 'Otra Constructora');

      const response = await comment(other.cookie, ownTask.id, 'Desde otra organización');

      expect(response.statusCode, response.body).toBe(404);
    });

    it('una tarea inexistente es 404 task_not_found', async () => {
      const response = await comment(owner.cookie, newId(), 'A nadie');

      expect(response.statusCode, response.body).toBe(404);
      expect(response.json().data).toMatchObject({ domain_code: 'task_not_found' });
    });

    it('una tarea borrada (deleted_at) es 404', async () => {
      const task = await createTask();
      await withTenantTransaction(
        db,
        { organizationId, memberId: owner.memberId, requestId: newId() },
        (tx) => tx.execute(sql`update task set deleted_at = now() where id = ${task.id}`),
      );

      const response = await comment(owner.cookie, task.id, 'A una borrada');

      expect(response.statusCode, response.body).toBe(404);
    });
  });
});
