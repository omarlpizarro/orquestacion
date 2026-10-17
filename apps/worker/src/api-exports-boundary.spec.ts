import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ADR-019: el worker corre código de los módulos de la API, pero solo el que cada módulo exporta.
 * `@orq/api` cierra el paquete con `exports` (un entry por archivo de módulo): Node rechaza
 * cualquier otra ruta, un internal incluido. `dependency-cruiser` cubre el import relativo que se
 * salte el paquete; esto cubre que el paquete en sí no se abra por descuido (un `"./*"` en
 * `exports`, por ejemplo).
 *
 * Se resuelve en un proceso aparte, con el resolvedor de Node de verdad: dentro de vitest los
 * imports pasan por el resolvedor de Vite, que no es el que corre en producción.
 */
const workerDir = fileURLToPath(new URL('..', import.meta.url));

function resolveFromWorker(
  specifier: string,
): { ok: true; url: string } | { ok: false; code: string } {
  const script = `
    try { console.log(JSON.stringify({ ok: true, url: import.meta.resolve(${JSON.stringify(specifier)}) })); }
    catch (error) { console.log(JSON.stringify({ ok: false, code: error.code })); }
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: workerDir,
    encoding: 'utf8',
  });
  return JSON.parse(out.trim());
}

describe('@orq/api: lo único que el worker puede importar', () => {
  it.each(['collaboration', 'notifications', 'projects', 'tenancy'])(
    'el archivo de módulo de %s se puede importar',
    (name) => {
      const resolved = resolveFromWorker(`@orq/api/${name}`);
      expect(resolved.ok).toBe(true);
      expect(resolved.ok && resolved.url).toMatch(
        new RegExp(`/modules/${name}/${name}\\.module\\.js$`),
      );
    },
  );

  it.each([
    '@orq/api/projects/domain/task-block-audience',
    '@orq/api/projects/domain/task-block-audience.js',
    '@orq/api/projects/project-audience.service.js',
    '@orq/api/modules/projects/projects.module.js',
    '@orq/api/dist/src/modules/projects/projects.module.js',
    '@orq/api/src/modules/projects/projects.module.ts',
    '@orq/api/shared/database/transaction.service.js',
  ])('un internal como %s lo rechaza el paquete', (specifier) => {
    expect(resolveFromWorker(specifier)).toEqual({
      ok: false,
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    });
  });
});
