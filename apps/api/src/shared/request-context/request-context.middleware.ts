import type { IncomingMessage, ServerResponse } from 'node:http';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { idSchema, newId } from '@orq/contracts';
import { runWithRequestContext } from './request-context.js';

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Middleware de Nest (no hook de Fastify): `storage.run(ctx, next)` desde
 * middleware propaga de forma confiable por todo el ciclo de vida del
 * request. Un hook de Fastify necesitaría `enterWith()`, que la
 * documentación de Node desaconseja.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    const headerValue = req.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const requestId = candidate && idSchema.safeParse(candidate).success ? candidate : newId();

    res.setHeader(REQUEST_ID_HEADER, requestId);
    runWithRequestContext({ requestId }, next);
  }
}
