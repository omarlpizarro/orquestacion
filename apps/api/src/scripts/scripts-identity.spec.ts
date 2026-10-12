import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * CLAUDE.md regla dura 4 y ADR-017 §5: los scripts conectan como `app_worker`,
 * no como `app_login` (la identidad de la API). Un script que leyera
 * `DATABASE_URL` / `loadServerEnv` volvería a usar la conexión de la API.
 */
describe('los scripts operativos conectan como app_worker', () => {
  const directory = fileURLToPath(new URL('.', import.meta.url));
  const scripts = readdirSync(directory).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
  );

  it('hay al menos un script que revisar', () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  it.each(scripts)(
    '%s lee DATABASE_WORKER_URL con loadWorkerEnv y no toca la conexión de la API',
    (name) => {
      const source = readFileSync(join(directory, name), 'utf8');
      expect(source).toContain('loadWorkerEnv(');
      expect(source).not.toContain('loadServerEnv');
      expect(source).not.toMatch(/\bDATABASE_URL\b/);
    },
  );
});
