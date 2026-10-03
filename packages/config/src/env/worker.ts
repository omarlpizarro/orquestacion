import { z } from 'zod';
import { parseEnv } from './load.js';

export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Conexión con el rol `app_worker` (ADR-017 §5), no con `app_login`: el
  // contexto de sistema de las policies lo concede la identidad de la
  // conexión, así que un worker con la URL de la API no tendría ese permiso.
  DATABASE_WORKER_URL: z.url(),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return parseEnv(workerEnvSchema, source);
}
