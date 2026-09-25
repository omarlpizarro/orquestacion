import type { ServerEnv } from '@orq/config';
import type { Db } from '@orq/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { accessControl, organizationRoles } from './access-control.js';

/**
 * Factory pura, sin efectos de lado: `AuthModule` la llama con el `Db` y el
 * `ServerEnv` que `DatabaseModule`/`ConfigModule` ya resuelven de forma
 * perezosa (recién cuando Nest arma el contenedor). `auth.config.ts` —el
 * único archivo que la CLI de Better Auth importa— también la llama, pero
 * con su propio pool, construido a mano en ese momento.
 *
 * Reusar el mismo `Db` que el resto de la app (en vez de un pool propio) es
 * lo que evita que esta factory capture un `DATABASE_URL` obsoleto: si en
 * cambio leyera `process.env` y abriera su propio pool al importarse, algo
 * que solo lo usa por su efecto de lado (como el middleware) fijaría la
 * conexión en el momento del `import`, antes de que un test alcance a
 * apuntar `DATABASE_URL` al contenedor de Testcontainers en su `beforeAll`.
 */
export function buildAuth(env: ServerEnv, db: Db) {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/auth',
    // Verificación de email queda para cuando haya envío de mails wireado
    // (fuera de esta PR); sin eso, exigirla deja el alta inutilizable.
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    database: drizzleAdapter(db, {
      provider: 'pg',
      // Esquema separado de `public` a propósito: así el escaneo genérico de
      // `app_apply_tenant_policies()` (packages/db/migrations/0001_roles_rls.sql)
      // nunca alcanza `organization`/`member`/`invitation`. Si cayeran en
      // `public` con una columna `organization_id`, esa función les aplicaría
      // RLS automáticamente y las consultas internas de Better Auth —que no
      // pasan por `set_config('app.current_org', ...)`— empezarían a ver cero
      // filas silenciosamente (ADR-011).
      schemaName: 'auth',
      transaction: true,
    }),
    plugins: [
      organization({
        ac: accessControl,
        roles: organizationRoles,
        creatorRole: 'owner',
      }),
    ],
  });
}

export type Auth = ReturnType<typeof buildAuth>;
