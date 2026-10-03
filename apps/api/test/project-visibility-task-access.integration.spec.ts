import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { newId } from '@orq/contracts';
import { type Db, type Tx, withTenantTransaction } from '@orq/db';
import { type PostgresHarness, startPostgresHarness } from '@orq/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AUTH } from '../src/shared/auth/auth.tokens.js';
import type { Auth } from '../src/shared/auth/build-auth.js';
import { mountBetterAuth } from '../src/shared/auth/mount-better-auth.js';
import { DB } from '../src/shared/database/database.tokens.js';
import { resolveTenantIdentity } from '../src/shared/request-context/request-context.middleware.js';
import { addMemberWithRole, type MemberWithRole } from './helpers/add-member-with-role.js';
import { getDefaultSiteId } from './helpers/get-default-site-id.js';
import { signUpAndCreateOrg } from './helpers/sign-up-and-create-org.js';

/**
 * Visibilidad de proyectos (ADR-017) y alcance por sitio (ADR-015, ADR-016) de
 * punta a punta contra Postgres real con `app_login`: create-task,
 * change-task-status y la validación de a quién se le puede asignar. La
 * organización tiene dos sitios *antes* de que se agregue ningún miembro, así
 * que el otorgamiento automático de un solo sitio (ADR-016) no regala filas:
 * cada acceso de este archivo es explícito.
 *
 * Quien no ve un recurso recibe 404, igual que si no existiera; quien lo ve y no
 * puede, 403 (ADR-017 §6). Los proyectos de la primera parte son abiertos al
 * sitio (`visibility = 'site'`); la segunda parte cubre uno reservado.
 */
