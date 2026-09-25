import { z } from 'zod';
import { parseEnv } from './load.js';

// El valor literal de .env.example: si el arranque lo ve, es que alguien
// copió el archivo de ejemplo sin generar un secreto propio para este
// ambiente. Mejor no arrancar que firmar sesiones con un secreto público.
const EXAMPLE_BETTER_AUTH_SECRET = 'dev_secret_cambiar_en_cada_ambiente_1234567890';

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  // Conexión con el rol de aplicación (`app_login`), nunca con el dueño del esquema.
  DATABASE_URL: z.url(),
  // Con qué rol se espera que `DATABASE_URL` conecte. `health` lo compara
  // contra `current_user`: si no coinciden, la base está mal configurada.
  DATABASE_APP_ROLE: z.string().default('app_login'),
  // Better Auth: firma cookies de sesión y tokens. Nunca el mismo valor entre
  // ambientes; rotarlo invalida toda sesión activa.
  BETTER_AUTH_SECRET: z
    .string()
    .min(32)
    .refine((value) => value !== EXAMPLE_BETTER_AUTH_SECRET, {
      message:
        'BETTER_AUTH_SECRET tiene el valor de ejemplo de .env.example. Generá uno propio para este ambiente.',
    }),
  // Base URL pública de la API, para los links que Better Auth genera
  // (verificación de email, callbacks de OAuth).
  BETTER_AUTH_URL: z.url(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function loadServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  return parseEnv(serverEnvSchema, source);
}
