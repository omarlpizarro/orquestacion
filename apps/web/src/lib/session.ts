import { loadWebEnv } from '@orq/config';
import { cookies } from 'next/headers';
import { cache } from 'react';

/**
 * La sesión del pedido, leída por los componentes de servidor (ADR-020). Llama a la API DIRECTO
 * (`API_URL`, la red interna de Compose) reenviando la cookie que trajo el navegador, sin pasar por el
 * proxy. Una sola lectura por pedido: `cache()` la comparte entre el layout y las páginas.
 */
export interface Session {
  userName: string;
  userEmail: string;
  /** `null` si todavía no eligió con qué organización trabajar. */
  activeOrganizationId: string | null;
}

export interface OrganizationSummary {
  id: string;
  name: string;
}

async function authFetch(path: string): Promise<Response | null> {
  const cookieHeader = (await cookies()).toString();
  if (!cookieHeader) return null;
  const { API_URL } = loadWebEnv();
  try {
    const response = await fetch(`${API_URL}${path}`, {
      headers: { cookie: cookieHeader },
      // La sesión cambia cuando la persona entra o sale: nunca se guarda en la caché de Next.
      cache: 'no-store',
    });
    return response.ok ? response : null;
  } catch {
    // La API no responde: para la web es como no tener sesión (va a /login, que lo explica).
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** `null` si no hay sesión (o la API no responde). */
export const getSession = cache(async (): Promise<Session | null> => {
  const response = await authFetch('/api/auth/get-session');
  if (!response) return null;
  // Better Auth responde `null` (el JSON) cuando no hay sesión.
  const body = asRecord(await response.json().catch(() => null));
  const user = asRecord(body?.user);
  const session = asRecord(body?.session);
  if (!user || !session || typeof user.name !== 'string' || typeof user.email !== 'string') {
    return null;
  }
  return {
    userName: user.name,
    userEmail: user.email,
    activeOrganizationId:
      typeof session.activeOrganizationId === 'string' ? session.activeOrganizationId : null,
  };
});

/**
 * El rol de quien consulta en la organización activa (`owner`, `director`, `manager`, `operator`), o `null`.
 * Solo sirve para decidir qué acciones mostrar: la API es quien decide qué se puede hacer de verdad.
 */
export const getActiveMemberRole = cache(async (): Promise<string | null> => {
  const response = await authFetch('/api/auth/organization/get-active-member-role');
  if (!response) return null;
  const body = asRecord(await response.json().catch(() => null));
  return typeof body?.role === 'string' ? body.role : null;
});

/** La organización activa, para mostrar su nombre. `null` si no hay o no se pudo leer. */
export const getActiveOrganization = cache(async (): Promise<OrganizationSummary | null> => {
  const session = await getSession();
  if (!session?.activeOrganizationId) return null;
  const response = await authFetch('/api/auth/organization/list');
  if (!response) return null;
  const list: unknown = await response.json().catch(() => null);
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    const organization = asRecord(item);
    if (
      organization?.id === session.activeOrganizationId &&
      typeof organization.name === 'string'
    ) {
      return { id: organization.id, name: organization.name };
    }
  }
  return null;
});