describe('visibilidad de proyectos sobre tareas (integración)', () => {
  let harness: PostgresHarness;
  let app: NestFastifyApplication;
  let auth: Auth;
  let db: Db;

  let organizationId: string;
  let ownerCookie: string;
  let ownerMemberId: string;
  let siteA: string;
  let siteB: string;
  let projectA: string;
  let projectB: string;
  let reservedProject: string;

  let director: MemberWithRole;
  let managerA: MemberWithRole; // fila en el sitio A
  let managerNone: MemberWithRole; // ninguna fila
  let operatorA: MemberWithRole; // fila en el sitio A
  let operatorNone: MemberWithRole; // ninguna fila
  let operatorOther: MemberWithRole; // "otro" asignado en la matriz

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

    const org = await signUpAndCreateOrg(app, 'Minera Alcance Sitio');
    organizationId = org.organizationId;
    ownerCookie = org.cookie;
    ownerMemberId = await memberIdOf(ownerCookie);

    siteA = await getDefaultSiteId(db, { organizationId, memberId: ownerMemberId });
    siteB = newId();
    await inOrganization((tx) =>
      tx.execute(sql`
        insert into site (id, organization_id, name, timezone, is_active)
        values (${siteB}, ${organizationId}, 'Sitio B', 'America/Argentina/Buenos_Aires', true)
      `),
    );

    projectA = await insertProject(siteA, 'PRY-A', 'site');
    projectB = await insertProject(siteB, 'PRY-B', 'site');
    reservedProject = await insertProject(siteA, 'PRY-R', 'reserved');

    director = await addMemberWithRole(app, auth, {
      organizationId,
      role: 'director',
      label: 'Director',
    });
    managerA = await addMemberWithRole(app, auth, {
      organizationId,
      role: 'manager',
      label: 'Gerente A',
    });
    managerNone = await addMemberWithRole(app, auth, {
      organizationId,
      role: 'manager',
      label: 'Gerente sin sitio',
    });
    operatorA = await addMemberWithRole(app, auth, {
      organizationId,
      role: 'operator',
      label: 'Operario A',
    });
    operatorNone = await addMemberWithRole(app, auth, {
      organizationId,
      role: 'operator',
      label: 'Operario sin sitio',
    });
    operatorOther = await addMemberWithRole(app, auth, {
      organizationId,
      role: 'operator',
      label: 'Operario ajeno',
    });
    for (const member of [managerA, operatorA, operatorOther]) {
      await grantAccess(member.memberId, siteA);
    }
  });

  afterAll(async () => {
    await app.close();
    await harness.stop();
  });

  async function memberIdOf(cookie: string): Promise<string> {
    const tenant = await resolveTenantIdentity(auth, { cookie });
    if (!tenant) throw new Error('esperaba tenant resuelto');
    return tenant.memberId;
  }

  function inOrganization<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenantTransaction(
      db,
      { organizationId, memberId: ownerMemberId, requestId: newId() },
      run,
    );
  }

  async function insertProject(
    siteId: string,
    code: string,
    visibility: 'site' | 'reserved',
  ): Promise<string> {
    const id = newId();
    await inOrganization((tx) =>
      tx.execute(sql`
        insert into project (id, organization_id, site_id, created_by_member_id, code, name, visibility)
        values (${id}, ${organizationId}, ${siteId}, ${ownerMemberId}, ${code}, ${code}, ${visibility})
      `),
    );
    return id;
  }

  function addProjectMember(projectId: string, memberId: string) {
    return inOrganization((tx) =>
      tx.execute(sql`
        insert into project_member (id, organization_id, created_by_member_id, project_id, member_id)
        values (${newId()}, ${organizationId}, ${ownerMemberId}, ${projectId}, ${memberId})
      `),
    );
  }

  function grantAccess(memberId: string, siteId: string) {
    return inOrganization((tx) =>
      tx.execute(sql`
        insert into member_site_access (organization_id, member_id, site_id)
        values (${organizationId}, ${memberId}, ${siteId})
      `),
    );
  }

  /** Inserta directo: la matriz necesita tareas que la API no deja crear (asignadas a alguien sin acceso). */
  async function insertTask(params: {
    projectId: string;
    assigneeMemberId: string | null;
  }): Promise<{ id: string; version: number }> {
    const id = newId();
    await inOrganization((tx) =>
      tx.execute(sql`
        insert into task (
          id, organization_id, created_by_member_id, project_id,
          title, assignee_member_id, position
        ) values (
          ${id}, ${organizationId}, ${ownerMemberId}, ${params.projectId},
          'Tarea de la matriz', ${params.assigneeMemberId}, ${`a${id.slice(0, 8)}`}
        )
      `),
    );
    return { id, version: 1 };
  }

  async function countTasksWithTitle(title: string): Promise<number> {
    const result = await inOrganization((tx) =>
      tx.execute<{ count: string }>(
        sql`select count(*)::text as count from task where title = ${title}`,
      ),
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  function createTask(cookie: string, payload: Record<string, unknown>) {
    return app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/projects/tasks',
        headers: { cookie },
        payload: { client_mutation_id: newId(), id: newId(), title: 'Tarea', ...payload },
      });
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

  describe('create-task', () => {
    it('un manager con acceso al sitio del proyecto crea la tarea', async () => {
      const response = await createTask(managerA.cookie, { project_id: projectA });

      expect(response.statusCode, response.body).toBe(200);
    });

    it('un manager con acceso al sitio A no ve el proyecto del sitio B: 404, y no queda ninguna fila', async () => {
      const title = 'Tarea que no debe existir (manager, sitio B)';

      const response = await createTask(managerA.cookie, { project_id: projectB, title });

      expect(response.statusCode).toBe(404);
      expect(response.json().data).toMatchObject({ domain_code: 'project_not_found' });
      expect(await countTasksWithTitle(title)).toBe(0);
    });

    it('un manager sin ninguna fila no ve ningún proyecto abierto al sitio: 404', async () => {
      const response = await createTask(managerNone.cookie, { project_id: projectA });

      expect(response.statusCode).toBe(404);
      expect(response.json().data).toMatchObject({ domain_code: 'project_not_found' });
    });

    it('owner y director crean en cualquier sitio sin necesitar una fila (acceso implícito)', async () => {
      const asOwner = await createTask(ownerCookie, { project_id: projectB });
      const asDirector = await createTask(director.cookie, { project_id: projectB });

      expect(asOwner.statusCode, asOwner.body).toBe(200);
      expect(asDirector.statusCode, asDirector.body).toBe(200);
    });

    it('el rechazo por sitio no se queda en el registro de mutaciones: reintentar tras recibir el acceso crea la tarea', async () => {
      const lateManager = await addMemberWithRole(app, auth, {
        organizationId,
        role: 'manager',
        label: 'Gerente que recibe acceso después',
      });
      const payload = { project_id: projectB, client_mutation_id: newId(), id: newId() };

      const denied = await createTask(lateManager.cookie, payload);
      expect(denied.statusCode).toBe(404);

      await grantAccess(lateManager.memberId, siteB);
      const retried = await createTask(lateManager.cookie, payload);
      expect(retried.statusCode, retried.body).toBe(200);
    });
  });

  describe('asignación: a quién se le puede asignar', () => {
    it('acepta a un operator con acceso al sitio del proyecto', async () => {
      const response = await createTask(ownerCookie, {
        project_id: projectA,
        assignee_member_id: operatorA.memberId,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().assignee_member_id).toBe(operatorA.memberId);
    });

    it('rechaza a un operator sin acceso al sitio del proyecto', async () => {
      const title = 'Tarea para un operario sin acceso';

      const response = await createTask(ownerCookie, {
        project_id: projectA,
        title,
        assignee_member_id: operatorNone.memberId,
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().data).toMatchObject({ domain_code: 'assignee_not_assignable' });
      expect(await countTasksWithTitle(title)).toBe(0);
    });

    it('rechaza a un operator con acceso solo al otro sitio', async () => {
      const response = await createTask(ownerCookie, {
        project_id: projectB,
        assignee_member_id: operatorA.memberId,
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().data).toMatchObject({ domain_code: 'assignee_not_assignable' });
    });

    it('acepta a un director sin ninguna fila: el acceso se calcula con su rol, no mirando solo member_site_access', async () => {
      const response = await createTask(ownerCookie, {
        project_id: projectB,
        assignee_member_id: director.memberId,
      });

      expect(response.statusCode, response.body).toBe(200);
    });

    it('acepta al owner como asignado en un sitio donde no tiene fila', async () => {
      const response = await createTask(ownerCookie, {
        project_id: projectB,
        assignee_member_id: ownerMemberId,
      });

      expect(response.statusCode, response.body).toBe(200);
    });

    it('rechaza a un miembro de otra organización, aunque tenga acceso a un sitio de la suya', async () => {
      const otherOrg = await signUpAndCreateOrg(app, 'Otra Organización');
      const foreignMemberId = await memberIdOf(otherOrg.cookie);

      const response = await createTask(ownerCookie, {
        project_id: projectA,
        assignee_member_id: foreignMemberId,
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().data).toMatchObject({ domain_code: 'assignee_not_assignable' });
    });

    it('rechaza un id que no es de ningún miembro', async () => {
      const response = await createTask(ownerCookie, {
        project_id: projectA,
        assignee_member_id: newId(),
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().data).toMatchObject({ domain_code: 'assignee_not_assignable' });
    });
  });

  describe('change-task-status: matriz rol × acceso × asignación', () => {
    type Outcome = 'allowed' | 'not_found' | 'requires_assignee';
    type Assignment = 'mine' | 'unassigned' | 'other';

    /**
     * Escrita a mano a partir de las decisiones de ADR-017, no copiada de la
     * implementación. Quien no ve la tarea recibe 404; ser el asignado la hace
     * visible aunque no tenga el sitio; el operator actúa en lo suyo, y en lo
     * sin asignar de un proyecto que ve completo solo hacia blocked.
     */
    function expectedOutcome(
      role: string,
      hasAccess: boolean,
      assignment: Assignment,
      to: string,
    ): Outcome {
      if (role === 'owner' || role === 'director') return 'allowed';
      if (assignment === 'mine') return 'allowed';
      if (!hasAccess) return 'not_found';
      if (role === 'manager') return 'allowed';
      if (assignment === 'unassigned' && to === 'blocked') return 'allowed';
      return 'requires_assignee';
    }

    function actor(role: string, hasAccess: boolean): MemberWithRole {
      if (role === 'owner') return { cookie: ownerCookie, memberId: ownerMemberId };
      if (role === 'director') return director;
      if (role === 'manager') return hasAccess ? managerA : managerNone;
      return hasAccess ? operatorA : operatorNone;
    }

    const cases: Array<[role: string, hasAccess: boolean]> = [
      ['owner', true],
      ['director', true],
      ['manager', true],
      ['manager', false],
      ['operator', true],
      ['operator', false],
    ];

    for (const [role, hasAccess] of cases) {
      for (const assignment of ['mine', 'unassigned', 'other'] as const) {
        for (const to of ['in_progress', 'blocked'] as const) {
          const outcome = expectedOutcome(role, hasAccess, assignment, to);
          it(`${role} ${hasAccess ? 'con' : 'sin'} acceso al sitio, tarea ${assignment}, pending -> ${to}: ${outcome}`, async () => {
            const who = actor(role, hasAccess);
            const assigneeMemberId =
              assignment === 'mine'
                ? who.memberId
                : assignment === 'other'
                  ? operatorOther.memberId
                  : null;
            const task = await insertTask({ projectId: projectA, assigneeMemberId });

            const response = await changeStatus(who.cookie, task.id, {
              to_status: to,
              expected_version: task.version,
              ...(to === 'blocked' ? { reason: 'Falta el permiso municipal' } : {}),
            });

            if (outcome === 'allowed') {
              expect(response.statusCode, response.body).toBe(200);
              expect(response.json()).toMatchObject({ status: to, version: task.version + 1 });
              return;
            }
            expect(response.statusCode, response.body).toBe(outcome === 'not_found' ? 404 : 403);
            expect(response.json().data).toMatchObject({
              domain_code:
                outcome === 'not_found'
                  ? 'task_not_found'
                  : 'task_status_transition_requires_assignee',
            });
            const unchanged = await inOrganization((tx) =>
              tx.execute<{ status: string }>(sql`select status from task where id = ${task.id}`),
            );
            expect(unchanged.rows[0]?.status).toBe('pending');
          });
        }
      }
    }

    it('un manager con acceso solo al sitio A no ve una tarea del sitio B: 404', async () => {
      const task = await insertTask({ projectId: projectB, assigneeMemberId: null });

      const response = await changeStatus(managerA.cookie, task.id, {
        to_status: 'in_progress',
        expected_version: task.version,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().data).toMatchObject({ domain_code: 'task_not_found' });
    });

    it('orden 404 → 403 → 409: quien no ve la tarea recibe 404 aunque mande una versión vieja', async () => {
      const task = await insertTask({ projectId: projectB, assigneeMemberId: null });

      const response = await changeStatus(managerA.cookie, task.id, {
        to_status: 'in_progress',
        expected_version: task.version + 7,
      });

      expect(response.statusCode, response.body).toBe(404);
      expect(response.json().data).toMatchObject({ domain_code: 'task_not_found' });
    });

    it('el operator que bloquea una tarea sin asignar deja un task_update block_report a su nombre', async () => {
      const task = await insertTask({ projectId: projectA, assigneeMemberId: null });

      const response = await changeStatus(operatorA.cookie, task.id, {
        to_status: 'blocked',
        expected_version: task.version,
        reason: 'No llegó el material',
      });

      expect(response.statusCode, response.body).toBe(200);
      const updates = await inOrganization((tx) =>
        tx.execute<{ kind: string; body: string; created_by_member_id: string }>(sql`
          select kind, body, created_by_member_id from task_update where task_id = ${task.id}
        `),
      );
      expect(updates.rows).toEqual([
        {
          kind: 'block_report',
          body: 'No llegó el material',
          created_by_member_id: operatorA.memberId,
        },
      ]);
    });
  });

  describe('proyecto reservado (ADR-017)', () => {
    // Miembros explícitos del proyecto reservado, SIN fila en el sitio.
    let explicitOperator: MemberWithRole;
    let explicitManager: MemberWithRole;
    // Ni miembro ni sitio: no tiene forma de entrar al proyecto.
    let stranger: MemberWithRole;

    beforeAll(async () => {
      explicitOperator = operatorNone;
      explicitManager = managerNone;
      stranger = await addMemberWithRole(app, auth, {
        organizationId,
        role: 'operator',
        label: 'Operario sin sitio ni proyecto',
      });
      await addProjectMember(reservedProject, explicitOperator.memberId);
      await addProjectMember(reservedProject, explicitManager.memberId);
    });

    it('un operator del sitio que no participa no ve la tarea: 404, no 403', async () => {
      const task = await insertTask({ projectId: reservedProject, assigneeMemberId: null });

      const response = await changeStatus(operatorA.cookie, task.id, {
        to_status: 'blocked',
        expected_version: task.version,
        reason: 'No llegó el material',
      });

      expect(response.statusCode, response.body).toBe(404);
      expect(response.json().data).toMatchObject({ domain_code: 'task_not_found' });
    });

    it('un manager del sitio que no participa no ve el proyecto reservado: crear es 404', async () => {
      const response = await createTask(managerA.cookie, { project_id: reservedProject });

      expect(response.statusCode).toBe(404);
      expect(response.json().data).toMatchObject({ domain_code: 'project_not_found' });
    });

    it('un miembro explícito sin acceso al sitio actúa según su rol: el manager crea tareas', async () => {
      const response = await createTask(explicitManager.cookie, { project_id: reservedProject });

      expect(response.statusCode, response.body).toBe(200);
    });

    it('un operator miembro explícito puede bloquear una tarea sin asignar, no arrancarla', async () => {
      const task = await insertTask({ projectId: reservedProject, assigneeMemberId: null });

      const started = await changeStatus(explicitOperator.cookie, task.id, {
        to_status: 'in_progress',
        expected_version: task.version,
      });
      expect(started.statusCode, started.body).toBe(403);
      expect(started.json().data).toMatchObject({
        domain_code: 'task_status_transition_requires_assignee',
      });

      const blocked = await changeStatus(explicitOperator.cookie, task.id, {
        to_status: 'blocked',
        expected_version: task.version,
        reason: 'Falta el permiso municipal',
      });
      expect(blocked.statusCode, blocked.body).toBe(200);
    });

    it('un operator asignado que no es miembro ve y mueve SU tarea; la ajena es 404', async () => {
      const mine = await insertTask({
        projectId: reservedProject,
        assigneeMemberId: stranger.memberId,
      });
      const notMine = await insertTask({ projectId: reservedProject, assigneeMemberId: null });

      const moved = await changeStatus(stranger.cookie, mine.id, {
        to_status: 'in_progress',
        expected_version: mine.version,
      });
      expect(moved.statusCode, moved.body).toBe(200);

      const hidden = await changeStatus(stranger.cookie, notMine.id, {
        to_status: 'blocked',
        expected_version: notMine.version,
        reason: 'No debería verla',
      });
      expect(hidden.statusCode, hidden.body).toBe(404);
    });

    it('un manager solo asignado ve el proyecto pero no puede crear tareas: 403 con motivo propio', async () => {
      await insertTask({ projectId: reservedProject, assigneeMemberId: managerA.memberId });

      const response = await createTask(managerA.cookie, { project_id: reservedProject });

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().data).toMatchObject({
        domain_code: 'task_create_project_access_forbidden',
      });
    });

    it('se le puede asignar a un miembro explícito aunque no tenga acceso al sitio', async () => {
      const response = await createTask(ownerCookie, {
        project_id: reservedProject,
        assignee_member_id: explicitOperator.memberId,
      });

      expect(response.statusCode, response.body).toBe(200);
    });

    it('y no a quien no es miembro ni tiene el sitio', async () => {
      const response = await createTask(ownerCookie, {
        project_id: reservedProject,
        assignee_member_id: newId(),
      });
      expect(response.statusCode).toBe(422);

      const noAccess = await addMemberWithRole(app, auth, {
        organizationId,
        role: 'operator',
        label: 'Operario que no entra',
      });
      const rejected = await createTask(ownerCookie, {
        project_id: reservedProject,
        assignee_member_id: noAccess.memberId,
      });
      expect(rejected.statusCode, rejected.body).toBe(422);
      expect(rejected.json().data).toMatchObject({ domain_code: 'assignee_not_assignable' });
    });
  });
});
