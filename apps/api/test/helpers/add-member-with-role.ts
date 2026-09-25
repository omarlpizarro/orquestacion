import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { expect } from 'vitest';
import type { organizationRoles } from '../../src/shared/auth/access-control.js';
import type { Auth } from '../../src/shared/auth/build-auth.js';
import { extractSessionCookie } from './sign-up-and-create-org.js';

export interface MemberWithRole {
  cookie: string;
  memberId: string;
}

/**
 * Agrega un usuario nuevo a una organización existente con un rol
 * específico — para tests de autorización (`hasCapability`), donde hace
 * falta un miembro que no sea `owner`. `auth.api.addMember` es server-only
 * (no pasa por sesión ni por ninguna verificación de permiso propia): es
 * el mismo mecanismo con el que terminaría resolviendo una invitación
 * aceptada, así que usarlo acá no maquilla nada del flujo real.
 */
export async function addMemberWithRole(
  app: NestFastifyApplication,
  auth: Auth,
  params: { organizationId: string; role: keyof typeof organizationRoles; label: string },
): Promise<MemberWithRole> {
  const fastify = app.getHttpAdapter().getInstance();
  const email = `${randomUUID()}@example.com`;

  const signUp = await fastify.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password: 'Sup3rSecret!1', name: params.label },
  });
  expect(signUp.statusCode, signUp.body).toBe(200);
  const userId = signUp.json<{ user: { id: string } }>().user.id;

  const member = await auth.api.addMember({
    body: { userId, organizationId: params.organizationId, role: params.role },
  });
  if (!member) throw new Error('auth.api.addMember no devolvió ningún miembro');

  // El alta no deja seteado `activeOrganizationId` para esta organización
  // (recién se unió a una que no es la única a la que pertenece, en
  // general): sin esto, `resolveTenantIdentity` no encontraría sesión con
  // organización activa y create-task fallaría antes de llegar al chequeo
  // de capacidad que el test quiere ejercitar.
  const setActive = await fastify.inject({
    method: 'POST',
    url: '/api/auth/organization/set-active',
    headers: { cookie: extractSessionCookie(signUp.headers['set-cookie']) },
    payload: { organizationId: params.organizationId },
  });
  expect(setActive.statusCode, setActive.body).toBe(200);
  const cookie = setActive.headers['set-cookie']
    ? extractSessionCookie(setActive.headers['set-cookie'])
    : extractSessionCookie(signUp.headers['set-cookie']);

  return { cookie, memberId: member.id };
}
