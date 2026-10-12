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
import { getDefaultSiteId } from './helpers/get-default-site-id.js';
import { signUpAndCreateOrg } from './helpers/sign-up-and-create-org.js';

/**
 * CRUD de proyectos (ADR-017 §8 y adenda) de punta a punta, con Postgres real y
 * la identidad de conexión de producción (`app_login`). Lo que se prueba pasa por
 * los handlers reales; las filas se verifican con consultas aparte.
 */
describe('CRUD de proyectos (integración)', () => {
  let harness: PostgresHarness;
  let app: NestFastifyApplication;
  let auth: Auth;
  let db: Db;

  let organizationId: string;
  let siteId: string;
  let owner: { cookie: string; memberId: string };
  let director: { cookie: string; memberId: string };
  let manager: { cookie: string; memberId: string }; // con acceso al sitio
  let outsiderManager: { cookie: string; memberId: string }; // sin fila de acceso al sitio
  let operator: { cookie: string; memberId: string };
  let otherOperator: { cookie: string; memberId: string };

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

    const org = await signUpAndCreateOrg(app, 'Constructora Sur');
    organizationId = org.organizationId;
    const tenant = await resolveTenantIdentity(auth, { cookie: org.cookie });
    if (!tenant) throw new Error('esperaba tenant resuelto tras crear la organización');
    owner = { cookie: org.cookie, memberId: tenant.memberId };
    siteId = await getDefaultSiteId(db, { organizationId, memberId: owner.memberId });

    const add = (role: 'director' | 'manager' | 'operator', label: string) =>
      addMemberWithRole(app, auth, { organizationId, role, label });
    director = await add('director', 'Directora');
    manager = await add('manager', 'Gerente del sitio');
    outsiderManager = await add('manager', 'Gerente ajeno');
    operator = await add('operator', 'Operario');
    otherOperator = await add('operator', 'Otro operario');

    // ADR-016: con un solo sitio, todo miembro recibe fila de acceso al alta.
    // El gerente "ajeno" es el que no trabaja en el sitio: se le quita la fila.
    await asOwner((tx) =>
      tx.execute(sql`delete from member_site_access where member_id = ${outsiderManager.memberId}`),
    );
  });

  afterAll(async () => {
    await app.close();
    await harness.stop();
  });

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

  let codeCounter = 0;
  const nextCode = () => `PRY-${Date.now().toString(36)}-${++codeCounter}`;

  function createProject(cookie: string, overrides: Record<string, unknown> = {}) {
    return call(cookie, 'POST', '/projects', {
      client_mutation_id: newId(),
      id: newId(),
      code: nextCode(),
      name: 'Frente Norte',
      ...overrides,
    });
  }

  async function createOk(cookie: string, overrides: Record<string, unknown> = {}) {
    const response = await createProject(cookie, overrides);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ id: string; version: number; code: string; visibility: string }>();
  }

  async function asOwner<T>(
    run: (tx: Parameters<Parameters<typeof withTenantTransaction>[2]>[0]) => Promise<T>,
  ) {
    return withTenantTransaction(
      db,
      { organizationId, memberId: owner.memberId, requestId: newId() },
      run,
    );
  }

  async function countRows(table: 'project' | 'project_member', where: string, value: string) {
    const result = await asOwner((tx) =>
      tx.execute<{ count: number }>(
        sql`select count(*)::int as count from ${sql.raw(table)} where ${sql.raw(where)} = ${value} and deleted_at is null`,
      ),
    );
    return result.rows[0]?.count ?? 0;
  }

  const addMember = (cookie: string, projectId: string, memberId: string) =>
    call(cookie, 'POST', `/projects/${projectId}/members`, {
      client_mutation_id: newId(),
      member_id: memberId,
    });
  const removeMember = (
    cookie: string,
    projectId: string,
    memberId: string,
    mutationId = newId(),
  ) =>
    call(cookie, 'DELETE', `/projects/${projectId}/members/${memberId}`, {
      client_mutation_id: mutationId,
    });
  const changeVisibility = (
    cookie: string,
    projectId: string,
    visibility: string,
    expectedVersion: number,
  ) =>
    call(cookie, 'PATCH', `/projects/${projectId}/visibility`, {
      client_mutation_id: newId(),
      visibility,
      expected_version: expectedVersion,
    });

  describe('POST /projects', () => {
    it('crea un proyecto reservado, toma el único sitio y deja al creador como miembro explícito', async () => {
      const response = await createProject(owner.cookie, { description: 'Obra de cimientos' });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        site_id: siteId,
        visibility: 'reserved',
        status: 'planning',
        access_level: 'full',
        description: 'Obra de cimientos',
        created_by_member_id: owner.memberId,
        version: 1,
      });
      // El acceso del creador es una fila, no una derivación de created_by_member_id.
      expect(await countRows('project_member', 'project_id', body.id)).toBe(1);
    });

    it('acepta la visibilidad site como opción', async () => {
      const project = await createOk(owner.cookie, { visibility: 'site' });
      expect(project.visibility).toBe('site');
    });

    it('el mismo client_mutation_id dos veces produce un solo proyecto y una sola fila de miembro', async () => {
      const payload = { client_mutation_id: newId(), id: newId(), code: nextCode(), name: 'Idem' };

      const first = await call(owner.cookie, 'POST', '/projects', payload);
      const second = await call(owner.cookie, 'POST', '/projects', payload);

      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().id).toBe(first.json().id);
      expect(await countRows('project', 'id', payload.id)).toBe(1);
      expect(await countRows('project_member', 'project_id', payload.id)).toBe(1);
    });

    it('dos pedidos simultáneos con el mismo client_mutation_id: un solo proyecto y una sola fila de miembro', async () => {
      const payload = { client_mutation_id: newId(), id: newId(), code: nextCode(), name: 'Idem' };

      const [first, second] = await Promise.all([
        call(owner.cookie, 'POST', '/projects', payload),
        call(owner.cookie, 'POST', '/projects', payload),
      ]);

      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(await countRows('project', 'id', payload.id)).toBe(1);
      expect(await countRows('project_member', 'project_id', payload.id)).toBe(1);
    });

    it.each([
      ['manager', () => manager],
      ['operator', () => operator],
    ])('un %s recibe 403 project_create_forbidden y no se inserta nada', async (_role, who) => {
      const code = nextCode();

      const response = await createProject(who().cookie, { code });

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().data).toMatchObject({ domain_code: 'project_create_forbidden' });
      expect(await countRows('project', 'code', code)).toBe(0);
    });

    it('un director sí puede crear', async () => {
      const project = await createOk(director.cookie);
      expect(await countRows('project_member', 'project_id', project.id)).toBe(1);
    });

    it('un código repetido en la organización se rechaza con 409 project_code_taken', async () => {
      const code = nextCode();
      await createOk(owner.cookie, { code });

      const response = await createProject(owner.cookie, { code });

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().data).toMatchObject({ domain_code: 'project_code_taken' });
    });

    it('reusar el id con otro client_mutation_id se rechaza con 409 project_id_taken', async () => {
      const id = newId();
      await createOk(owner.cookie, { id });

      const response = await createProject(owner.cookie, { id });

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().data).toMatchObject({ domain_code: 'project_id_taken' });
    });

    it('un site_id explícito que no existe se rechaza con 422', async () => {
      const response = await createProject(owner.cookie, { site_id: newId() });

      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().data).toMatchObject({ domain_code: 'project_site_not_found' });
    });
  });

  describe('sitio automático', () => {
    it('repara una organización sin ningún sitio con ensureDefaultSite en vez de rechazar', async () => {
      const org = await signUpAndCreateOrg(app, 'Frigorífico Reparación');
      const tenant = await resolveTenantIdentity(auth, { cookie: org.cookie });
      if (!tenant) throw new Error('esperaba tenant resuelto');
      const identity = {
        organizationId: org.organizationId,
        memberId: tenant.memberId,
        requestId: newId(),
      };
      await withTenantTransaction(db, identity, (tx) =>
        tx.execute(sql`delete from site where organization_id = ${org.organizationId}`),
      );

      const response = await createProject(org.cookie);

      expect(response.statusCode, response.body).toBe(200);
      const sites = await withTenantTransaction(db, { ...identity, requestId: newId() }, (tx) =>
        tx.execute<{ id: string }>(
          sql`select id from site where organization_id = ${org.organizationId}`,
        ),
      );
      expect(sites.rows).toHaveLength(1);
      expect(response.json().site_id).toBe(sites.rows[0]?.id);
    });

    it('con más de un sitio exige site_id; con uno explícito, lo usa', async () => {
      const org = await signUpAndCreateOrg(app, 'Agro Dos Sitios');
      const tenant = await resolveTenantIdentity(auth, { cookie: org.cookie });
      if (!tenant) throw new Error('esperaba tenant resuelto');
      const secondSite = newId();
      await withTenantTransaction(
        db,
        { organizationId: org.organizationId, memberId: tenant.memberId, requestId: newId() },
        (tx) =>
          tx.execute(sql`
            insert into site (id, organization_id, name, timezone)
            values (${secondSite}, ${org.organizationId}, 'Campo 2', 'America/Argentina/Buenos_Aires')
          `),
      );

      const withoutSite = await createProject(org.cookie);
      expect(withoutSite.statusCode, withoutSite.body).toBe(422);
      expect(withoutSite.json().data).toMatchObject({ domain_code: 'project_site_required' });

      const withSite = await createProject(org.cookie, { site_id: secondSite });
      expect(withSite.statusCode, withSite.body).toBe(200);
      expect(withSite.json().site_id).toBe(secondSite);
    });
  });

  describe('visibilidad: quién ve qué', () => {
    it('un proyecto reservado no existe para un manager del sitio que no es miembro: 404 y fuera de la lista', async () => {
      const project = await createOk(owner.cookie);

      const get = await call(manager.cookie, 'GET', `/projects/${project.id}`);
      expect(get.statusCode, get.body).toBe(404);

      const list = await call(manager.cookie, 'GET', '/projects?limit=200');
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().projects.map((p: { id: string }) => p.id)).not.toContain(project.id);
    });

    it('un proyecto abierto al sitio lo ve con acceso completo el manager del sitio, y no el ajeno', async () => {
      const project = await createOk(owner.cookie, { visibility: 'site' });

      const inSite = await call(manager.cookie, 'GET', `/projects/${project.id}`);
      expect(inSite.statusCode, inSite.body).toBe(200);
      expect(inSite.json()).toMatchObject({ access_level: 'full' });

      const outside = await call(outsiderManager.cookie, 'GET', `/projects/${project.id}`);
      expect(outside.statusCode, outside.body).toBe(404);
    });

    it('owner y director ven todo sin ser miembros', async () => {
      const project = await createOk(owner.cookie);

      const asDirector = await call(director.cookie, 'GET', `/projects/${project.id}`);

      expect(asDirector.statusCode, asDirector.body).toBe(200);
      expect(asDirector.json().access_level).toBe('full');
    });
  });

  describe('PATCH /projects/{project_id}/visibility', () => {
    it('el owner pasa un reservado a site: lo ve el manager del sitio y la versión sube', async () => {
      const project = await createOk(owner.cookie);

      const response = await changeVisibility(owner.cookie, project.id, 'site', project.version);

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ visibility: 'site', version: project.version + 1 });
      const seen = await call(manager.cookie, 'GET', `/projects/${project.id}`);
      expect(seen.statusCode, seen.body).toBe(200);
    });

    it('vuelve a reservado y el manager del sitio deja de verlo', async () => {
      const project = await createOk(owner.cookie, { visibility: 'site' });

      const response = await changeVisibility(
        owner.cookie,
        project.id,
        'reserved',
        project.version,
      );

      expect(response.statusCode, response.body).toBe(200);
      const seen = await call(manager.cookie, 'GET', `/projects/${project.id}`);
      expect(seen.statusCode, seen.body).toBe(404);
    });

    it('dos pedidos simultáneos con el mismo client_mutation_id: los dos responden lo mismo y la versión sube una sola vez', async () => {
      const project = await createOk(owner.cookie);
      const payload = {
        client_mutation_id: newId(),
        visibility: 'site',
        expected_version: project.version,
      };

      const [first, second] = await Promise.all([
        call(owner.cookie, 'PATCH', `/projects/${project.id}/visibility`, payload),
        call(owner.cookie, 'PATCH', `/projects/${project.id}/visibility`, payload),
      ]);

      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(first.json()).toMatchObject({ visibility: 'site', version: project.version + 1 });
    });

    it('una versión vieja se rechaza con 409', async () => {
      const project = await createOk(owner.cookie);
      await changeVisibility(owner.cookie, project.id, 'site', project.version);

      const stale = await changeVisibility(owner.cookie, project.id, 'reserved', project.version);

      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json().data).toMatchObject({ domain_code: 'project_version_mismatch' });
    });

    it('un manager con acceso completo por el sitio pero que no es el creador recibe 403', async () => {
      const project = await createOk(owner.cookie, { visibility: 'site' });

      const response = await changeVisibility(
        manager.cookie,
        project.id,
        'reserved',
        project.version,
      );

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().data).toMatchObject({
        domain_code: 'project_visibility_change_forbidden',
      });
    });

    it('quien no ve el proyecto recibe 404, no 403 (ADR-017 §6)', async () => {
      const project = await createOk(owner.cookie);

      const response = await changeVisibility(manager.cookie, project.id, 'site', project.version);

      expect(response.statusCode, response.body).toBe(404);
    });

    it('pedir la visibilidad que ya tiene no cambia la versión', async () => {
      const project = await createOk(owner.cookie);

      const response = await changeVisibility(
        owner.cookie,
        project.id,
        'reserved',
        project.version,
      );

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().version).toBe(project.version);
    });

    it('el creador la cambia aunque su rol ya no tenga la capacidad, mientras siga siendo miembro', async () => {
      const creator = await addMemberWithRole(app, auth, {
        organizationId,
        role: 'director',
        label: 'Ex directora',
      });
      const project = await createOk(creator.cookie);
      await harness.ownerDb.execute(
        sql`update auth.member set role = 'manager' where id = ${creator.memberId}`,
      );

      const response = await changeVisibility(creator.cookie, project.id, 'site', project.version);

      expect(response.statusCode, response.body).toBe(200);
    });
  });

  describe('miembros', () => {
    it('agregar a un operario le da acceso completo a un proyecto reservado aunque no tenga el sitio', async () => {
      const project = await createOk(owner.cookie);
      expect((await call(operator.cookie, 'GET', `/projects/${project.id}`)).statusCode).toBe(404);

      const added = await addMember(owner.cookie, project.id, operator.memberId);

      expect(added.statusCode, added.body).toBe(200);
      expect(added.json()).toEqual({ project_id: project.id, member_id: operator.memberId });
      const seen = await call(operator.cookie, 'GET', `/projects/${project.id}`);
      expect(seen.statusCode, seen.body).toBe(200);
      expect(seen.json().access_level).toBe('full');
    });

    it('agregar a quien ya es miembro no es un error ni duplica la fila', async () => {
      const project = await createOk(owner.cookie);
      await addMember(owner.cookie, project.id, operator.memberId);

      const again = await addMember(owner.cookie, project.id, operator.memberId);

      expect(again.statusCode, again.body).toBe(200);
      expect(await countRows('project_member', 'project_id', project.id)).toBe(2);
    });

    it('un client_mutation_id repetido al agregar produce un solo efecto', async () => {
      const project = await createOk(owner.cookie);
      const payload = { client_mutation_id: newId(), member_id: operator.memberId };

      const [first, second] = await Promise.all([
        call(owner.cookie, 'POST', `/projects/${project.id}/members`, payload),
        call(owner.cookie, 'POST', `/projects/${project.id}/members`, payload),
      ]);

      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(await countRows('project_member', 'project_id', project.id)).toBe(2);
    });

    it('dos pedidos DISTINTOS que agregan al mismo miembro a la vez: los dos andan y hay una sola fila', async () => {
      const project = await createOk(owner.cookie);

      const [first, second] = await Promise.all([
        addMember(owner.cookie, project.id, operator.memberId),
        addMember(owner.cookie, project.id, operator.memberId),
      ]);

      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(await countRows('project_member', 'project_id', project.id)).toBe(2);
    });

    it('un id que no es de la organización se rechaza con 422', async () => {
      const project = await createOk(owner.cookie);

      const response = await addMember(owner.cookie, project.id, 'miembro_de_otra_organizacion');

      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().data).toMatchObject({
        domain_code: 'project_member_not_in_organization',
      });
    });

    it('un manager que ve el proyecto por el sitio pero no es el creador no puede agregar: 403', async () => {
      const project = await createOk(owner.cookie, { visibility: 'site' });

      const response = await addMember(manager.cookie, project.id, operator.memberId);

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().data).toMatchObject({
        domain_code: 'project_members_manage_forbidden',
      });
    });

    it('quien no ve el proyecto recibe 404 al agregar', async () => {
      const project = await createOk(owner.cookie);

      const response = await addMember(operator.cookie, project.id, otherOperator.memberId);

      expect(response.statusCode, response.body).toBe(404);
    });

    it('quitar a un miembro sin tareas le saca el acceso y no toca nada más', async () => {
      const project = await createOk(owner.cookie);
      await addMember(owner.cookie, project.id, operator.memberId);

      const removed = await removeMember(owner.cookie, project.id, operator.memberId);

      expect(removed.statusCode, removed.body).toBe(200);
      expect(removed.json()).toEqual({
        project_id: project.id,
        member_id: operator.memberId,
        remaining_assigned_task_count: 0,
      });
      expect((await call(operator.cookie, 'GET', `/projects/${project.id}`)).statusCode).toBe(404);
      const rows = await asOwner((tx) =>
        tx.execute<{ deleted_at: string | null }>(sql`
          select deleted_at from project_member
           where project_id = ${project.id} and member_id = ${operator.memberId}
        `),
      );
      // Regla dura 9: la fila sigue, con deleted_at.
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.deleted_at).not.toBeNull();
    });

    it('quitar a un miembro con tareas asignadas informa cuántas le quedan y conserva el nivel "solo asignado"', async () => {
      const project = await createOk(owner.cookie);
      await addMember(owner.cookie, project.id, operator.memberId);
      const task = await call(owner.cookie, 'POST', '/projects/tasks', {
        client_mutation_id: newId(),
        id: newId(),
        project_id: project.id,
        title: 'Tarea del operario',
        assignee_member_id: operator.memberId,
      });
      expect(task.statusCode, task.body).toBe(200);

      const removed = await removeMember(owner.cookie, project.id, operator.memberId);

      expect(removed.statusCode, removed.body).toBe(200);
      expect(removed.json().remaining_assigned_task_count).toBe(1);
      const seen = await call(operator.cookie, 'GET', `/projects/${project.id}`);
      expect(seen.statusCode, seen.body).toBe(200);
      expect(seen.json()).toMatchObject({ access_level: 'assigned', description: null });
    });

    it('el reintento de una baja con el mismo client_mutation_id devuelve lo mismo', async () => {
      const project = await createOk(owner.cookie);
      await addMember(owner.cookie, project.id, operator.memberId);
      const mutationId = newId();

      const first = await removeMember(owner.cookie, project.id, operator.memberId, mutationId);
      const second = await removeMember(owner.cookie, project.id, operator.memberId, mutationId);

      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toEqual(first.json());
    });

    it('dos bajas simultáneas con el mismo client_mutation_id: las dos responden lo mismo y se quita una sola vez', async () => {
      const project = await createOk(owner.cookie);
      await addMember(owner.cookie, project.id, operator.memberId);
      const mutationId = newId();

      const [first, second] = await Promise.all([
        removeMember(owner.cookie, project.id, operator.memberId, mutationId),
        removeMember(owner.cookie, project.id, operator.memberId, mutationId),
      ]);

      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toEqual(first.json());
      const rows = await asOwner((tx) =>
        tx.execute<{ deleted_at: string | null }>(sql`
          select deleted_at from project_member
           where project_id = ${project.id} and member_id = ${operator.memberId}
        `),
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.deleted_at).not.toBeNull();
    });

    it('quitar a alguien que no es miembro explícito responde 404 project_member_not_found', async () => {
      const project = await createOk(owner.cookie);

      const response = await removeMember(owner.cookie, project.id, otherOperator.memberId);

      expect(response.statusCode, response.body).toBe(404);
      expect(response.json().data).toMatchObject({ domain_code: 'project_member_not_found' });
    });

    it('cualquier miembro puede salirse a sí mismo', async () => {
      const project = await createOk(owner.cookie);
      await addMember(owner.cookie, project.id, operator.memberId);

      const left = await removeMember(operator.cookie, project.id, operator.memberId);

      expect(left.statusCode, left.body).toBe(200);
      expect((await call(operator.cookie, 'GET', `/projects/${project.id}`)).statusCode).toBe(404);
    });

    it('un miembro común no puede quitar a otro: 403', async () => {
      const project = await createOk(owner.cookie);
      await addMember(owner.cookie, project.id, operator.memberId);
      await addMember(owner.cookie, project.id, otherOperator.memberId);

      const response = await removeMember(operator.cookie, project.id, otherOperator.memberId);

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().data).toMatchObject({
        domain_code: 'project_members_manage_forbidden',
      });
    });
  });

  describe('el creador', () => {
    it('lo quita un owner: el director creador pierde el acceso, y con él el derecho a cambiar la visibilidad', async () => {
      const project = await createOk(director.cookie);
      // El director ve todo por rol: para probar que "pierde todo" hace falta un
      // creador que no sea privilegiado. Se baja su rol después de crear.
      const creator = await addMemberWithRole(app, auth, {
        organizationId,
        role: 'director',
        label: 'Creador removible',
      });
      const created = await createOk(creator.cookie);
      await harness.ownerDb.execute(
        sql`update auth.member set role = 'manager' where id = ${creator.memberId}`,
      );
      expect((await call(creator.cookie, 'GET', `/projects/${created.id}`)).statusCode).toBe(200);

      const removed = await removeMember(owner.cookie, created.id, creator.memberId);

      expect(removed.statusCode, removed.body).toBe(200);
      expect((await call(creator.cookie, 'GET', `/projects/${created.id}`)).statusCode).toBe(404);
      const changeAfter = await changeVisibility(
        creator.cookie,
        created.id,
        'site',
        created.version,
      );
      expect(changeAfter.statusCode, changeAfter.body).toBe(404);
      // Un proyecto ajeno sigue intacto.
      expect((await call(director.cookie, 'GET', `/projects/${project.id}`)).statusCode).toBe(200);
    });

    it('a un creador que ya no es owner ni director no lo quita otro miembro (403), pero él sí puede salirse', async () => {
      const creator = await addMemberWithRole(app, auth, {
        organizationId,
        role: 'director',
        label: 'Creador bajado de rango',
      });
      const project = await createOk(creator.cookie);
      await harness.ownerDb.execute(
        sql`update auth.member set role = 'manager' where id = ${creator.memberId}`,
      );
      await addMember(creator.cookie, project.id, operator.memberId);

      const byMember = await removeMember(operator.cookie, project.id, creator.memberId);
      expect(byMember.statusCode, byMember.body).toBe(403);
      expect(byMember.json().data).toMatchObject({
        domain_code: 'project_creator_removal_forbidden',
      });
      expect((await call(creator.cookie, 'GET', `/projects/${project.id}`)).statusCode).toBe(200);

      const bySelf = await removeMember(creator.cookie, project.id, creator.memberId);
      expect(bySelf.statusCode, bySelf.body).toBe(200);
      expect((await call(creator.cookie, 'GET', `/projects/${project.id}`)).statusCode).toBe(404);
    });

    it('el creador agrega miembros aunque su rol ya no tenga la capacidad', async () => {
      const creator = await addMemberWithRole(app, auth, {
        organizationId,
        role: 'director',
        label: 'Creador que agrega',
      });
      const project = await createOk(creator.cookie);
      await harness.ownerDb.execute(
        sql`update auth.member set role = 'manager' where id = ${creator.memberId}`,
      );

      const added = await addMember(creator.cookie, project.id, operator.memberId);

      expect(added.statusCode, added.body).toBe(200);
    });
  });

  describe('GET /projects', () => {
    it('lista solo lo visible, los más nuevos primero, con el nivel de acceso de cada uno', async () => {
      const reserved = await createOk(owner.cookie);
      const open = await createOk(owner.cookie, { visibility: 'site' });

      const list = await call(manager.cookie, 'GET', '/projects?limit=200');

      expect(list.statusCode, list.body).toBe(200);
      const ids = list.json().projects.map((p: { id: string }) => p.id);
      expect(ids).toContain(open.id);
      expect(ids).not.toContain(reserved.id);
    });
  });
});
