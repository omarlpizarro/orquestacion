import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { idSchema, newId } from '@orq/contracts';
import { fromNodeHeaders } from 'better-auth/node';
import { AUTH } from '../auth/auth.tokens.js';
import type { Auth } from '../auth/build-auth.js';
import { runWithRequestContext, type TenantIdentity } from './request-context.js';

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Middleware de Nest (no hook de Fastify): `storage.run(ctx, next)` desde
 * middleware propaga de forma confiable por todo el ciclo de vida del
 * request. Un hook de Fastify necesitaría `enterWith()`, que la
 * documentación de Node desaconseja.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  async use(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
    const headerValue = req.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const requestId = candidate && idSchema.safeParse(candidate).success ? candidate : newId();
    res.setHeader(REQUEST_ID_HEADER, requestId);

    const tenant = await resolveTenantIdentity(this.auth, req.headers);
    runWithRequestContext({ requestId, tenant }, next);
  }
}

/**
 * `undefined` es una respuesta válida y frecuente: endpoints públicos,
 * `guest_link` (nivel 4, nunca tiene sesión) y cualquier request sin cookie
 * de sesión. Un error de Better Auth al leerla (cookie corrupta, etc.)
 * tampoco debe romper el request entero — se trata igual que "sin tenant" y
 * el handler que necesite `app.current_org` lo va a rechazar explícitamente.
 */
export async function resolveTenantIdentity(
  auth: Auth,
  headers: IncomingHttpHeaders,
): Promise<TenantIdentity | undefined> {
  try {
    const fetchHeaders = fromNodeHeaders(headers);
    const session = await auth.api.getSession({ headers: fetchHeaders });
    if (!session?.session.activeOrganizationId) return undefined;

    const member = await auth.api.getActiveMember({ headers: fetchHeaders });
    return { organizationId: member.organizationId, memberId: member.id };
  } catch {
    return undefined;
  }
}
