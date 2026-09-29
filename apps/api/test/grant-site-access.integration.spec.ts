import { randomUUID } from 'node:crypto';
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
import { addMemberWithRole } from './helpers/add-member-with-role.js';
import { getDefaultSiteId } from './helpers/get-default-site-id.js';
import { extractSessionCookie, signUpAndCreateOrg } from './helpers/sign-up-and-create-org.js';

/**
 * grant-site-access (ADR-015, ADR-016). Contra Postgres real con `app_login`,
 * igual que el resto de los slices: la mitad de las garantías de este (aislamiento
 * entre organizaciones, RLS de `member_site_access`) viven en la base.
 */
describe('POST /tenancy/sites/:site_id/access (integración)', () => {
  let harness: PostgresHarness;
  let app: NestFastifyApplication;
  let auth: Auth;
  let db: Db;

  let organizationId: string;
  let ownerCookie: string;
  let ownerMemberId: string;
  let siteId: string;

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

    // Una organización con un solo sitio (el de ADR-013) para el grueso de los tests.
    const org = await signUpAndCreateOrg(app, 'Constructora Acceso');
    organizationId = org.organizationId;
    ownerCookie = org.cookie;
    ownerMemberId = await memberIdOf(org.cookie);
    siteId = await getDefaultSiteId(db, { organizationId, memberId: ownerMemberId });
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

  function grant(
    cookie: string,
    params: { siteId: string; memberId: string; clientMutationId?: string },
  ) {
    return app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `/tenancy/sites/${params.siteId}/access`,
        headers: { cookie },
        payload: {
          client_mutation_id: params.clientMutationId ?? newId(),
          member_id: params.memberId,
        },
      });
  }

  function inOrganization<T>(orgId: string, memberId: string, run: (tx: Tx) => Promise<T>) {
    return withTenantTransaction(db, { organizationId: orgId, memberId, requestId: newId() }, run);
  }

  async function accessRows(orgId: string, actingMemberId: string, memberId: string) {
    const result = await inOrganization(orgId, actingMemberId, (tx) =>
      tx.execute<{ member_id: string; site_id: string }>(sql`
        select member_id, site_id from member_site_access where member_id = ${memberId}
      `),
    );
    return result.rows;
  }

  async function newSite(orgId: string, actingMemberId: string): Promise<string> {
    const id = newId();
    await inOrganization(orgId, actingMemberId, (tx) =>
      tx.execute(sql`
        insert into site (id, organization_id, name, timezone, is_active)
        values (${id}, ${orgId}, 'Segundo sitio', 'America/Argentina/Buenos_Aires', true)
      `),
    );
    return id;
  }

  describe('autorización', () => {
    it('owner otorga acceso a un miembro de nivel 2/3 y queda la fila', async () => {
      // Segundo sitio para que el otorgamiento automático (ADR-016) no lo haya
      // hecho ya: acá se prueba el otorgamiento explícito.
      const second = await newSite(organizationId, ownerMemberId);
      const operator = await addMemberWithRole(app, auth, {
        organizationId,
        role: 'operator',
        label: 'Operario Explícito',
      });

      const response = await grant(ownerCookie, { siteId: second, memberId: operator.memberId });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ site_id: second, member_id: operator.memberId });
      const rows = await accessRows(organizationId, ownerMemberId, operator.memberId);
      expect(rows.map((row) => row.site_id)).toContain(second);
    });

    it('director también puede otorgar', async () => {
      const director = await addMemberWithRole(app, auth, {
        organizationId,
        role: 'director',
        label: 'Director Otorgante',
      });
      const second = await newSite(organizationId, ownerMemberId);
      const manager = await addMemberWithRole(app, auth, {
        organizationId,
        role: 'manager',
        label: 'Gerente Recibe',
      });

      const response = await grant(director.cookie, { siteId: second, memberId: manager.memberId });

      expect(response.statusCode, response.body).toBe(200);
    });

    it.each(['manager', 'operator'] as const)(
      '%s no puede otorgar: 403 y no queda ninguna fila',
      async (role) => {
        const caller = await addMemberWithRole(app, auth, {
          organizationId,
          role,
          label: `Sin Permiso ${role}`,
        });
        const second = await newSite(organizationId, ownerMemberId);
        const target = await addMemberWithRole(app, auth, {
          organizationId,
          role: 'operator',
          label: `Objetivo ${role}`,
        });

        const response = await grant(caller.cookie, { siteId: second, memberId: target.memberId });

        expect(response.statusCode).toBe(403);
        expect(response.json().data).toMatchObject({ domain_code: 'site_access_grant_forbidden' });
        const rows = await accessRows(organizationId, ownerMemberId, target.memberId);
        expect(rows.map((row) => row.site_id)).not.toContain(second);
      },
    );
  });

  describe('validación', () => {
    it('un miembro de OTRA organización se rechaza, aunque el id exista: 422 y ninguna fila', async () => {
      const other = await signUpAndCreateOrg(app, 'Otra Organizacion');
      const otherOwnerMemberId = await memberIdOf(other.cookie);
      const second = await newSite(organizationId, ownerMemberId);

      const response = await grant(ownerCookie, { siteId: second, memberId: otherOwnerMemberId });

      expect(response.statusCode).toBe(422);
      expect(response.json().data).toMatchObject({ domain_code: 'member_not_in_organization' });
      expect(await accessRows(organizationId, ownerMemberId, otherOwnerMemberId)).toEqual([]);
    });

    it('un miembro que no existe da el mismo error que uno de otra organización', async () => {
      const response = await grant(ownerCookie, {
        siteId,
        memberId: `no-existe-${randomUUID()}`,
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().data).toMatchObject({ domain_code: 'member_not_in_organization' });
    });

    it('un sitio de OTRA organización responde 404', async () => {
      const other = await signUpAndCreateOrg(app, 'Organizacion Con Su Sitio');
      const otherMemberId = await memberIdOf(other.cookie);
      const foreignSiteId = await getDefaultSiteId(db, {
        organizationId: other.organizationId,
        memberId: otherMemberId,
      });
      const operator = await addMemberWithRole(app, auth, {
        organizationId,
        role: 'operator',
        label: 'Operario Sitio Ajeno',
      });

      const response = await grant(ownerCookie, {
        siteId: foreignSiteId,
        memberId: operator.memberId,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().data).toMatchObject({ domain_code: 'site_not_found' });
    });
  });

  describe('owner y director como destinatarios (ADR-016)', () => {
    it.each(['owner', 'director'] as const)(
      'un %s puede recibir una fila: queda registrado que trabaja en ese sitio',
      async (role) => {
        const target = await addMemberWithRole(app, auth, {
          organizationId,
          role,
          label: `Destinatario ${role}`,
        });
        const second = await newSite(organizationId, ownerMemberId);

        const response = await grant(ownerCookie, { siteId: second, memberId: target.memberId });

        expect(response.statusCode, response.body).toBe(200);
        const rows = await accessRows(organizationId, ownerMemberId, target.memberId);
        expect(rows.map((row) => row.site_id)).toEqual([second]);
      },
    );
  });

  describe('idempotencia (CLAUDE.md §10)', () => {
    it('el mismo client_mutation_id dos veces produce un solo efecto y la misma respuesta', async () => {
      const second = await newSite(organizationId, ownerMemberId);
      const operator = await addMemberWithRole(app, auth, {
        organizationId,
        role: 'operator',
        label: 'Operario Idempotente',
      });
      const clientMutationId = newId();

      const first = await grant(ownerCookie, {
        siteId: second,
        memberId: operator.memberId,
        clientMutationId,
      });
      const retry = await grant(ownerCookie, {
        siteId: second,
        memberId: operator.memberId,
        clientMutationId,
      });

      expect(first.statusCode).toBe(200);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(first.json());
      const rows = await accessRows(organizationId, ownerMemberId, operator.memberId);
      expect(rows.filter((row) => row.site_id === second)).toHaveLength(1);
      const logged = await inOrganization(organizationId, ownerMemberId, (tx) =>
        tx.execute(sql`
          select 1 from mutation_log where client_mutation_id = ${clientMutationId}
        `),
      );
      expect(logged.rows).toHaveLength(1);
    });

    it('otorgar un acceso que ya existe, con otro client_mutation_id, no falla ni duplica', async () => {
      const second = await newSite(organizationId, ownerMemberId);
      const operator = await addMemberWithRole(app, auth, {
        organizationId,
        role: 'operator',
        label: 'Operario Repetido',
      });

      const first = await grant(ownerCookie, { siteId: second, memberId: operator.memberId });
      const again = await grant(ownerCookie, { siteId: second, memberId: operator.memberId });

      expect(first.statusCode).toBe(200);
      expect(again.statusCode).toBe(200);
      const rows = await accessRows(organizationId, ownerMemberId, operator.memberId);
      expect(rows.filter((row) => row.site_id === second)).toHaveLength(1);
    });
  });

  describe('aislamiento entre organizaciones (RLS de member_site_access)', () => {
    it('la fila de una organización no se ve desde otra', async () => {
      const second = await newSite(organizationId, ownerMemberId);
      const operator = await addMemberWithRole(app, auth, {
        organizationId,
        role: 'operator',
        label: 'Operario Aislado',
      });
      await grant(ownerCookie, { siteId: second, memberId: operator.memberId });

      const other = await signUpAndCreateOrg(app, 'Espia');
      const spyMemberId = await memberIdOf(other.cookie);
      const seenFromOther = await accessRows(other.organizationId, spyMemberId, operator.memberId);

      expect(seenFromOther).toEqual([]);
    });
  });

  describe('otorgamiento automático en una organización de un solo sitio (ADR-016)', () => {
    it.each(['manager', 'operator'] as const)(
      'un %s nuevo recibe acceso al único sitio',
      async (role) => {
        const org = await signUpAndCreateOrg(app, `Un Solo Sitio ${role}`);
        const orgOwner = await memberIdOf(org.cookie);
        const onlySite = await getDefaultSiteId(db, {
          organizationId: org.organizationId,
          memberId: orgOwner,
        });

        const member = await addMemberWithRole(app, auth, {
          organizationId: org.organizationId,
          role,
          label: `Auto ${role}`,
        });

        const rows = await accessRows(org.organizationId, orgOwner, member.memberId);
        expect(rows).toEqual([{ member_id: member.memberId, site_id: onlySite }]);
      },
    );

    it('todos los miembros reciben fila, sin excepción por rol: también el dueño al crear la organización y un director', async () => {
      const org = await signUpAndCreateOrg(app, 'Un Solo Sitio Nivel 1');
      const orgOwner = await memberIdOf(org.cookie);
      const onlySite = await getDefaultSiteId(db, {
        organizationId: org.organizationId,
        memberId: orgOwner,
      });

      const director = await addMemberWithRole(app, auth, {
        organizationId: org.organizationId,
        role: 'director',
        label: 'Auto Director',
      });

      expect(await accessRows(org.organizationId, orgOwner, director.memberId)).toEqual([
        { member_id: director.memberId, site_id: onlySite },
      ]);
      // El dueño recibe su fila desde afterCreateOrganization: su afterAddMember
      // corre antes de que exista el sitio por defecto (crud-org.mjs), así que
      // sin ese segundo camino se quedaría sin fila.
      expect(await accessRows(org.organizationId, orgOwner, orgOwner)).toEqual([
        { member_id: orgOwner, site_id: onlySite },
      ]);
    });

    it('un director que pasa a manager conserva su acceso al único sitio, sin que nadie intervenga', async () => {
      const org = await signUpAndCreateOrg(app, 'Cambio De Rol');
      const orgOwner = await memberIdOf(org.cookie);
      const onlySite = await getDefaultSiteId(db, {
        organizationId: org.organizationId,
        memberId: orgOwner,
      });
      const director = await addMemberWithRole(app, auth, {
        organizationId: org.organizationId,
        role: 'director',
        label: 'Director Degradado',
      });

      const update = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/api/auth/organization/update-member-role',
          headers: { cookie: org.cookie },
          payload: {
            memberId: director.memberId,
            role: 'manager',
            organizationId: org.organizationId,
          },
        });
      expect(update.statusCode, update.body).toBe(200);

      const role = await inOrganization(org.organizationId, orgOwner, (tx) =>
        tx.execute<{ role: string }>(sql`
          select role from auth.member where id = ${director.memberId}
        `),
      );
      expect(role.rows[0]?.role).toBe('manager');
      expect(await accessRows(org.organizationId, orgOwner, director.memberId)).toEqual([
        { member_id: director.memberId, site_id: onlySite },
      ]);
    });

    it('con más de un sitio no adivina: el miembro nuevo queda sin acceso hasta que alguien lo otorgue', async () => {
      const org = await signUpAndCreateOrg(app, 'Dos Sitios');
      const orgOwner = await memberIdOf(org.cookie);
      await newSite(org.organizationId, orgOwner);

      const member = await addMemberWithRole(app, auth, {
        organizationId: org.organizationId,
        role: 'operator',
        label: 'Auto Sin Elegir',
      });

      expect(await accessRows(org.organizationId, orgOwner, member.memberId)).toEqual([]);
    });

    it('aceptar una invitación también otorga (es otro camino: no dispara afterAddMember)', async () => {
      const org = await signUpAndCreateOrg(app, 'Invitacion Un Sitio');
      const orgOwner = await memberIdOf(org.cookie);
      const onlySite = await getDefaultSiteId(db, {
        organizationId: org.organizationId,
        memberId: orgOwner,
      });
      const fastify = app.getHttpAdapter().getInstance();
      const email = `${randomUUID()}@example.com`;

      const invite = await fastify.inject({
        method: 'POST',
        url: '/api/auth/organization/invite-member',
        headers: { cookie: org.cookie },
        payload: { email, role: 'operator', organizationId: org.organizationId },
      });
      expect(invite.statusCode, invite.body).toBe(200);
      const invitationId = invite.json<{ id: string }>().id;

      const signUp = await fastify.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        payload: { email, password: 'Sup3rSecret!1', name: 'Invitada' },
      });
      expect(signUp.statusCode, signUp.body).toBe(200);
      const inviteeCookie = extractSessionCookie(signUp.headers['set-cookie']);

      const accept = await fastify.inject({
        method: 'POST',
        url: '/api/auth/organization/accept-invitation',
        headers: { cookie: inviteeCookie },
        payload: { invitationId },
      });
      expect(accept.statusCode, accept.body).toBe(200);
      const acceptedMemberId = accept.json<{ member: { id: string } }>().member.id;

      const rows = await accessRows(org.organizationId, orgOwner, acceptedMemberId);
      expect(rows).toEqual([{ member_id: acceptedMemberId, site_id: onlySite }]);
    });
  });
});
