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
 * `delete-task`: borra una tarea y todo su subárbol, lógicamente (`deleted_at`, regla
 * dura 9). Borra `task:delete` (owner, director, manager) con acceso completo al
 * proyecto. Postgres real, `app_login`.
 */
describe('DELETE /projects/tasks/{id} (integración)', () => {
  let harness: PostgresHarness;
  let app: NestFastifyApplication;
  let auth: Auth;
  let db: Db;

  let organizationId: string;
  type Person = { cookie: string; memberId: string };
  let owner: Person;
  let director: Person;
  let manager: Person; // acceso completo vía el sitio (proyecto abierto)
  let managerAssigned: Person; // "solo asignado" en el proyecto reservado
  let operatorA: Person;
  let operatorMember: Person; // miembro explícito del reservado
  let outsider: Person;

  let openProjectId: string;
  let reservedProjectId: string;

  type TaskBody = { id: string; version: number; status: string };

  function call(
    cookie: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) {
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

  async function createProject(visibility: 'reserved' | 'site', code: string) {
    const id = newId();
    const response = await call(owner.cookie, 'POST', '/projects', {
      client_mutation_id: newId(),
      id,
      code,
      name: code,
      visibility,
    });
    expect(response.statusCode, response.body).toBe(200);
    return id;
  }

  async function createTask(project: string, extra: Record<string, unknown> = {}) {
    const response = await call(owner.cookie, 'POST', '/projects/tasks', {
      client_mutation_id: newId(),
      id: newId(),
      project_id: project,
      title: 'Excavar',
      ...extra,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<TaskBody>();
  }

  const remove = (cookie: string, task: { id: string; version: number }, extra: object = {}) =>
    call(cookie, 'DELETE', `/projects/tasks/${task.id}`, {
      client_mutation_id: newId(),
      expected_version: task.version,
      ...extra,
    });

  const asOwner = <T>(
    run: (tx: Parameters<Parameters<typeof withTenantTransaction>[2]>[0]) => Promise<T>,
  ) =>
    withTenantTransaction(
      db,
      { organizationId, memberId: owner.memberId, requestId: newId() },
      run,
    );

  async function rowOf(taskId: string) {
    const result = await asOwner((tx) =>
      tx.execute<{ deleted_at: string | null; title: string }>(sql`
        select deleted_at, title from task where id = ${taskId}
      `),
    );
    return result.rows[0];
  }

  /** T ── a ── a1 ; T ── b  (cuatro tareas en un árbol de tres niveles). */
  async function createTree(project: string) {
    const root = await createTask(project, { title: 'Raíz' });
    const a = await createTask(project, { title: 'a', parent_task_id: root.id });
    const a1 = await createTask(project, { title: 'a1', parent_task_id: a.id });
    const b = await createTask(project, { title: 'b', parent_task_id: root.id });
    return { root, a, a1, b };
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

    const org = await signUpAndCreateOrg(app, 'Constructora Borrado');
    organizationId = org.organizationId;
    const tenant = await resolveTenantIdentity(auth, { cookie: org.cookie });
    if (!tenant) throw new Error('esperaba tenant resuelto tras crear la organización');
    owner = { cookie: org.cookie, memberId: tenant.memberId };

    // Mi Día resuelve la zona de quien consulta con `organization_profile`.
    await asOwner((tx) =>
      tx.execute(sql`
        insert into organization_profile (organization_id, industry)
        values (${organizationId}, 'construccion')
      `),
    );

    const add = (role: 'director' | 'manager' | 'operator', label: string) =>
      addMemberWithRole(app, auth, { organizationId, role, label });
    director = await add('director', 'Directora');
    manager = await add('manager', 'Gerente del sitio');
    managerAssigned = await add('manager', 'Gerente asignado');
    operatorA = await add('operator', 'Operario A');
    operatorMember = await add('operator', 'Operario miembro');
    outsider = await add('operator', 'Operario ajeno');

    openProjectId = await createProject('site', 'PRY-ABIERTO');
    reservedProjectId = await createProject('reserved', 'PRY-RESERVADO');
    const member = await call(owner.cookie, 'POST', `/projects/${reservedProjectId}/members`, {
      client_mutation_id: newId(),
      member_id: operatorMember.memberId,
    });
    expect(member.statusCode, member.body).toBe(200);
  });

  afterAll(async () => {
    await app.close();
    await harness.stop();
  });

  describe('qué se borra', () => {
    it('una tarea sin subtareas: responde cuántas, desaparece de las lecturas y la fila queda (regla dura 9)', async () => {
      const task = await createTask(openProjectId, { title: 'Hoja' });

      const response = await remove(owner.cookie, task);

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ id: task.id, deleted_task_count: 1 });
      expect(response.json().deleted_at).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect((await call(owner.cookie, 'GET', `/projects/tasks/${task.id}`)).statusCode).toBe(404);
      const list = await call(owner.cookie, 'GET', `/projects/${openProjectId}/tasks`);
      expect(JSON.stringify(list.json())).not.toContain(task.id);
      // Nunca se borra la fila: queda con `deleted_at`.
      expect((await rowOf(task.id))?.deleted_at).not.toBeNull();
    });

    it('una tarea con subtareas se lleva todo su subárbol con el mismo deleted_at; las hermanas no se tocan', async () => {
      const { root, a, a1, b } = await createTree(openProjectId);
      const sibling = await createTask(openProjectId, { title: 'Hermana de la raíz' });

      const response = await remove(owner.cookie, root);

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().deleted_task_count).toBe(4);
      const deletedAt = (await rowOf(root.id))?.deleted_at;
      expect(deletedAt).not.toBeNull();
      for (const task of [a, a1, b]) {
        expect((await rowOf(task.id))?.deleted_at).toEqual(deletedAt);
        expect((await call(owner.cookie, 'GET', `/projects/tasks/${task.id}`)).statusCode).toBe(
          404,
        );
      }
      expect((await rowOf(sibling.id))?.deleted_at).toBeNull();
      expect((await call(owner.cookie, 'GET', `/projects/tasks/${sibling.id}`)).statusCode).toBe(
        200,
      );
    });

    it('informa cuántas de las tareas borradas tenían responsable, y un reintento responde lo mismo', async () => {
      const root = await createTask(openProjectId, { assignee_member_id: operatorA.memberId });
      await createTask(openProjectId, { parent_task_id: root.id });
      await createTask(openProjectId, {
        parent_task_id: root.id,
        assignee_member_id: operatorA.memberId,
      });
      const payload = { client_mutation_id: newId(), expected_version: root.version };
      const url = `/projects/tasks/${root.id}`;

      const first = await call(owner.cookie, 'DELETE', url, payload);
      const retry = await call(owner.cookie, 'DELETE', url, payload);

      expect(first.json()).toMatchObject({ deleted_task_count: 3, assigned_task_count: 2 });
      expect(retry.json()).toEqual(first.json());
    });

    it('borrar una subtarea no toca a su padre ni a sus hermanas', async () => {
      const { root, a, a1, b } = await createTree(openProjectId);

      const response = await remove(owner.cookie, a);

      expect(response.json().deleted_task_count).toBe(2);
      expect((await rowOf(a1.id))?.deleted_at).not.toBeNull();
      expect((await rowOf(root.id))?.deleted_at).toBeNull();
      expect((await rowOf(b.id))?.deleted_at).toBeNull();
      const read = await call(owner.cookie, 'GET', `/projects/tasks/${root.id}`);
      expect(read.json().subtasks.map((t: { id: string }) => t.id)).toEqual([b.id]);
    });

    it('las novedades de las tareas borradas se conservan', async () => {
      const task = await createTask(openProjectId);
      const comment = await call(owner.cookie, 'POST', `/projects/tasks/${task.id}/comments`, {
        client_mutation_id: newId(),
        id: newId(),
        body: 'Antes de borrar',
      });
      expect(comment.statusCode, comment.body).toBe(200);

      await remove(owner.cookie, task);

      const kept = await asOwner((tx) =>
        tx.execute(
          sql`select 1 from task_update where task_id = ${task.id} and deleted_at is null`,
        ),
      );
      expect(kept.rows).toHaveLength(1);
    });

    it('una cancelada o una done también se borran', async () => {
      const cancelled = await createTask(openProjectId);
      const response = await call(owner.cookie, 'PATCH', `/projects/tasks/${cancelled.id}/status`, {
        client_mutation_id: newId(),
        to_status: 'cancelled',
        expected_version: cancelled.version,
        reason: 'Se canceló',
      });
      expect(response.statusCode, response.body).toBe(200);

      const removed = await remove(owner.cookie, {
        id: cancelled.id,
        version: response.json().version,
      });

      expect(removed.statusCode, removed.body).toBe(200);
    });

    it('queda en el audit: una entrada de deleted_at por cada tarea borrada', async () => {
      const { root, a, a1, b } = await createTree(openProjectId);
      await remove(owner.cookie, root);

      const entries = await asOwner((tx) =>
        tx.execute<{ entity_id: string; changed: Record<string, unknown> }>(sql`
          select entity_id, changed from audit_log
           where entity_type = 'task' and action = 'update'
             and entity_id in (${root.id}, ${a.id}, ${a1.id}, ${b.id})
             and changed ? 'deleted_at'
        `),
      );

      expect(entries.rows.map((entry) => entry.entity_id).sort()).toEqual(
        [root.id, a.id, a1.id, b.id].sort(),
      );
    });
  });

  describe('una tarea borrada deja de existir para todo lo demás', () => {
    it('no se le cambia el estado, ni se comenta, ni se edita, ni se asigna, ni se le cuelgan subtareas: 404', async () => {
      const task = await createTask(openProjectId);
      await remove(owner.cookie, task);

      const status = await call(owner.cookie, 'PATCH', `/projects/tasks/${task.id}/status`, {
        client_mutation_id: newId(),
        to_status: 'in_progress',
        expected_version: task.version,
      });
      const comment = await call(owner.cookie, 'POST', `/projects/tasks/${task.id}/comments`, {
        client_mutation_id: newId(),
        id: newId(),
        body: 'A una borrada',
      });
      const edit = await call(owner.cookie, 'PATCH', `/projects/tasks/${task.id}`, {
        client_mutation_id: newId(),
        expected_version: task.version,
        title: 'Nuevo',
      });
      const assign = await call(owner.cookie, 'PATCH', `/projects/tasks/${task.id}/assignee`, {
        client_mutation_id: newId(),
        expected_version: task.version,
        assignee_member_id: null,
      });
      const child = await call(owner.cookie, 'POST', '/projects/tasks', {
        client_mutation_id: newId(),
        id: newId(),
        project_id: openProjectId,
        parent_task_id: task.id,
        title: 'Hija de una borrada',
      });

      for (const response of [status, comment, edit, assign, child]) {
        expect(response.statusCode, response.body).toBe(404);
      }
    });

    it('al asignado se le va el acceso y la tarea sale de Mi Día', async () => {
      const task = await createTask(reservedProjectId, { assignee_member_id: operatorA.memberId });
      const before = await call(operatorA.cookie, 'GET', '/projects/tasks/my-day');
      expect(before.json().tasks.map((t: { id: string }) => t.id)).toContain(task.id);

      await remove(owner.cookie, task);

      expect((await call(operatorA.cookie, 'GET', `/projects/tasks/${task.id}`)).statusCode).toBe(
        404,
      );
      const after = await call(operatorA.cookie, 'GET', '/projects/tasks/my-day');
      expect(after.json().tasks.map((t: { id: string }) => t.id)).not.toContain(task.id);
    });

    it('borrarla de nuevo (con otro client_mutation_id) es 404: ya no existe', async () => {
      const task = await createTask(openProjectId);
      await remove(owner.cookie, task);

      expect((await remove(owner.cookie, task)).statusCode).toBe(404);
    });
  });

  describe('quién borra', () => {
    it.each([
      ['el owner', () => owner],
      ['el director', () => director],
    ])('%s borra', async (_label, who) => {
      const task = await createTask(openProjectId);

      expect((await remove(who().cookie, task)).statusCode).toBe(200);
    });

    it('un manager con acceso completo (proyecto abierto a su sitio) borra', async () => {
      const task = await createTask(openProjectId);

      expect((await remove(manager.cookie, task)).statusCode).toBe(200);
    });

    it('un manager "solo asignado" ve la tarea pero no tiene acceso completo: 403 y no se borra nada', async () => {
      const { root, a } = await createTree(reservedProjectId);
      const own = await createTask(reservedProjectId, {
        assignee_member_id: managerAssigned.memberId,
      });
      void root;
      void a;

      const response = await remove(managerAssigned.cookie, own);

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().data).toMatchObject({
        domain_code: 'task_delete_project_access_forbidden',
      });
      expect((await rowOf(own.id))?.deleted_at).toBeNull();
    });

    it.each([
      ['el operario asignado, sobre su propia tarea', () => operatorA, true],
      ['un operario con acceso completo (miembro explícito)', () => operatorMember, false],
    ])('%s no borra: 403 task_delete_forbidden', async (_label, who, assigned) => {
      const task = await createTask(reservedProjectId, {
        ...(assigned ? { assignee_member_id: operatorA.memberId } : {}),
      });

      const response = await remove(who().cookie, task);

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().data).toMatchObject({ domain_code: 'task_delete_forbidden' });
      expect((await rowOf(task.id))?.deleted_at).toBeNull();
    });

    it('orden 404 → 403 → 409: el operario con una versión vieja recibe 403, no 409', async () => {
      const task = await createTask(openProjectId);
      await call(owner.cookie, 'PATCH', `/projects/tasks/${task.id}`, {
        client_mutation_id: newId(),
        expected_version: task.version,
        title: 'Cambió',
      });

      expect((await remove(operatorA.cookie, task)).statusCode).toBe(403);
    });
  });

  describe('quien no ve la tarea recibe 404', () => {
    it.each([
      ['un operario ajeno', () => outsider],
      ['un manager del sitio de un proyecto reservado donde no es miembro', () => manager],
    ])('%s', async (_label, who) => {
      const task = await createTask(reservedProjectId);

      const response = await remove(who().cookie, task);

      expect(response.statusCode, response.body).toBe(404);
      expect(response.json().data).toMatchObject({ domain_code: 'task_not_found' });
      expect((await rowOf(task.id))?.deleted_at).toBeNull();
    });

    it('otra organización y una tarea inexistente', async () => {
      const task = await createTask(openProjectId);
      const other = await signUpAndCreateOrg(app, 'Otra Constructora');

      expect((await remove(other.cookie, task)).statusCode).toBe(404);
      expect((await remove(owner.cookie, { id: newId(), version: 1 })).statusCode).toBe(404);
      expect((await rowOf(task.id))?.deleted_at).toBeNull();
    });
  });

  describe('concurrencia', () => {
    it('una versión vieja se rechaza con 409 y no borra nada', async () => {
      const { root, a } = await createTree(openProjectId);
      await call(owner.cookie, 'PATCH', `/projects/tasks/${root.id}`, {
        client_mutation_id: newId(),
        expected_version: root.version,
        title: 'Editada',
      });

      const stale = await remove(owner.cookie, root);

      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json().data).toMatchObject({ domain_code: 'task_version_mismatch' });
      expect((await rowOf(root.id))?.deleted_at).toBeNull();
      expect((await rowOf(a.id))?.deleted_at).toBeNull();
    });

    it('colgar una subtarea mientras se borra el padre nunca deja una subtarea viva bajo un padre borrado', async () => {
      for (let round = 0; round < 8; round++) {
        const parent = await createTask(openProjectId, { title: `Padre ${round}` });
        const childId = newId();

        const [deleted, created] = await Promise.all([
          remove(owner.cookie, parent),
          call(owner.cookie, 'POST', '/projects/tasks', {
            client_mutation_id: newId(),
            id: childId,
            project_id: openProjectId,
            parent_task_id: parent.id,
            title: `Hija ${round}`,
          }),
        ]);

        expect(deleted.statusCode, deleted.body).toBe(200);
        // O la hija entró antes y se borró con el padre, o el padre ya estaba borrado y no se la
        // dejó colgar: nunca queda viva.
        expect([200, 404]).toContain(created.statusCode);
        const orphan = await asOwner((tx) =>
          tx.execute(sql`
            select c.id from task c join task p on p.id = c.parent_task_id
             where c.deleted_at is null and p.deleted_at is not null
          `),
        );
        expect(orphan.rows).toEqual([]);
        if (created.statusCode === 200) {
          expect((await rowOf(childId))?.deleted_at).not.toBeNull();
          expect(deleted.json().deleted_task_count).toBe(2);
        }
      }
    });
  });

  describe('idempotencia (ADR-007)', () => {
    it('el mismo client_mutation_id dos veces: la segunda devuelve lo mismo, aunque la tarea ya no se vea', async () => {
      const { root } = await createTree(openProjectId);
      const payload = { client_mutation_id: newId(), expected_version: root.version };
      const url = `/projects/tasks/${root.id}`;

      const first = await call(owner.cookie, 'DELETE', url, payload);
      const retry = await call(owner.cookie, 'DELETE', url, payload);

      expect(first.statusCode, first.body).toBe(200);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toEqual(first.json());
      expect(first.json().deleted_task_count).toBe(4);
    });

    it('dos pedidos simultáneos con el mismo client_mutation_id: los dos responden igual', async () => {
      const { root } = await createTree(openProjectId);
      const payload = { client_mutation_id: newId(), expected_version: root.version };
      const url = `/projects/tasks/${root.id}`;

      const [first, second] = await Promise.all([
        call(owner.cookie, 'DELETE', url, payload),
        call(owner.cookie, 'DELETE', url, payload),
      ]);

      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(first.json().deleted_task_count).toBe(4);
    });

    it('el mismo id de mutación para borrar OTRA tarea: 409, no la respuesta de la primera', async () => {
      const taskA = await createTask(openProjectId);
      const taskB = await createTask(openProjectId);
      const reused = newId();
      await call(owner.cookie, 'DELETE', `/projects/tasks/${taskA.id}`, {
        client_mutation_id: reused,
        expected_version: taskA.version,
      });

      const response = await call(owner.cookie, 'DELETE', `/projects/tasks/${taskB.id}`, {
        client_mutation_id: reused,
        expected_version: taskB.version,
      });

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().data).toMatchObject({ domain_code: 'client_mutation_id_reused' });
      expect((await rowOf(taskB.id))?.deleted_at).toBeNull();
    });
  });

  describe('validación del pedido (CLAUDE.md §9)', () => {
    it('un campo ajeno se rechaza con 400 y se nombra: no se descarta en silencio', async () => {
      const task = await createTask(openProjectId);

      const response = await remove(owner.cookie, task, { cascade: false });

      expect(response.statusCode, response.body).toBe(400);
      expect(response.body).toContain('cascade');
      expect((await rowOf(task.id))?.deleted_at).toBeNull();
    });

    it('sin expected_version es un 400', async () => {
      const task = await createTask(openProjectId);

      const response = await call(owner.cookie, 'DELETE', `/projects/tasks/${task.id}`, {
        client_mutation_id: newId(),
      });

      expect(response.statusCode, response.body).toBe(400);
    });
  });
});
