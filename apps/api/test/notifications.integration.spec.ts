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
 * Avisos dentro de la app (ADR-019): los que la API crea en la transacción de la mutación
 * (asignación, creación con responsable, el aviso al responsable de un bloqueo), la bandeja
 * que deja para el worker, y los dos endpoints de lectura. Postgres real, `app_login`.
 */
describe('avisos (integración)', () => {
  let harness: PostgresHarness;
  let app: NestFastifyApplication;
  let auth: Auth;
  let db: Db;

  let organizationId: string;
  type Person = { cookie: string; memberId: string };
  let owner: Person;
  let manager: Person;
  let operatorA: Person;
  let operatorB: Person;
  let operatorMember: Person; // miembro explícito del reservado

  let openProjectId: string;
  let reservedProjectId: string;

  type TaskBody = { id: string; version: number; assignee_member_id: string | null };
  type NotificationBody = {
    id: string;
    template_key: string;
    task_id: string | null;
    project_id: string | null;
    payload: { task_title: string; actor_member_id: string; reason_preview?: string };
    created_at: string;
    read_at: string | null;
  };
  type ListBody = {
    notifications: NotificationBody[];
    next_cursor: string | null;
    unread_count: number;
  };

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

  async function createProject(visibility: 'reserved' | 'site', code: string, siteId: string) {
    const id = newId();
    const response = await call(owner.cookie, 'POST', '/projects', {
      client_mutation_id: newId(),
      id,
      code,
      name: code,
      visibility,
      site_id: siteId,
    });
    expect(response.statusCode, response.body).toBe(200);
    return id;
  }

  async function createTask(
    project: string,
    extra: Record<string, unknown> = {},
    by: Person = owner,
  ) {
    const response = await call(by.cookie, 'POST', '/projects/tasks', {
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

  const block = (
    cookie: string,
    task: { id: string; version: number },
    reason: string | null = 'Falta el permiso municipal',
    extra: object = {},
  ) =>
    call(cookie, 'PATCH', `/projects/tasks/${task.id}/status`, {
      client_mutation_id: newId(),
      expected_version: task.version,
      to_status: 'blocked',
      ...(reason === null ? {} : { reason }),
      ...extra,
    });

  async function list(person: Person, query = ''): Promise<ListBody> {
    const response = await call(person.cookie, 'GET', `/notifications${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<ListBody>();
  }

  const forTask = (body: ListBody, taskId: string) =>
    body.notifications.filter((notification) => notification.task_id === taskId);

  const markRead = (person: Person, id: string, extra: object = {}) =>
    call(person.cookie, 'POST', `/notifications/${id}/read`, {
      client_mutation_id: newId(),
      ...extra,
    });

  /** La bandeja de la organización, leída con la identidad del dueño (RLS por organización). */
  async function outboxRows() {
    const result = await withTenantTransaction(
      db,
      { organizationId, memberId: owner.memberId, requestId: newId() },
      (tx) =>
        tx.execute<{
          id: string;
          kind: string;
          entity_id: string;
          processed_at: string | null;
          created_by_member_id: string;
        }>(sql`
          select id, kind, entity_id, processed_at, created_by_member_id
            from notification_outbox order by created_at, id
        `),
    );
    return result.rows;
  }

  async function blockReportsOf(taskId: string) {
    const result = await withTenantTransaction(
      db,
      { organizationId, memberId: owner.memberId, requestId: newId() },
      (tx) =>
        tx.execute<{ id: string; body: string }>(sql`
          select id, body from task_update
           where task_id = ${taskId} and kind = 'block_report' and deleted_at is null
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

    const org = await signUpAndCreateOrg(app, 'Constructora Avisos');
    organizationId = org.organizationId;
    const tenant = await resolveTenantIdentity(auth, { cookie: org.cookie });
    if (!tenant) throw new Error('esperaba tenant resuelto tras crear la organización');
    owner = { cookie: org.cookie, memberId: tenant.memberId };

    const add = (role: 'manager' | 'operator', label: string) =>
      addMemberWithRole(app, auth, { organizationId, role, label });
    manager = await add('manager', 'Gerente');
    operatorA = await add('operator', 'Operario A');
    operatorB = await add('operator', 'Operario B');
    operatorMember = await add('operator', 'Operario miembro');

    const sites = await withTenantTransaction(
      db,
      { organizationId, memberId: owner.memberId, requestId: newId() },
      (tx) => tx.execute<{ id: string }>(sql`select id from site limit 1`),
    );
    const siteId = sites.rows[0]?.id;
    if (!siteId) throw new Error('esperaba el sitio por defecto de la organización');

    openProjectId = await createProject('site', 'PRY-ABIERTO', siteId);
    reservedProjectId = await createProject('reserved', 'PRY-RESERVADO', siteId);
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

  describe('asignación', () => {
    it('asignar a un operario le crea un aviso que SOLO él ve, aunque la tarea sea de un proyecto reservado', async () => {
      const task = await createTask(reservedProjectId);

      const response = await assign(owner.cookie, task, operatorA.memberId);
      expect(response.statusCode, response.body).toBe(200);

      const mine = forTask(await list(operatorA), task.id);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        template_key: 'task.assigned',
        task_id: task.id,
        project_id: reservedProjectId,
        payload: { task_title: 'Excavar', actor_member_id: owner.memberId },
        read_at: null,
      });
      // Nadie más lo ve: ni otro operario, ni quien asignó (el owner, privilegiado), ni el miembro explícito.
      for (const other of [operatorB, owner, operatorMember]) {
        expect(forTask(await list(other), task.id), other.memberId).toEqual([]);
      }
    });

    it('el operario "solo asignado" lee su aviso y lo marca como leído', async () => {
      const task = await createTask(reservedProjectId);
      await assign(owner.cookie, task, operatorB.memberId);
      const before = await list(operatorB);
      const notice = forTask(before, task.id)[0];
      if (!notice) throw new Error('esperaba el aviso de la asignación');
      expect(before.unread_count).toBeGreaterThanOrEqual(1);

      const marked = await markRead(operatorB, notice.id);

      expect(marked.statusCode, marked.body).toBe(200);
      expect(marked.json<NotificationBody>().read_at).not.toBeNull();
      const after = await list(operatorB);
      expect(after.unread_count).toBe(before.unread_count - 1);
      expect(forTask(after, task.id)[0]?.read_at).not.toBeNull();
      const unread = await list(operatorB, '?unread_only=true');
      expect(unread.notifications.map((n) => n.id)).not.toContain(notice.id);
    });

    it('crear una tarea ya asignada avisa al responsable; asignarse a sí mismo no avisa', async () => {
      const assigned = await createTask(openProjectId, { assignee_member_id: operatorA.memberId });
      const own = await createTask(openProjectId, { assignee_member_id: owner.memberId });

      expect(forTask(await list(operatorA), assigned.id)).toHaveLength(1);
      expect(forTask(await list(owner), own.id)).toEqual([]);
    });

    it('reasignar avisa solo a la nueva persona; desasignar no avisa a nadie', async () => {
      const task = await createTask(openProjectId, { assignee_member_id: operatorA.memberId });
      const reassigned = await assign(manager.cookie, task, operatorB.memberId);
      expect(reassigned.statusCode, reassigned.body).toBe(200);
      const afterReassign = reassigned.json<TaskBody>();

      expect(forTask(await list(operatorB), task.id)).toHaveLength(1);
      // Quien dejó la tarea conserva el aviso de cuando la recibió, y no recibe otro.
      expect(forTask(await list(operatorA), task.id)).toHaveLength(1);

      const unassigned = await assign(manager.cookie, afterReassign, null);
      expect(unassigned.statusCode, unassigned.body).toBe(200);
      expect(forTask(await list(operatorB), task.id)).toHaveLength(1);
      expect(forTask(await list(operatorA), task.id)).toHaveLength(1);
    });

    it('un reintento de la misma asignación (mismo client_mutation_id) no duplica el aviso', async () => {
      const task = await createTask(openProjectId);
      const payload = {
        client_mutation_id: newId(),
        expected_version: task.version,
        assignee_member_id: operatorA.memberId,
      };

      const first = await call(
        manager.cookie,
        'PATCH',
        `/projects/tasks/${task.id}/assignee`,
        payload,
      );
      const retry = await call(
        manager.cookie,
        'PATCH',
        `/projects/tasks/${task.id}/assignee`,
        payload,
      );

      expect(first.statusCode, first.body).toBe(200);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(forTask(await list(operatorA), task.id)).toHaveLength(1);
    });

    it('una asignación rechazada no deja ningún aviso', async () => {
      const task = await createTask(openProjectId);

      const stale = await assign(
        manager.cookie,
        { ...task, version: task.version + 5 },
        operatorA.memberId,
      );

      expect(stale.statusCode).toBe(409);
      expect(forTask(await list(operatorA), task.id)).toEqual([]);
    });
  });

  describe('bloqueo', () => {
    it('bloquear deja UNA fila en la bandeja con el id de la novedad, y no avisa directo a quien bloquea', async () => {
      const task = await createTask(reservedProjectId, { assignee_member_id: operatorA.memberId });
      const before = (await outboxRows()).length;

      const response = await block(operatorA.cookie, task);
      expect(response.statusCode, response.body).toBe(200);

      const rows = await outboxRows();
      expect(rows).toHaveLength(before + 1);
      const reports = await blockReportsOf(task.id);
      expect(reports).toHaveLength(1);
      expect(rows.at(-1)).toMatchObject({
        kind: 'task.blocked',
        entity_id: reports[0]?.id,
        processed_at: null,
        created_by_member_id: operatorA.memberId,
      });
      // Quien bloqueó es el responsable: ve su propia tarea, no se le avisa de lo que hizo.
      expect(
        (await list(operatorA)).notifications.filter(
          (n) => n.template_key === 'task.blocked' && n.task_id === task.id,
        ),
      ).toEqual([]);
    });

    it('si bloquea otra persona, el responsable recibe el aviso directo con el motivo', async () => {
      const task = await createTask(openProjectId, { assignee_member_id: operatorB.memberId });

      const response = await block(manager.cookie, task, 'Falta el permiso municipal');
      expect(response.statusCode, response.body).toBe(200);

      const notices = forTask(await list(operatorB), task.id).filter(
        (n) => n.template_key === 'task.blocked',
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]?.payload).toEqual({
        task_title: 'Excavar',
        actor_member_id: manager.memberId,
        reason_preview: 'Falta el permiso municipal',
      });
    });

    it('bloquear una tarea sin responsable también encola, sin aviso directo', async () => {
      const task = await createTask(openProjectId);
      const before = (await outboxRows()).length;

      const response = await block(manager.cookie, task);

      expect(response.statusCode, response.body).toBe(200);
      expect(await outboxRows()).toHaveLength(before + 1);
    });

    it('un reintento del mismo bloqueo no duplica la fila de la bandeja ni el aviso', async () => {
      const task = await createTask(openProjectId, { assignee_member_id: operatorB.memberId });
      const before = (await outboxRows()).length;
      const payload = {
        client_mutation_id: newId(),
        expected_version: task.version,
        to_status: 'blocked',
        reason: 'Falta andamio',
      };

      const first = await call(
        manager.cookie,
        'PATCH',
        `/projects/tasks/${task.id}/status`,
        payload,
      );
      const retry = await call(
        manager.cookie,
        'PATCH',
        `/projects/tasks/${task.id}/status`,
        payload,
      );

      expect(first.statusCode, first.body).toBe(200);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(await outboxRows()).toHaveLength(before + 1);
      expect(
        forTask(await list(operatorB), task.id).filter((n) => n.template_key === 'task.blocked'),
      ).toHaveLength(1);
    });

    it('un bloqueo rechazado (sin motivo, o con versión vieja) no deja nada en la bandeja ni avisos', async () => {
      const task = await createTask(openProjectId, { assignee_member_id: operatorB.memberId });
      const before = (await outboxRows()).length;

      const noReason = await block(manager.cookie, task, null);
      const stale = await block(manager.cookie, { ...task, version: task.version + 7 });

      expect(noReason.statusCode).toBe(422);
      expect(stale.statusCode).toBe(409);
      expect(await outboxRows()).toHaveLength(before);
      expect(
        forTask(await list(operatorB), task.id).filter((n) => n.template_key === 'task.blocked'),
      ).toEqual([]);
    });

    it('cambiar de estado sin bloquear no encola nada', async () => {
      const task = await createTask(openProjectId, { assignee_member_id: operatorA.memberId });
      const before = (await outboxRows()).length;

      const response = await call(operatorA.cookie, 'PATCH', `/projects/tasks/${task.id}/status`, {
        client_mutation_id: newId(),
        expected_version: task.version,
        to_status: 'in_progress',
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(await outboxRows()).toHaveLength(before);
    });
  });

  describe('listar y marcar como leído', () => {
    it('pagina por cursor, del más nuevo al más viejo, sin repetir ni saltar', async () => {
      const person = operatorMember; // todavía sin avisos
      const taskIds: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const task = await createTask(openProjectId, { title: `Tarea ${i}` });
        taskIds.push(task.id);
        expect((await assign(manager.cookie, task, person.memberId)).statusCode).toBe(200);
      }

      const page1 = await list(person, '?limit=2');
      expect(page1.notifications).toHaveLength(2);
      expect(page1.next_cursor).not.toBeNull();
      expect(page1.unread_count).toBe(5);
      const page2 = await list(person, `?limit=2&cursor=${page1.next_cursor}`);
      expect(page2.notifications).toHaveLength(2);
      const page3 = await list(person, `?limit=2&cursor=${page2.next_cursor}`);
      expect(page3.notifications).toHaveLength(1);
      expect(page3.next_cursor).toBeNull();

      const all = [...page1.notifications, ...page2.notifications, ...page3.notifications];
      expect(new Set(all.map((n) => n.id)).size).toBe(5);
      // Del más nuevo al más viejo: la última tarea asignada primero.
      expect(all.map((n) => n.task_id)).toEqual([...taskIds].reverse());
    });

    it('un cursor inválido es 400', async () => {
      const response = await call(operatorA.cookie, 'GET', '/notifications?cursor=no-es-un-cursor');
      expect(response.statusCode).toBe(400);
      expect(response.json<{ data: { domain_code: string } }>().data.domain_code).toBe(
        'invalid_notification_cursor',
      );
    });

    it('un limit fuera de rango es 400', async () => {
      expect((await call(operatorA.cookie, 'GET', '/notifications?limit=0')).statusCode).toBe(400);
      expect((await call(operatorA.cookie, 'GET', '/notifications?limit=101')).statusCode).toBe(
        400,
      );
    });

    it('marcar como leído es idempotente: devuelve el mismo read_at y no lo pisa', async () => {
      const task = await createTask(openProjectId);
      await assign(manager.cookie, task, operatorA.memberId);
      const notice = forTask(await list(operatorA), task.id)[0];
      if (!notice) throw new Error('esperaba el aviso');

      const first = await markRead(operatorA, notice.id);
      const second = await markRead(operatorA, notice.id);

      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json<NotificationBody>().read_at).toBe(first.json<NotificationBody>().read_at);
    });

    it('el mismo client_mutation_id dos veces devuelve el mismo resultado', async () => {
      const task = await createTask(openProjectId);
      await assign(manager.cookie, task, operatorA.memberId);
      const notice = forTask(await list(operatorA), task.id)[0];
      if (!notice) throw new Error('esperaba el aviso');
      const clientMutationId = newId();

      const first = await markRead(operatorA, notice.id, { client_mutation_id: clientMutationId });
      const retry = await markRead(operatorA, notice.id, { client_mutation_id: clientMutationId });

      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toEqual(first.json());
    });

    it('el aviso de otra persona es 404, igual que uno que no existe', async () => {
      const task = await createTask(openProjectId);
      await assign(manager.cookie, task, operatorA.memberId);
      const notice = forTask(await list(operatorA), task.id)[0];
      if (!notice) throw new Error('esperaba el aviso');

      const others = [operatorB, manager, owner];
      for (const other of others) {
        const response = await markRead(other, notice.id);
        expect(response.statusCode, other.memberId).toBe(404);
        expect(response.json<{ data: { domain_code: string } }>().data.domain_code).toBe(
          'notification_not_found',
        );
      }
      const missing = await markRead(operatorA, newId());
      expect(missing.statusCode).toBe(404);
      // Y el aviso sigue sin leer para su dueño.
      expect(forTask(await list(operatorA), task.id)[0]?.read_at).toBeNull();
    });

    it('sin sesión responde igual que el resto de la API (no es una excepción de este endpoint)', async () => {
      const get = (url: string) =>
        app.getHttpAdapter().getInstance().inject({ method: 'GET', url });

      const notifications = await get('/notifications');
      const myDay = await get('/projects/tasks/my-day');

      expect(notifications.statusCode).toBe(myDay.statusCode);
      expect(notifications.statusCode).toBeGreaterThanOrEqual(400);
    });
  });

  describe('visibilidad', () => {
    it('si borran la tarea, quien solo la tenía asignada deja de ver el aviso (y deja de contarlo)', async () => {
      const task = await createTask(reservedProjectId, { assignee_member_id: operatorA.memberId });
      const before = await list(operatorA);
      expect(forTask(before, task.id)).toHaveLength(1);

      const deleted = await call(owner.cookie, 'DELETE', `/projects/tasks/${task.id}`, {
        client_mutation_id: newId(),
        expected_version: task.version,
      });
      expect(deleted.statusCode, deleted.body).toBe(200);

      const after = await list(operatorA);
      expect(forTask(after, task.id)).toEqual([]);
      expect(after.unread_count).toBe(before.unread_count - 1);
    });

    it('quien pierde el acceso al proyecto reservado deja de ver los avisos de él', async () => {
      const task = await createTask(reservedProjectId);
      expect((await assign(owner.cookie, task, operatorMember.memberId)).statusCode).toBe(200);
      // Responsable y miembro explícito a la vez: ve el aviso por las dos vías.
      expect(forTask(await list(operatorMember), task.id)).toHaveLength(1);

      // Se lo desasigna y se lo saca del proyecto: ya no ve la tarea ni el proyecto.
      const current = await call(owner.cookie, 'GET', `/projects/tasks/${task.id}`);
      const { version } = current.json<{ version: number }>();
      expect((await assign(owner.cookie, { id: task.id, version }, null)).statusCode).toBe(200);
      const removed = await call(
        owner.cookie,
        'DELETE',
        `/projects/${reservedProjectId}/members/${operatorMember.memberId}`,
        { client_mutation_id: newId() },
      );
      expect(removed.statusCode, removed.body).toBe(200);

      expect(forTask(await list(operatorMember), task.id)).toEqual([]);
    });
  });
});
