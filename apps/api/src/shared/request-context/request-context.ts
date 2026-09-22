import { AsyncLocalStorage } from 'node:async_hooks';

/** `organizationId`/`memberId` de Better Auth: siempre `text`, nunca `uuid` (ADR-010). */
export interface TenantIdentity {
  organizationId: string;
  memberId: string;
}

export interface RequestContext {
  requestId: string;
  /** `undefined` si el request no tiene sesión con organización activa (endpoints públicos, guest_link, health). */
  tenant?: TenantIdentity | undefined;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Lanza si no hay contexto: preferimos fallar fuerte a devolver un
 * `requestId` inventado que oculte un middleware mal cableado.
 */
export function getRequestContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error('No hay contexto de request activo. ¿Falta RequestContextMiddleware?');
  }
  return ctx;
}
