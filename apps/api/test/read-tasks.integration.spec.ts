import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { newId } from '@orq/contracts';
import { type Db, withTenantTransaction } from '@orq/db';
import { type PostgresHarness, startPostgresHarness } from '@orq/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MAX_TASK_UPDATES } from '../src/modules/projects/domain/read-limits.js';
import { AUTH } from '../src/shared/auth/auth.tokens.js';
import type { Auth } from '../src/shared/auth/build-auth.js';
import { mountBetterAuth } from '../src/shared/auth/mount-better-auth.js';
import { DB } from '../src/shared/database/database.tokens.js';
import { resolveTenantIdentity } from '../src/shared/request-context/request-context.middleware.js';
import { addMemberWithRole } from './helpers/add-member-with-role.js';
import { signUpAndCreateOrg } from './helpers/sign-up-and-create-org.js';

/**
 * Lectura de tareas (`get-task`, `list-project-tasks`) con la visibilidad de
 * ADR-017: acceso completo ve todo el árbol; "solo asignado" ve únicamente sus
 * tareas; quien no ve el proyecto recibe 404. Postgres real, `app_login`.
 */
describe('lectura de tareas (integración)', () => {
  let harness: PostgresHarness;
  let app: NestFastifyApplication;
  let auth: Auth;
  let db: Db;

  let organizationId: string;
  let owner: { cookie: string; memberId: string };
  let explicit: { cookie: string; memberId: string };
  let assignedA: { cookie: string; memberId: string };
  let assignedB: { cookie: string; memberId: string };
  let manager: { cookie: string; memberId: string };
  let outsider: { cookie: string; memberId: string };

  type Task = { id: string; version: number; parent_task_id: string | null; depth: number };
  type Node = Task & { title: string; subtasks: Node[] };

  let projectId: string;
  let t1: Task;
  let t1a: Task;
  let t1b: Task;
  let t1a1: Task;
  let t2: Task;
  let t3: Task;

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

  async function createProject(visibility: 'reserved' | 'site', code: string): Promise<string> {
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

  async function createTask(
    project: string,
    title: string,
    extra: Record<string, unknown> = {},
  ): Promise<Task> {
    const response = await call(owner.cookie, 'POST', '/projects/tasks', {
      client_mutation_id: newId(),
      id: newId(),
      project_id: project,
      title,
      ...extra,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<Task>();
  }

  const list = (cookie: string, project = projectId) =>
    call(cookie, 'GET', `/projects/${project}/tasks`);
  const get = (cookie: string, taskId: string) => call(cookie, 'GET', `/projects/tasks/${taskId}`);
  const idsOf = (nodes: Node[]) => nodes.map((node) => node.id);

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

    const org = await signUpAndCreateOrg(app, 'Constructora Lectura');
    organizationId = org.organizationId;
    const tenant = await resolveTenantIdentity(auth, { cookie: org.cookie });
    if (!tenant) throw new Error('esperaba tenant resuelto tras crear la organización');
    owner = { cookie: org.cookie, memberId: tenant.memberId };

    const add = (role: 'manager' | 'operator', label: string) =>
      addMemberWithRole(app, auth, { organizationId, role, label });
    explicit = await add('operator', 'Miembro explícito');
    assignedA = await add('operator', 'Operario A');
    assignedB = await add('operator', 'Operario B');
    manager = await add('manager', 'Gerente del sitio');
    outsider = await add('operator', 'Operario ajeno');

    // Proyecto reservado con un árbol:
    //   T1 ── T1a (A) ── T1a1 (B)
    //      └─ T1b (B)
    //   T2, T3
    projectId = await createProject('reserved', 'PRY-LECTURA');
    const member = await call(owner.cookie, 'POST', `/projects/${projectId}/members`, {
      client_mutation_id: newId(),
      member_id: explicit.memberId,
    });
    expect(member.statusCode, member.body).toBe(200);

    t1 = await createTask(projectId, 'T1');
    t1a = await createTask(projectId, 'T1a', {
      parent_task_id: t1.id,
      assignee_member_id: assignedA.memberId,
    });
    t1b = await createTask(projectId, 'T1b', {
      parent_task_id: t1.id,
      assignee_member_id: assignedB.memberId,
    });
    t1a1 = await createTask(projectId, 'T1a1', {
      parent_task_id: t1a.id,
      assignee_member_id: assignedB.memberId,
    });
    t2 = await createTask(projectId, 'T2');
    t3 = await createTask(projectId, 'T3');

    // Dos novedades en T1a: A la inicia y la bloquea con motivo.
    const started = await call(assignedA.cookie, 'PATCH', `/projects/tasks/${t1a.id}/status`, {
      client_mutation_id: newId(),
      to_status: 'in_progress',
      expected_version: t1a.version,
    });
    expect(started.statusCode, started.body).toBe(200);
    const blocked = await call(assignedA.cookie, 'PATCH', `/projects/tasks/${t1a.id}/status`, {
      client_mutation_id: newId(),
      to_status: 'blocked',
      expected_version: started.json().version,
      reason: 'Falta el permiso municipal',
    });
    expect(blocked.statusCode, blocked.body).toBe(200);
  });

  afterAll(async () => {
    await app.close();
    await harness.stop();
  });

  describe('acceso completo', () => {
    it('GET /projects/{id}/tasks devuelve las raíces con su árbol, hermanas por position', async () => {
      const response = await list(owner.cookie);

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<{ access_level: string; tasks: Node[]; truncated: boolean }>();
      expect(body.access_level).toBe('full');
      expect(body.truncated).toBe(false);
      expect(idsOf(body.tasks)).toEqual([t1.id, t2.id, t3.id]);
      const [root] = body.tasks;
      expect(idsOf(root?.subtasks ?? [])).toEqual([t1a.id, t1b.id]);
      expect(idsOf(root?.subtasks[0]?.subtasks ?? [])).toEqual([t1a1.id]);
      expect(root?.subtasks[0]?.subtasks[0]).toMatchObject({ depth: 3, subtasks: [] });
      expect(root).toMatchObject({ parent_task_id: null, depth: 1, title: 'T1' });
    });

    it('un miembro explícito (acceso completo) ve lo mismo que el owner', async () => {
      const response = await list(explicit.cookie);

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().access_level).toBe('full');
      expect(idsOf(response.json().tasks)).toEqual([t1.id, t2.id, t3.id]);
    });

    it('GET /projects/tasks/{id} devuelve la tarea con su árbol de subtareas', async () => {
      const response = await get(owner.cookie, t1.id);

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<Node & { subtasks_truncated: boolean }>();
      expect(body).toMatchObject({ id: t1.id, title: 'T1', subtasks_truncated: false });
      expect(idsOf(body.subtasks)).toEqual([t1a.id, t1b.id]);
      expect(idsOf(body.subtasks[0]?.subtasks ?? [])).toEqual([t1a1.id]);
    });

    it('trae las novedades de la tarea, de la más vieja a la más nueva, y no las de sus subtareas', async () => {
      const response = await get(owner.cookie, t1a.id);

      expect(response.statusCode, response.body).toBe(200);
      const { updates, updates_truncated } = response.json<{
        updates: Array<{
          task_id: string;
          kind: string;
          body: string | null;
          metadata: Record<string, unknown>;
          created_by_member_id: string;
        }>;
        updates_truncated: boolean;
      }>();
      expect(updates_truncated).toBe(false);
      expect(updates.map((update) => update.kind)).toEqual(['status_change', 'block_report']);
      expect(updates[0]).toMatchObject({
        task_id: t1a.id,
        body: null,
        metadata: { from: 'pending', to: 'in_progress' },
        created_by_member_id: assignedA.memberId,
      });
      expect(updates[1]).toMatchObject({
        body: 'Falta el permiso municipal',
        metadata: { from: 'in_progress', to: 'blocked' },
      });
      // T1 no tiene novedades propias: las de T1a no se le suben.
      expect((await get(owner.cookie, t1.id)).json().updates).toEqual([]);
    });
  });

  describe('"solo asignado" (ADR-017 §1)', () => {
    it('lista únicamente sus tareas: la subtarea queda como raíz con su padre real y sin las ajenas', async () => {
      const response = await list(assignedA.cookie);

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<{ access_level: string; tasks: Node[] }>();
      expect(body.access_level).toBe('assigned');
      expect(idsOf(body.tasks)).toEqual([t1a.id]);
      // El padre (T1) no lo ve, pero el dato real de la tarea se conserva.
      expect(body.tasks[0]).toMatchObject({ parent_task_id: t1.id, depth: 2 });
      // T1a1 está asignada a otra persona dentro de una tarea suya: no la ve.
      expect(body.tasks[0]?.subtasks).toEqual([]);
    });

    it('puede leer su tarea con sus novedades, y 404 en las que no son suyas', async () => {
      const own = await get(assignedA.cookie, t1a.id);
      expect(own.statusCode, own.body).toBe(200);
      expect(own.json().updates).toHaveLength(2);
      expect(own.json().subtasks).toEqual([]);

      for (const other of [t1, t1b, t1a1, t2]) {
        const response = await get(assignedA.cookie, other.id);
        expect(response.statusCode, `${other.id}: ${response.body}`).toBe(404);
        expect(response.json().data).toMatchObject({ domain_code: 'task_not_found' });
      }
    });

    it('quien tiene dos tareas sueltas las ve a las dos, cada una en su lugar', async () => {
      const response = await list(assignedB.cookie);

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<{ tasks: Node[] }>();
      expect([...idsOf(body.tasks)].sort()).toEqual([t1a1.id, t1b.id].sort());
      const lone = body.tasks.find((node) => node.id === t1a1.id);
      expect(lone).toMatchObject({ parent_task_id: t1a.id, depth: 3 });
    });
  });

  describe('quien no ve el proyecto', () => {
    it.each([
      ['un operario ajeno', () => outsider],
      ['un manager del sitio que no es miembro', () => manager],
    ])('%s recibe 404 en la lista y en la tarea', async (_label, who) => {
      const listing = await list(who().cookie);
      expect(listing.statusCode, listing.body).toBe(404);
      expect(listing.json().data).toMatchObject({ domain_code: 'project_not_found' });

      const task = await get(who().cookie, t1.id);
      expect(task.statusCode, task.body).toBe(404);
    });

    it('una organización ajena recibe 404', async () => {
      const other = await signUpAndCreateOrg(app, 'Otra Constructora');

      expect((await list(other.cookie)).statusCode).toBe(404);
      expect((await get(other.cookie, t1.id)).statusCode).toBe(404);
    });

    it('un proyecto abierto al sitio lo lee con acceso completo el manager del sitio', async () => {
      const open = await createProject('site', 'PRY-ABIERTO');
      const root = await createTask(open, 'Raíz abierta');
      await createTask(open, 'Hija abierta', { parent_task_id: root.id });

      const response = await list(manager.cookie, open);

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<{ access_level: string; tasks: Node[] }>();
      expect(body.access_level).toBe('full');
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0]?.subtasks).toHaveLength(1);
    });
  });

  describe('borradas y topes', () => {
    it('una tarea borrada (deleted_at) no sale en la lista y su lectura es 404', async () => {
      const doomed = await createTask(projectId, 'Borrada');
      await withTenantTransaction(
        db,
        { organizationId, memberId: owner.memberId, requestId: newId() },
        (tx) => tx.execute(sql`update task set deleted_at = now() where id = ${doomed.id}`),
      );

      const listing = await list(owner.cookie);
      expect(idsOf(listing.json().tasks)).not.toContain(doomed.id);
      expect((await get(owner.cookie, doomed.id)).statusCode).toBe(404);
    });

    it(`con más de ${MAX_TASK_UPDATES} novedades quedan las más recientes y se avisa`, async () => {
      const busy = await createTask(projectId, 'Con muchas novedades');
      const total = MAX_TASK_UPDATES + 5;
      // Los ids son UUIDv7 (el contrato los valida): no sirve gen_random_uuid().
      await withTenantTransaction(
        db,
        { organizationId, memberId: owner.memberId, requestId: newId() },
        async (tx) => {
          for (let i = 1; i <= total; i++) {
            await tx.execute(sql`
              insert into task_update (id, organization_id, created_by_member_id, task_id, kind, body, created_at)
              values (${newId()}, ${organizationId}, ${owner.memberId}, ${busy.id}, 'comment',
                      ${`n${i}`}, now() - make_interval(secs => ${total - i}))
            `);
          }
        },
      );

      const response = await get(owner.cookie, busy.id);

      expect(response.statusCode, response.body).toBe(200);
      const { updates, updates_truncated } = response.json<{
        updates: Array<{ body: string }>;
        updates_truncated: boolean;
      }>();
      expect(updates_truncated).toBe(true);
      expect(updates).toHaveLength(MAX_TASK_UPDATES);
      expect(updates[0]?.body).toBe('n6');
      expect(updates.at(-1)?.body).toBe(`n${total}`);
    });
  });
});
