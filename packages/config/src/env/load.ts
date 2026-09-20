import { config as loadDotenv } from 'dotenv';
import type { z } from 'zod';

let dotenvLoaded = false;

function ensureDotenvLoaded(): void {
  if (dotenvLoaded) return;
  loadDotenv();
  dotenvLoaded = true;
}

export function parseEnv<Schema extends z.ZodType>(
  schema: Schema,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<Schema> {
  ensureDotenvLoaded();

  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Variables de entorno inválidas o faltantes:\n${issues}\n\nRevisá tu archivo .env contra .env.example.`,
    );
  }
  return result.data;
}
