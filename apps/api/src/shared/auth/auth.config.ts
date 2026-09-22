import { loadServerEnv } from '@orq/config';
import { createDb, createPool } from '@orq/db';
import { buildAuth } from './build-auth.js';

/**
 * Punto de entrada exclusivo para `npx auth generate --config
 * apps/api/src/shared/auth/auth.config.ts`. Nada del código de la
 * aplicación importa este archivo: en runtime, `AuthModule` construye
 * `auth` con `buildAuth()` a partir del `Db` que `DatabaseModule` ya
 * resuelve de forma perezosa (ver `build-auth.ts`). Este archivo, en
 * cambio, abre su propio pool porque la CLI corre como proceso aparte, sin
 * contenedor de Nest.
 */
const env = loadServerEnv();
const pool = createPool({ connectionString: env.DATABASE_URL });
const db = createDb(pool);

export const auth = buildAuth(env, db);
