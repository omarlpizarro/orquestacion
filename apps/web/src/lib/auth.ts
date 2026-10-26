import { organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/**
 * Único punto de contacto de `apps/web` con el cliente de Better Auth (ADR-020), igual que `api.ts` lo es
 * con oRPC: `dependency-cruiser` hace cumplir que ningún otro archivo lo importe.
 *
 * Es el cliente del NAVEGADOR. Sin `baseURL`, Better Auth usa el origen de la página + `/api/auth`, que es
 * justo lo que reescribe el proxy del mismo origen hacia la API (`next.config.ts`): las cookies de sesión
 * son de la web y la API no necesita CORS. Los componentes de servidor no lo usan: leen la sesión con
 * `lib/session.ts`, que llama a la API directo reenviando la cookie.
 */
export const authClient = createAuthClient({
  plugins: [organizationClient()],
});
