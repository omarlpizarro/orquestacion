import { z } from 'zod';
import { parseEnv } from './load.js';

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  // Conexión con el rol de aplicación (`app_login`), nunca con el dueño del esquema.
  DATABASE_URL: z.url(),
  // Con qué rol se espera que `DATABASE_URL` conecte. `health` lo compara
  // contra `current_user`: si no coinciden, la base está mal configurada.
  DATABASE_APP_ROLE: z.string().default('app_login'),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function loadServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  return parseEnv(serverEnvSchema, source);
}
