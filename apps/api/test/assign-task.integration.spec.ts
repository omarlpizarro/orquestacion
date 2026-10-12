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
 * `assign-task`: asignar, reasignar y desasignar el responsable. Asigna `task:assign`
 * (owner, director, manager) con acceso completo al proyecto; el responsable tiene que
 * ser asignable (ADR-017 §8). Postgres real, `app_login`.
 */
describe('PATCH /projects/tasks/{id}/assignee (integración)', () => {
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
  let operatorB: Person;
  let operatorMember: Person; // miembro explícito del reservado
  let outsider: Person;

  let openProjectId: string;
  let reservedProjectId: string;
  let farProjectId: string; // en un segundo sitio al que los operarios no tienen acceso

  type TaskBody = {
    id: string;
    version: number;
    assignee_member_id: string | null;
    status: string;
    title: string;
  };

  function call(cookie: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) {
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

  async function createProject(visibility: 'reserved' | 'site', code: string, siteId?: string) {
    const id = newId();
    const response = await call(owner.cookie, 'POST', '/projects', {
      client_mutation_id: newId(),
      id,
      code,
      name: code,
      visibility,
      ...(siteId ? { site_id: siteId } : {}),
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

  const assign = (
    cookie: string,
    task: { id: string; version: number },
    assigneeMemberId: string | null,
    extra: object = {},
  ) =>
    call(cookie, 'PATCH', `/projects/tasks/${task.id}/assignee`, {
      client_mutation_id: newId(),
      expected_version: task.version,
      assignee_member_id: assigneeMemberId,
      ...extra,
    });

  const seesTask = async (person: Person, taskId: string) =>
    (await call(person.cookie, 'GET', `/projects/tasks/${taskId}`)).statusCode === 200;

  async function auditOf(taskId: string) {
    const result = await withTenantTransaction(
      db,
      { organizationId, memberId: owner.memberId, requestId: newId() },
      (tx) =>
        tx.execute<{
          action: string;
          actor_member_id: string;
          changed: Record<string, unknown>;
        }>(sql`
          select action, actor_member_id, changed from audit_log
           where entity_type = 'task' and entity_id = ${taskId} order by id
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

    const org = await signUpAndCreateOrg(app, 'Constructora Asignacion');
    organizationId = org.organizationId;
    const tenant = await resolveTenantIdentity(auth, { cookie: org.cookie });
    if (!tenant) throw new Error('esperaba tenant resuelto tras crear la organización');
    owner = { cookie: org.cookie, memberId: tenant.memberId };

    const add = (role: 'director' | 'manager' | 'operator', label: string) =>
      addMemberWithRole(app, auth, { organizationId, role, label });
    director = await add('director', 'Directora');
    manager = await add('manager', 'Gerente del sitio');
    managerAssigned = await add('manager', 'Gerente asignado');
    operatorA = await add('operator', 'Operario A');
    operatorB = await add('operator', 'Operario B');
    operatorMember = await add('operator', 'Operario miembro');
    outsider = await add('operator', 'Operario ajeno');

    // `organization_profile` no lo crea Better Auth: Mi Día resuelve la zona de quien consulta con ella.
    await withTenantTransaction(
      db,
      { organizationId, memberId: owner.memberId, requestId: newId() },
      (tx) =>
        tx.execute(sql`
          insert into organization_profile (organization_id, industry)
          values (${organizationId}, 'construccion')
        `),
    );

    // Un segundo sitio: con dos sitios ya nadie recibe acceso automático a él (ADR-016).
    const farSiteId = newId();
    await withTenantTransaction(
      db,
      { organizationId, memberId: owner.memberId, requestId: newId() },
      (tx) =>
        tx.execute(sql`
          insert into site (id, organization_id, name, timezone)
          values (${farSiteId}, ${organizationId}, 'Campo lejano', 'America/Argentina/Buenos_Aires')
        `),
    );
    const sites = await withTenantTransaction(
      db,
      { organizationId, memberId: owner.memberId, requestId: newId() },
      (tx) => tx.execute<{ id: string }>(sql`select id from site where id <> ${farSiteId} limit 1`),
    );
    const mainSiteId = sites.rows[0]?.id;

    openProjectId = await createProject('site', 'PRY-ABIERTO', mainSiteId);
    reservedProjectId = await createProject('reserved', 'PRY-RESERVADO', mainSiteId);
    farProjectId = await createProject('site', 'PRY-LEJANO', farSiteId);
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

  describe('asignar, reasignar y desasignar', () => {
    it('asigna a un operario: sube la versión, queda en el audit y el operario pasa a ver la tarea', async () => {
      const task = await createTask(reservedProjectId);
      expect(await seesTask(operatorA, task.id)).toBe(false);

      const response = await assign(owner.cookie, task, operatorA.memberId);

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        id: task.id,
        assignee_member_id: operatorA.memberId,
        version: task.version + 1,
        title: 'Excavar',
        status: 'pending',
      });
      const entries = await auditOf(task.id);
      expect(entries.map((entry) => entry.action)).toEqual(['insert', 'update']);
      expect(entries[1]).toMatchObject({
        actor_member_id: owner.memberId,
        changed: { assignee_member_id: [null, operatorA.memberId] },
      });
      // "Solo asignado": ve su tarea (con el proyecto en nivel reducido) y le aparece en Mi Día.
      expect(await seesTask(operatorA, task.id)).toBe(true);
      const myDay = await call(operatorA.cookie, 'GET', '/projects/tasks/my-day');
      expect(myDay.json().tasks.map((t: { id: string }) => t.id)).toContain(task.id);
    });

    it('reasignar le quita el acceso al anterior (se deriva, no se guarda) y se lo da al nuevo', async () => {
      const task = await createTask(reservedProjectId, { assignee_member_id: operatorA.memberId });
      expect(await seesTask(operatorA, task.id)).toBe(true);

      const response = await assign(owner.cookie, task, operatorB.memberId);

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().assignee_member_id).toBe(operatorB.memberId);
      expect(await seesTask(operatorA, task.id)).toBe(false);
      expect(await seesTask(operatorB, task.id)).toBe(true);
      const entries = await auditOf(task.id);
      expect(entries.at(-1)?.changed).toEqual({
        assignee_member_id: [operatorA.memberId, operatorB.memberId],
      });
    });

    it('null desasigna', async () => {
      const task = await createTask(reservedProjectId, { assignee_member_id: operatorA.memberId });

      const response = await assign(owner.cookie, task, null);

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().assignee_member_id).toBeNull();
      expect(await seesTask(operatorA, task.id)).toBe(false);
    });

    it('pedir el responsable que ya tiene no escribe: misma versión y sin entrada en el audit', async () => {
      const task = await createTask(reservedProjectId, { assignee_member_id: operatorA.memberId });
      const before = await auditOf(task.id);

      const same = await assign(owner.cookie, task, operatorA.memberId);
      const noneToNone = await assign(owner.cookie, await createTask(openProjectId), null);

      expect(same.statusCode, same.body).toBe(200);
      expect(same.json().version).toBe(task.version);
      expect(await auditOf(task.id)).toEqual(before);
      expect(noneToNone.statusCode, noneToNone.body).toBe(200);
      expect(noneToNone.json().version).toBe(1);
    });

    it('no toca nada más: el estado y los datos quedan como estaban', async () => {
      const task = await createTask(openProjectId, {
        description: 'Cimientos',
        criticality: 'high',
      });

      const response = await assign(owner.cookie, task, operatorA.memberId);

      expect(response.json()).toMatchObject({
        status: 'pending',
        description: 'Cimientos',
        criticality: 'high',
        title: 'Excavar',
      });
    });
  });

  describe('a quién se puede asignar (ADR-017 §8)', () => {
    it('un miembro de otra organización: 422 assignee_not_assignable, sin distinguirlo de "no existe"', async () => {
      const task = await createTask(openProjectId);
      const other = await signUpAndCreateOrg(app, 'Otra Constructora');
      const otherTenant = await resolveTenantIdentity(auth, { cookie: other.cookie });

      const foreign = await assign(owner.cookie, task, otherTenant?.memberId ?? 'x');
      const missing = await assign(owner.cookie, task, 'miembro_que_no_existe');

      for (const response of [foreign, missing]) {
        expect(response.statusCode, response.body).toBe(422);
        expect(response.json().data).toMatchObject({ domain_code: 'assignee_not_assignable' });
        expect(response.json().message).toBe(foreign.json().message);
      }
      const read = await call(owner.cookie, 'GET', `/projects/tasks/${task.id}`);
      expect(read.json().assignee_member_id).toBeNull();
    });

    it('quien no trabaja en el sitio del proyecto: 422, salvo que sea miembro explícito', async () => {
      const task = await createTask(farProjectId);

      const refused = await assign(owner.cookie, task, operatorA.memberId);
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json().data).toMatchObject({ domain_code: 'assignee_not_assignable' });

      const added = await call(owner.cookie, 'POST', `/projects/${farProjectId}/members`, {
        client_mutation_id: newId(),
        member_id: operatorA.memberId,
      });
      expect(added.statusCode, added.body).toBe(200);
      const accepted = await assign(owner.cookie, task, operatorA.memberId);
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json().assignee_member_id).toBe(operatorA.memberId);
    });

    it('owner y director son asignables en cualquier sitio, sin filas de acceso', async () => {
      const task = await createTask(farProjectId);

      const toOwner = await assign(owner.cookie, task, director.memberId);

      expect(toOwner.statusCode, toOwner.body).toBe(200);
    });
  });

  describe('quién asigna', () => {
    it.each([
      ['el owner', () => owner],
      ['el director', () => director],
    ])('%s asigna', async (_label, who) => {
      const task = await createTask(openProjectId);

      const response = await assign(who().cookie, task, operatorA.memberId);

      expect(response.statusCode, response.body).toBe(200);
    });

    it('un manager con acceso completo (proyecto abierto a su sitio) asigna', async () => {
      const task = await createTask(openProjectId);

      const response = await assign(manager.cookie, task, operatorB.memberId);

      expect(response.statusCode, response.body).toBe(200);
    });

    it('un manager "solo asignado" ve la tarea pero no tiene acceso completo: 403', async () => {
      const task = await createTask(reservedProjectId, {
        assignee_member_id: managerAssigned.memberId,
      });

      const response = await assign(managerAssigned.cookie, task, operatorA.memberId);

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().data).toMatchObject({
        domain_code: 'task_assign_project_access_forbidden',
      });
    });

    it.each([
      ['el operario asignado, sobre su propia tarea', () => operatorA, 'asignada'],
      ['un operario con acceso completo (miembro explícito)', () => operatorMember, 'cualquiera'],
    ])('%s no asigna: 403 task_assign_forbidden', async (_label, who, _kind) => {
      const task = await createTask(reservedProjectId, { assignee_member_id: operatorA.memberId });

      const response = await assign(who().cookie, task, operatorB.memberId);

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().data).toMatchObject({ domain_code: 'task_assign_forbidden' });
      const read = await call(owner.cookie, 'GET', `/projects/tasks/${task.id}`);
      expect(read.json().assignee_member_id).toBe(operatorA.memberId);
    });

    it('un operario no puede "tomar" una tarea sin responsable para sí', async () => {
      const task = await createTask(openProjectId);

      const response = await assign(operatorA.cookie, task, operatorA.memberId);

      expect(response.statusCode, response.body).toBe(403);
    });

    it('orden 404 → 403 → 409: el operario con una versión vieja recibe 403, no 409', async () => {
      const task = await createTask(openProjectId);
      await assign(owner.cookie, task, operatorB.memberId);

      const response = await assign(operatorA.cookie, task, operatorA.memberId);

      expect(response.statusCode, response.body).toBe(403);
    });
  });

  describe('quien no ve la tarea recibe 404', () => {
    it.each([
      ['un operario ajeno', () => outsider],
      ['un manager del sitio de un proyecto reservado donde no es miembro', () => manager],
    ])('%s', async (_label, who) => {
      const task = await createTask(reservedProjectId);

      const response = await assign(who().cookie, task, operatorA.memberId);

      expect(response.statusCode, response.body).toBe(404);
      expect(response.json().data).toMatchObject({ domain_code: 'task_not_found' });
    });

    it('otra organización, una tarea borrada y una inexistente', async () => {
      const task = await createTask(openProjectId);
      const other = await signUpAndCreateOrg(app, 'Tercera Constructora');
      expect((await assign(other.cookie, task, null)).statusCode).toBe(404);

      await withTenantTransaction(
        db,
        { organizationId, memberId: owner.memberId, requestId: newId() },
        (tx) => tx.execute(sql`update task set deleted_at = now() where id = ${task.id}`),
      );
      expect((await assign(owner.cookie, task, operatorA.memberId)).statusCode).toBe(404);
      expect(
        (await assign(owner.cookie, { id: newId(), version: 1 }, operatorA.memberId)).statusCode,
      ).toBe(404);
    });
  });

  describe('estados', () => {
    const changeStatus = (
      task: { id: string; version: number },
      toStatus: string,
      extra: object = {},
    ) =>
      call(owner.cookie, 'PATCH', `/projects/tasks/${task.id}/status`, {
        client_mutation_id: newId(),
        to_status: toStatus,
        expected_version: task.version,
        ...extra,
      });

    it('una cancelada está congelada: 422 task_assign_cancelled', async () => {
      const task = await createTask(openProjectId, { assignee_member_id: operatorA.memberId });
      const cancelled = await changeStatus(task, 'cancelled', { reason: 'Se canceló la obra' });
      expect(cancelled.statusCode, cancelled.body).toBe(200);

      const response = await assign(
        owner.cookie,
        { id: task.id, version: cancelled.json().version },
        operatorB.memberId,
      );

      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().data).toMatchObject({ domain_code: 'task_assign_cancelled' });
    });

    it('una done se puede reasignar: se puede reabrir', async () => {
      const task = await createTask(openProjectId);
      const started = await changeStatus(task, 'in_progress');
      const done = await changeStatus({ id: task.id, version: started.json().version }, 'done');
      expect(done.statusCode, done.body).toBe(200);

      const response = await assign(
        owner.cookie,
        { id: task.id, version: done.json().version },
        operatorB.memberId,
      );

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'done',
        assignee_member_id: operatorB.memberId,
      });
    });
  });

  describe('concurrencia: en asignaciones gana el servidor (§9)', () => {
    it('una versión vieja se rechaza con 409 y no cambia nada', async () => {
      const task = await createTask(openProjectId);
      await assign(owner.cookie, task, operatorA.memberId);

      const stale = await assign(owner.cookie, task, operatorB.memberId);

      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json().data).toMatchObject({ domain_code: 'task_version_mismatch' });
      const read = await call(owner.cookie, 'GET', `/projects/tasks/${task.id}`);
      expect(read.json().assignee_member_id).toBe(operatorA.memberId);
    });

    it('dos asignaciones a la vez sobre la misma versión: gana una, la otra recibe 409', async () => {
      const task = await createTask(openProjectId);

      const [first, second] = await Promise.all([
        assign(owner.cookie, task, operatorA.memberId),
        assign(director.cookie, task, operatorB.memberId),
      ]);

      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    });
  });

  describe('idempotencia (ADR-007)', () => {
    it('el mismo client_mutation_id dos veces: un solo efecto y la misma respuesta', async () => {
      const task = await createTask(openProjectId);
      const payload = {
        client_mutation_id: newId(),
        expected_version: task.version,
        assignee_member_id: operatorA.memberId,
      };
      const url = `/projects/tasks/${task.id}/assignee`;

      const first = await call(owner.cookie, 'PATCH', url, payload);
      const retry = await call(owner.cookie, 'PATCH', url, payload);

      expect(first.statusCode, first.body).toBe(200);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toEqual(first.json());
      expect(first.json().version).toBe(task.version + 1);
      expect(await auditOf(task.id)).toHaveLength(2);
    });

    it('dos pedidos simultáneos con el mismo client_mutation_id: los dos responden igual', async () => {
      const task = await createTask(openProjectId);
      const payload = {
        client_mutation_id: newId(),
        expected_version: task.version,
        assignee_member_id: operatorB.memberId,
      };
      const url = `/projects/tasks/${task.id}/assignee`;

      const [first, second] = await Promise.all([
        call(owner.cookie, 'PATCH', url, payload),
        call(owner.cookie, 'PATCH', url, payload),
      ]);

      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(first.json().version).toBe(task.version + 1);
    });

    it('el mismo id de mutación para asignar OTRA tarea: 409, no la respuesta de la primera', async () => {
      const taskA = await createTask(openProjectId);
      const taskB = await createTask(openProjectId);
      const reused = newId();
      await call(owner.cookie, 'PATCH', `/projects/tasks/${taskA.id}/assignee`, {
        client_mutation_id: reused,
        expected_version: taskA.version,
        assignee_member_id: operatorA.memberId,
      });

      const response = await call(owner.cookie, 'PATCH', `/projects/tasks/${taskB.id}/assignee`, {
        client_mutation_id: reused,
        expected_version: taskB.version,
        assignee_member_id: operatorA.memberId,
      });

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().data).toMatchObject({ domain_code: 'client_mutation_id_reused' });
    });
  });

  describe('validación del pedido (CLAUDE.md §9)', () => {
    it('omitir assignee_member_id es un 400, no "no cambiar"', async () => {
      const task = await createTask(openProjectId);

      const response = await call(owner.cookie, 'PATCH', `/projects/tasks/${task.id}/assignee`, {
        client_mutation_id: newId(),
        expected_version: task.version,
      });

      expect(response.statusCode, response.body).toBe(400);
    });

    it('un campo ajeno se rechaza con 400 y se nombra: no se descarta en silencio', async () => {
      const task = await createTask(openProjectId);

      const response = await assign(owner.cookie, task, operatorA.memberId, {
        title: 'Otro título',
        status: 'done',
      });

      expect(response.statusCode, response.body).toBe(400);
      expect(response.body).toContain('title');
      expect(response.body).toContain('status');
      const read = await call(owner.cookie, 'GET', `/projects/tasks/${task.id}`);
      expect(read.json()).toMatchObject({ title: 'Excavar', assignee_member_id: null });
    });
  });
});
