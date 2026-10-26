import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/**
 * ADR-020: el navegador solo habla con el origen de la web. Estos dos prefijos se reescriben hacia la
 * API: Better Auth (`/api/auth/*`) y los endpoints de negocio (`/backend/*` → `/*`). Así las cookies de
 * sesión son de primera mano, la API no necesita CORS, y el esquema del origen de la web decide si salen
 * `Secure`.
 *
 * Ojo: `rewrites()` se evalúa en el BUILD y el destino queda grabado en el manifiesto de rutas, no se lee
 * al arrancar. Por eso `API_URL` es un argumento de build de la imagen (`web.Dockerfile`), no solo una
 * variable de entorno del contenedor. En Compose la API siempre es `http://api:3000` (la red interna).
 */
const apiUrl = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

const nextConfig: NextConfig = {
  // Imagen mínima para el servidor (`.next/standalone`). La raíz del monorepo tiene que ser la raíz de
  // rastreo, o los paquetes de workspace (`@orq/config`, `@orq/contracts`, `@orq/ui-tokens`) no se incluyen.
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  poweredByHeader: false,
  async rewrites() {
    return [
      { source: '/api/auth/:path*', destination: `${apiUrl}/api/auth/:path*` },
      { source: '/backend/:path*', destination: `${apiUrl}/:path*` },
    ];
  },
};

export default nextConfig;
