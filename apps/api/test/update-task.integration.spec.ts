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
 * `update-task`: título, descripción, criticidad y fechas planificadas. Edita
 * `task:update` (owner, director, manager) con acceso completo al proyecto; el
 * operario no, ni su propia tarea. Postgres real, `app_login`.
 */
describe('PATCH /projects/tasks/{id} (integración)', () => {
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
  let operatorAssigned: Person;
  let operatorMember: Person; // miembro explícito del reservado (acceso completo, sin task:update)
  let outsider: Person;

  let openProjectId: string;
  let reservedProjectId: string;

  type TaskBody = {
    id: string;
    version: number;
    title: string;
    description: string | null;
    criticality: string;
    status: string;
    assignee_member_id: string | null;
    planned_start_at: string | null;
    planned_end_at: string | null;
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
      description: 'Cimientos del frente norte',
      ...extra,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<TaskBody>();
  }

  const edit = (cookie: string, task: { id: string; version: number }, fields: object) =>
    call(cookie, 'PATCH', `/projects/tasks/${task.id}`, {
      client_mutation_id: newId(),
      expected_version: task.version,
      ...fields,
    });

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

    const org = await signUpAndCreateOrg(app, 'Constructora Edicion');
    organizationId = org.organizationId;
    const tenant = await resolveTenantIdentity(auth, { cookie: org.cookie });
    if (!tenant) throw new Error('esperaba tenant resuelto tras crear la organización');
    owner = { cookie: org.cookie, memberId: tenant.memberId };

    const add = (role: 'director' | 'manager' | 'operator', label: string) =>
      addMemberWithRole(app, auth, { organizationId, role, label });
    director = await add('director', 'Directora');
    manager = await add('manager', 'Gerente del sitio');
    managerAssigned = await add('manager', 'Gerente asignado');
    operatorAssigned = await add('operator', 'Operario asignado');
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

  describe('qué cambia', () => {
    it('edita título, descripción y criticidad; sube la versión y deja el resto como estaba', async () => {
      const task = await createTask(openProjectId, {
        criticality: 'low',
        planned_start_at: '2026-10-20T08:00',
      });

      const response = await edit(owner.cookie, task, {
        title: '  Excavar y nivelar ',
        description: 'Cimientos y nivelación',
        criticality: 'high',
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        id: task.id,
        title: 'Excavar y nivelar',
        description: 'Cimientos y nivelación',
        criticality: 'high',
        version: task.version + 1,
        status: 'pending',
        planned_start_at: task.planned_start_at,
      });
    });

    it('edición parcial: solo la descripción; el título y lo demás no se tocan', async () => {
      const task = await createTask(openProjectId);

      const response = await edit(owner.cookie, task, { description: 'Otra descripción' });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ title: 'Excavar', description: 'Otra descripción' });
    });

    it('null borra la descripción y las fechas', async () => {
      const task = await createTask(openProjectId, {
        planned_start_at: '2026-10-20T08:00',
        planned_end_at: '2026-10-21T08:00',
      });

      const response = await edit(owner.cookie, task, {
        description: null,
        planned_start_at: null,
        planned_end_at: null,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        description: null,
        planned_start_at: null,
        planned_end_at: null,
      });
    });

    it.each([
      ['status', 'done'],
      ['assignee_member_id', 'alguien'],
      ['parent_task_id', '01945f4e-0000-7000-8000-000000000009'],
      ['campo_inventado', 1],
    ])(
      'un campo que no se edita acá (%s) se rechaza con 400 y se nombra, sin cambiar nada',
      async (field, value) => {
        const task = await createTask(openProjectId, { assignee_member_id: manager.memberId });

        const response = await edit(owner.cookie, task, {
          title: 'Solo el título',
          [field]: value,
        });

        expect(response.statusCode, response.body).toBe(400);
        // El cliente tiene que enterarse de cuál campo no se aplicó.
        expect(response.body).toContain(field);
        const read = await call(owner.cookie, 'GET', `/projects/tasks/${task.id}`);
        expect(read.json()).toMatchObject({
          title: 'Excavar',
          version: task.version,
          status: 'pending',
          assignee_member_id: manager.memberId,
          parent_task_id: null,
        });
      },
    );

    it('si vienen varios campos ajenos, los nombra a todos', async () => {
      const task = await createTask(openProjectId);

      const response = await edit(owner.cookie, task, {
        title: 'X',
        status: 'done',
        assignee_member_id: 'alguien',
      });

      expect(response.statusCode, response.body).toBe(400);
      expect(response.body).toContain('status');
      expect(response.body).toContain('assignee_member_id');
    });

    it('un pedido sin ningún campo editable se rechaza con 400', async () => {
      const task = await createTask(openProjectId);

      expect((await edit(owner.cookie, task, {})).statusCode).toBe(400);
    });

    it('un título vacío se rechaza con 400', async () => {
      const task = await createTask(openProjectId);

      expect((await edit(owner.cookie, task, { title: '   ' })).statusCode).toBe(400);
    });
  });

  describe('tareas congeladas (ADR-012)', () => {
    const changeStatus = (
      cookie: string,
      task: { id: string; version: number },
      toStatus: string,
      extra: object = {},
    ) =>
      call(cookie, 'PATCH', `/projects/tasks/${task.id}/status`, {
        client_mutation_id: newId(),
        to_status: toStatus,
        expected_version: task.version,
        ...extra,
      });

    it('una tarea cancelada responde 422 task_edit_cancelled y no cambia nada', async () => {
      const task = await createTask(openProjectId);
      const cancelled = await changeStatus(owner.cookie, task, 'cancelled', {
        reason: 'Se canceló la obra',
      });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      const version = cancelled.json().version;

      const response = await edit(owner.cookie, { id: task.id, version }, { title: 'Reabierta' });

      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().data).toMatchObject({ domain_code: 'task_edit_cancelled' });
      const read = await call(owner.cookie, 'GET', `/projects/tasks/${task.id}`);
      expect(read.json()).toMatchObject({ title: 'Excavar', version, status: 'cancelled' });
    });

    it('tampoco un pedido sin cambios reales ni con una versión vieja: 422, no 409', async () => {
      const task = await createTask(openProjectId);
      const cancelled = await changeStatus(owner.cookie, task, 'cancelled', {
        reason: 'Se canceló la obra',
      });
      const version = cancelled.json().version;

      const same = await edit(owner.cookie, { id: task.id, version }, { title: 'Excavar' });
      const stale = await edit(owner.cookie, task, { title: 'Nuevo' });

      expect(same.statusCode, same.body).toBe(422);
      expect(stale.statusCode, stale.body).toBe(422);
    });

    it('quien no puede editar recibe 403 aunque esté cancelada: no se entera de su estado', async () => {
      const task = await createTask(reservedProjectId, {
        assignee_member_id: operatorAssigned.memberId,
      });
      const cancelled = await changeStatus(owner.cookie, task, 'cancelled', {
        reason: 'Se canceló la obra',
      });

      const response = await edit(
        operatorAssigned.cookie,
        { id: task.id, version: cancelled.json().version },
        { title: 'X' },
      );

      expect(response.statusCode, response.body).toBe(403);
    });

    it('una tarea done sí se edita: se puede reabrir', async () => {
      const task = await createTask(openProjectId);
      const started = await changeStatus(owner.cookie, task, 'in_progress');
      expect(started.statusCode, started.body).toBe(200);
      const done = await changeStatus(
        owner.cookie,
        { id: task.id, version: started.json().version },
        'done',
      );
      expect(done.statusCode, done.body).toBe(200);

      const response = await edit(
        owner.cookie,
        { id: task.id, version: done.json().version },
        { title: 'Corregida después de terminar' },
      );

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        title: 'Corregida después de terminar',
        status: 'done',
      });
    });
  });

  describe('fechas en la zona horaria del sitio (ADR-008)', () => {
    it('la hora de pared se convierte a UTC con la zona del sitio (Buenos Aires, UTC-3)', async () => {
      const task = await createTask(openProjectId);

      const response = await edit(owner.cookie, task, {
        planned_start_at: '2026-10-22T08:00',
        planned_end_at: '2026-10-22T18:30',
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        planned_start_at: '2026-10-22T11:00:00.000Z',
        planned_end_at: '2026-10-22T21:30:00.000Z',
      });
    });

    it('una zona con otro desfase da otro instante (la del sitio, no la del servidor)', async () => {
      const task = await createTask(openProjectId);
      await withTenantTransaction(
        db,
        { organizationId, memberId: owner.memberId, requestId: newId() },
        (tx) =>
          tx.execute(sql`
            update site set timezone = 'America/Bogota'
             where id = (select site_id from project where id = ${openProjectId})
          `),
      );

      const response = await edit(owner.cookie, task, { planned_start_at: '2026-10-22T08:00' });

      // Bogotá es UTC-5.
      expect(response.json().planned_start_at).toBe('2026-10-22T13:00:00.000Z');
      await withTenantTransaction(
        db,
        { organizationId, memberId: owner.memberId, requestId: newId() },
        (tx) =>
          tx.execute(sql`
            update site set timezone = 'America/Argentina/Buenos_Aires'
             where id = (select site_id from project where id = ${openProjectId})
          `),
      );
    });

    it('un fin anterior al inicio se rechaza con 422 task_dates_incoherent y no cambia nada', async () => {
      const task = await createTask(openProjectId, { planned_start_at: '2026-10-22T08:00' });

      const response = await edit(owner.cookie, task, { planned_end_at: '2026-10-21T08:00' });

      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().data).toMatchObject({ domain_code: 'task_dates_incoherent' });
      const read = await call(owner.cookie, 'GET', `/projects/tasks/${task.id}`);
      expect(read.json()).toMatchObject({ version: task.version, planned_end_at: null });
    });

    it('al mover solo el inicio se evalúa contra el fin que la tarea ya tiene', async () => {
      const task = await createTask(openProjectId, {
        planned_start_at: '2026-10-22T08:00',
        planned_end_at: '2026-10-22T18:00',
      });

      const response = await edit(owner.cookie, task, { planned_start_at: '2026-10-23T08:00' });

      expect(response.statusCode, response.body).toBe(422);
    });
  });

  describe('un pedido sin cambios reales no escribe', () => {
    it('repetir los valores actuales devuelve la tarea igual: misma versión y sin entrada en el audit', async () => {
      const task = await createTask(openProjectId, { planned_start_at: '2026-10-22T08:00' });
      const before = await auditOf(task.id);

      const response = await edit(owner.cookie, task, {
        title: task.title,
        description: task.description,
        criticality: task.criticality,
        planned_start_at: '2026-10-22T08:00',
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ version: task.version, title: task.title });
      expect(await auditOf(task.id)).toEqual(before);
    });

    it('un cambio real deja una sola entrada de audit con solo las columnas que cambiaron', async () => {
      const task = await createTask(openProjectId);

      const response = await edit(owner.cookie, task, {
        title: 'Nuevo título',
        criticality: 'high',
      });
      expect(response.statusCode, response.body).toBe(200);

      const entries = await auditOf(task.id);
      expect(entries.map((entry) => entry.action)).toEqual(['insert', 'update']);
      expect(entries[1]).toMatchObject({
        actor_member_id: owner.memberId,
        changed: { title: ['Excavar', 'Nuevo título'], criticality: ['normal', 'high'] },
      });
    });
  });

  describe('concurrencia', () => {
    it('una versión vieja se rechaza con 409 y no cambia nada', async () => {
      const task = await createTask(openProjectId);
      await edit(owner.cookie, task, { title: 'Primero' });

      const stale = await edit(owner.cookie, task, { title: 'Pisando' });

      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json().data).toMatchObject({ domain_code: 'task_version_mismatch' });
      const read = await call(owner.cookie, 'GET', `/projects/tasks/${task.id}`);
      expect(read.json().title).toBe('Primero');
    });

    it('dos ediciones con la misma versión: gana una y la otra recibe 409 (no se mezclan)', async () => {
      const task = await createTask(openProjectId);

      const [first, second] = await Promise.all([
        edit(owner.cookie, task, { title: 'Del owner' }),
        edit(director.cookie, task, { description: 'De la directora' }),
      ]);

      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
      const read = await call(owner.cookie, 'GET', `/projects/tasks/${task.id}`);
      // Solo un cambio se aplicó: el otro no se mezcló encima.
      const changed = [
        read.json().title !== 'Excavar',
        read.json().description !== 'Cimientos del frente norte',
      ].filter(Boolean);
      expect(changed).toHaveLength(1);
    });
  });

  describe('idempotencia (ADR-007)', () => {
    it('el mismo client_mutation_id dos veces: un solo efecto y la misma respuesta', async () => {
      const task = await createTask(openProjectId);
      const payload = {
        client_mutation_id: newId(),
        expected_version: task.version,
        title: 'Una sola vez',
      };

      const first = await call(owner.cookie, 'PATCH', `/projects/tasks/${task.id}`, payload);
      const retry = await call(owner.cookie, 'PATCH', `/projects/tasks/${task.id}`, payload);

      expect(first.statusCode, first.body).toBe(200);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toEqual(first.json());
      expect(retry.json().version).toBe(task.version + 1);
    });

    it('dos pedidos simultáneos con el mismo client_mutation_id: los dos responden igual y la versión sube una vez', async () => {
      const task = await createTask(openProjectId);
      const payload = {
        client_mutation_id: newId(),
        expected_version: task.version,
        title: 'Simultáneo',
      };

      const [first, second] = await Promise.all([
        call(owner.cookie, 'PATCH', `/projects/tasks/${task.id}`, payload),
        call(owner.cookie, 'PATCH', `/projects/tasks/${task.id}`, payload),
      ]);

      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(first.json().version).toBe(task.version + 1);
    });

    it('el mismo id de mutación para editar OTRA tarea: 409, no la respuesta de la primera', async () => {
      const taskA = await createTask(openProjectId);
      const taskB = await createTask(openProjectId);
      const reused = newId();
      await call(owner.cookie, 'PATCH', `/projects/tasks/${taskA.id}`, {
        client_mutation_id: reused,
        expected_version: taskA.version,
        title: 'En A',
      });

      const response = await call(owner.cookie, 'PATCH', `/projects/tasks/${taskB.id}`, {
        client_mutation_id: reused,
        expected_version: taskB.version,
        title: 'En B',
      });

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().data).toMatchObject({ domain_code: 'client_mutation_id_reused' });
    });
  });

  describe('quién edita', () => {
    it.each([
      ['el owner', () => owner],
      ['el director', () => director],
    ])('%s edita', async (_label, who) => {
      const task = await createTask(openProjectId);

      const response = await edit(who().cookie, task, { title: 'Editada' });

      expect(response.statusCode, response.body).toBe(200);
    });

    it('un manager con acceso completo (proyecto abierto a su sitio) edita', async () => {
      const task = await createTask(openProjectId);

      const response = await edit(manager.cookie, task, { criticality: 'critical' });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().criticality).toBe('critical');
    });

    it('un manager "solo asignado" ve la tarea pero no tiene acceso completo: 403', async () => {
      const task = await createTask(reservedProjectId, {
        assignee_member_id: managerAssigned.memberId,
      });

      const response = await edit(managerAssigned.cookie, task, { title: 'No debería' });

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().data).toMatchObject({
        domain_code: 'task_edit_project_access_forbidden',
      });
    });

    it('el operario no edita ni su propia tarea: 403', async () => {
      const task = await createTask(reservedProjectId, {
        assignee_member_id: operatorAssigned.memberId,
      });

      const response = await edit(operatorAssigned.cookie, task, { title: 'Mía' });

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().data).toMatchObject({ domain_code: 'task_edit_forbidden' });
      const read = await call(owner.cookie, 'GET', `/projects/tasks/${task.id}`);
      expect(read.json().title).toBe('Excavar');
    });

    it('un operario con acceso completo (miembro explícito) tampoco: 403', async () => {
      const task = await createTask(reservedProjectId);

      const response = await edit(operatorMember.cookie, task, { title: 'No' });

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().data).toMatchObject({ domain_code: 'task_edit_forbidden' });
    });

    it('orden 404 → 403 → 409: el operario con una versión vieja recibe 403, no 409', async () => {
      const task = await createTask(reservedProjectId, {
        assignee_member_id: operatorAssigned.memberId,
      });
      await edit(owner.cookie, task, { title: 'Cambió' });

      const response = await edit(operatorAssigned.cookie, task, { title: 'Mía' });

      expect(response.statusCode, response.body).toBe(403);
    });
  });

  describe('quien no ve la tarea recibe 404', () => {
    it.each([
      ['un operario ajeno', () => outsider],
      ['un manager del sitio de un proyecto reservado donde no es miembro', () => manager],
    ])('%s', async (_label, who) => {
      const task = await createTask(reservedProjectId);

      const response = await edit(who().cookie, task, { title: 'No la veo' });

      expect(response.statusCode, response.body).toBe(404);
      expect(response.json().data).toMatchObject({ domain_code: 'task_not_found' });
    });

    it('otra organización', async () => {
      const task = await createTask(openProjectId);
      const other = await signUpAndCreateOrg(app, 'Otra Constructora');

      expect((await edit(other.cookie, task, { title: 'X' })).statusCode).toBe(404);
    });

    it('una tarea borrada y una que no existe', async () => {
      const task = await createTask(openProjectId);
      await withTenantTransaction(
        db,
        { organizationId, memberId: owner.memberId, requestId: newId() },
        (tx) => tx.execute(sql`update task set deleted_at = now() where id = ${task.id}`),
      );

      expect((await edit(owner.cookie, task, { title: 'X' })).statusCode).toBe(404);
      expect(
        (await edit(owner.cookie, { id: newId(), version: 1 }, { title: 'X' })).statusCode,
      ).toBe(404);
    });
  });
});
