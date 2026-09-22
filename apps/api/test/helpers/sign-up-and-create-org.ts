import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { expect } from 'vitest';

export interface SignedUpOrg {
  cookie: string;
  organizationId: string;
}

function extractSessionCookie(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const sessionCookie = values.find((value) => value.startsWith('better-auth.session_token='));
  if (!sessionCookie) {
    throw new Error(`No se encontró la cookie de sesión en: ${JSON.stringify(values)}`);
  }
  return sessionCookie.split(';')[0] ?? sessionCookie;
}

/**
 * Da de alta un usuario nuevo por email/password y le crea una
 * organización real vía Better Auth (nunca sintética): quien crea la
 * organización queda como `owner` y con `activeOrganizationId` seteado.
 * Reusado por los tests de integración de auth+tenancy y de create-task.
 */
export async function signUpAndCreateOrg(
  app: NestFastifyApplication,
  label: string,
): Promise<SignedUpOrg> {
  const fastify = app.getHttpAdapter().getInstance();
  const email = `${randomUUID()}@example.com`;

  const signUp = await fastify.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password: 'Sup3rSecret!1', name: label },
  });
  expect(signUp.statusCode, signUp.body).toBe(200);
  const cookie = extractSessionCookie(signUp.headers['set-cookie']);

  const createOrg = await fastify.inject({
    method: 'POST',
    url: '/api/auth/organization/create',
    headers: { cookie },
    payload: {
      name: label,
      slug: `${label.toLowerCase().replaceAll(' ', '-')}-${randomUUID().slice(0, 8)}`,
    },
  });
  expect(createOrg.statusCode, createOrg.body).toBe(200);
  const organization = createOrg.json<{ id: string }>();

  return { cookie, organizationId: organization.id };
}
