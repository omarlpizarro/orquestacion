import { z } from 'zod';
import { parseEnv } from './load.js';

export const webEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Se lee en componentes de servidor de Next, nunca en el cliente.
  API_URL: z.url(),
});

export type WebEnv = z.infer<typeof webEnvSchema>;

export function loadWebEnv(source: NodeJS.ProcessEnv = process.env): WebEnv {
  return parseEnv(webEnvSchema, source);
}
