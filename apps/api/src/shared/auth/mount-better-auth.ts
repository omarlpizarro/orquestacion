import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { fromNodeHeaders } from 'better-auth/node';
import type { Auth } from './build-auth.js';

/**
 * `Headers#forEach` junta todos los `Set-Cookie` repetidos en un solo valor
 * separado por comas (rompe cookies con `Expires`, que ya trae comas) — para
 * eso existe `getSetCookie()`, que los devuelve separados. `setHeader` recibe
 * un array para `set-cookie` justamente para poder emitir varias líneas
 * `Set-Cookie` reales en vez de una sola corrupta.
 */
export function copyResponseHeaders(
  headers: Headers,
  setHeader: (name: string, value: string | string[]) => void,
): void {
  const setCookies = headers.getSetCookie();
  if (setCookies.length > 0) {
    setHeader('set-cookie', setCookies);
  }
  headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    setHeader(key, value);
  });
}

/**
 * Better Auth se monta como ruta plana de Fastify, no como controller de
 * Nest: es una superficie REST propia (ADR-005 la deja fuera de oRPC a
 * propósito). No se usa `toNodeHandler` porque leería `request.raw` después
 * de que Fastify ya consumió el stream al parsear el body — se reconstruye
 * un `Request` estándar a partir del body ya parseado y se llama a
 * `auth.handler` (el handler fetch-native), tal como documenta Better Auth
 * para Fastify.
 */
export function mountBetterAuth(app: NestFastifyApplication, auth: Auth): void {
  app
    .getHttpAdapter()
    .getInstance()
    .all('/api/auth/*', async (request, reply) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const req = new Request(url, {
        method: request.method,
        headers: fromNodeHeaders(request.headers),
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });

      const response = await auth.handler(req);

      reply.status(response.status);
      copyResponseHeaders(response.headers, (name, value) => reply.header(name, value));
      reply.send(response.body ? await response.text() : null);
    });
}
