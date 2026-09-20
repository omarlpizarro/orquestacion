import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
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
