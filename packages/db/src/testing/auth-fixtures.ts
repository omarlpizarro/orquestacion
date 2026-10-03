import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../client.js';

/**
 * Da de alta una organización y miembros reales en el esquema `auth` para los
 * tests de base. Las funciones de RLS por proyecto (ADR-017) resuelven el rol
 * del miembro desde `auth.member`, así que un `memberId` inventado ya no
 * alcanza: sin fila ahí, no es nadie. Se inserta como dueño del esquema porque
 * `auth.*` no tiene RLS (ADR-011) y no es de la aplicación.
 */
export async function insertAuthOrganization(
  ownerDb: Db,
  params: { id: string; name?: string },
): Promise<void> {
  await ownerDb.execute(sql`
    insert into auth.organization (id, name, slug, created_at)
    values (${params.id}, ${params.name ?? params.id}, ${params.id}, now())
    on conflict (id) do nothing
  `);
}

export async function insertAuthMember(
  ownerDb: Db,
  params: { organizationId: string; memberId: string; role: string },
): Promise<void> {
  const userId = `user_${randomUUID().replaceAll('-', '')}`;
  await ownerDb.execute(sql`
    insert into auth."user" (id, name, email, email_verified, created_at, updated_at)
    values (${userId}, ${params.memberId}, ${`${userId}@example.com`}, true, now(), now())
  `);
  await ownerDb.execute(sql`
    insert into auth.member (id, organization_id, user_id, role, created_at)
    values (${params.memberId}, ${params.organizationId}, ${userId}, ${params.role}, now())
  `);
}
