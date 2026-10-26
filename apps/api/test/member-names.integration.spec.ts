import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { MAX_MEMBER_NAMES_PER_REQUEST } from '@orq/contracts';
import { type PostgresHarness, startPostgresHarness } from '@orq/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AUTH } from '../src/shared/auth/auth.tokens.js';
import type { Auth } from '../src/shared/auth/build-auth.js';
import { mountBetterAuth } from '../src/shared/auth/mount-better-auth.js';
import { resolveTenantIdentity } from '../src/shared/request-context/request-context.middleware.js';
import { addMemberWithRole } from './helpers/add-member-with-role.js';
import { signUpAndCreateOrg } from './helpers/sign-up-and-create-org.js';

/**
 * Nombres de miembros en lote (tenancy). `auth.member` y `auth."user"` no tienen RLS (ADR-011): lo
 * único que separa una organización de otra es el `WHERE` del repositorio, así que el caso
 * importante es que un id de otra organización no devuelve nada. Postgres real, `app_login`.
 */
describe('GET /tenancy/members (integración)', () => {
  let harness: PostgresHarness;
  let app: NestFastifyApplication;
  let auth: Auth;

  type Person = { cookie: string; memberId: string };
  let owner: Person;
  let director: Person;
  let manager: Person;
  let operator: Person;
  let foreignOwner: Person; // de OTRA organización
  let foreignOperator: Person;

  const names = {
    owner: 'Dueña Constructora',
    director: 'Directora Pérez',
    manager: 'Gerente Gómez',
    operator: 'Operario Ruiz',
  };

  type Body = { members: Array<{ id: string; name: string }> };

  /** Lo que emite el cliente de la web (`OpenAPILink`): notación de corchetes, también para un solo id. */
  const query = (ids: string[]) =>
    ids.map((id, i) => `ids[${i}]=${encodeURIComponent(id)}`).join('&');

  function lookup(person: Person, ids: string[]) {
    return app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: `/tenancy/members?${query(ids)}`,
        headers: { cookie: person.cookie },
      });
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
    mountBetterAuth(app, auth);
    await app.init();

    const orgA = await signUpAndCreateOrg(app, 'Constructora Nombres A');
    const tenantA = await resolveTenantIdentity(auth, { cookie: orgA.cookie });
    if (!tenantA) throw new Error('esperaba tenant resuelto');
    owner = { cookie: orgA.cookie, memberId: tenantA.memberId };
    const add = (
      organizationId: string,
      role: 'director' | 'manager' | 'operator',
      label: string,
    ) => addMemberWithRole(app, auth, { organizationId, role, label });
    director = await add(orgA.organizationId, 'director', names.director);
    manager = await add(orgA.organizationId, 'manager', names.manager);
    operator = await add(orgA.organizationId, 'operator', names.operator);

    const orgB = await signUpAndCreateOrg(app, 'Constructora Nombres B');
    const tenantB = await resolveTenantIdentity(auth, { cookie: orgB.cookie });
    if (!tenantB) throw new Error('esperaba tenant resuelto');
    foreignOwner = { cookie: orgB.cookie, memberId: tenantB.memberId };
    foreignOperator = await add(orgB.organizationId, 'operator', 'Operario Ajeno SA');
  });

  afterAll(async () => {
    await app.close();
    await harness.stop();
  });

  it('devuelve el nombre de cada miembro pedido, en el orden del pedido', async () => {
    const response = await lookup(owner, [operator.memberId, manager.memberId, director.memberId]);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<Body>()).toEqual({
      members: [
        { id: operator.memberId, name: names.operator },
        { id: manager.memberId, name: names.manager },
        { id: director.memberId, name: names.director },
      ],
    });
  });

  it.each(['owner', 'director', 'manager', 'operator'] as const)(
    'lo puede pedir el rol %s',
    async (role) => {
      const person = { owner, director, manager, operator }[role];

      const response = await lookup(person, [operator.memberId]);

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<Body>().members).toEqual([
        { id: operator.memberId, name: names.operator },
      ]);
    },
  );

  it('un id repetido vuelve una sola vez', async () => {
    const response = await lookup(owner, [manager.memberId, manager.memberId, manager.memberId]);

    expect(response.json<Body>().members).toEqual([{ id: manager.memberId, name: names.manager }]);
  });

  it('un id de OTRA organización no devuelve nada: ni el nombre ni que existe', async () => {
    const response = await lookup(owner, [
      foreignOperator.memberId,
      foreignOwner.memberId,
      manager.memberId,
    ]);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<Body>().members).toEqual([{ id: manager.memberId, name: names.manager }]);
    expect(response.body).not.toContain('Operario Ajeno SA');
  });

  it('...y al revés: la otra organización tampoco ve a la nuestra', async () => {
    const response = await lookup(foreignOwner, [
      owner.memberId,
      operator.memberId,
      foreignOperator.memberId,
    ]);

    expect(response.json<Body>().members).toEqual([
      { id: foreignOperator.memberId, name: 'Operario Ajeno SA' },
    ]);
    expect(response.body).not.toContain(names.operator);
  });

  it('un id inventado no devuelve nada, y no se distingue de uno ajeno', async () => {
    const invented = await lookup(owner, ['no_existe_para_nada_000000000000']);
    const foreign = await lookup(owner, [foreignOperator.memberId]);

    expect(invented.statusCode).toBe(200);
    expect(invented.json<Body>()).toEqual({ members: [] });
    expect(foreign.json<Body>()).toEqual(invented.json<Body>());
  });

  it('solo trae id y nombre: ni email ni rol ni nada más del usuario', async () => {
    const response = await lookup(owner, [operator.memberId]);

    const [member] = response.json<Body>().members;
    expect(Object.keys(member ?? {}).sort()).toEqual(['id', 'name']);
    expect(response.body).not.toMatch(/@example\.com|email|role/i);
  });

  it('acepta justo el tope de ids y rechaza uno más con 400', async () => {
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `inventado_${i}`);

    const atLimit = await lookup(owner, [
      manager.memberId,
      ...filler(MAX_MEMBER_NAMES_PER_REQUEST - 1),
    ]);
    const overLimit = await lookup(owner, [
      manager.memberId,
      ...filler(MAX_MEMBER_NAMES_PER_REQUEST),
    ]);

    expect(atLimit.statusCode, atLimit.body).toBe(200);
    expect(atLimit.json<Body>().members).toEqual([{ id: manager.memberId, name: names.manager }]);
    expect(overLimit.statusCode).toBe(400);
  });

  it('sin ids, 400', async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/tenancy/members',
        headers: { cookie: owner.cookie },
      });

    expect(response.statusCode).toBe(400);
  });

  it('también anda con un id suelto en la query string (`ids=x`)', async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: `/tenancy/members?ids=${encodeURIComponent(manager.memberId)}`,
        headers: { cookie: owner.cookie },
      });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<Body>().members).toEqual([{ id: manager.memberId, name: names.manager }]);
  });

  it('sin sesión responde igual que el resto de la API', async () => {
    const get = (url: string) => app.getHttpAdapter().getInstance().inject({ method: 'GET', url });

    const members = await get(`/tenancy/members?${query([manager.memberId])}`);
    const myDay = await get('/projects/tasks/my-day');

    expect(members.statusCode).toBe(myDay.statusCode);
    expect(members.statusCode).toBeGreaterThanOrEqual(400);
  });
});
