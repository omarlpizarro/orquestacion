import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ADR-017 §5: `withSystemTransaction` (`@orq/db/system`) solo lo importan
 * `apps/worker` y los scripts, nunca la ruta de requests. Es una barrera
 * contra errores; la barrera contra una API comprometida es el usuario de base
 * (`session_user = 'app_worker'` en `app_is_privileged()`).
 *
 * Por qué un test y no una regla de dependency-cruiser: el paquete se resuelve
 * a `packages/db/dist/...`, que la configuración excluye a propósito (ver
 * `.dependency-cruiser.cjs`); una regla sobre ese destino quedaría muda en
 * silencio, el mismo problema que el comentario de ese archivo documenta.
 */
const srcRoot = fileURLToPath(new URL('../../', import.meta.url));
const allowedPrefixes = ['scripts/'];
// Un import real, no cualquier mención (un comentario puede nombrar el subpath).
const importsSystemSubpath = /['"]@orq\/db\/system['"]/;

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (path.endsWith('.ts') && !path.endsWith('system-transaction-barrier.spec.ts')) {
      yield path;
    }
  }
}

describe('barrera de withSystemTransaction', () => {
  it('ningún archivo de apps/api/src fuera de scripts/ importa @orq/db/system', () => {
    const offenders = [...sourceFiles(srcRoot)]
      .map((path) => relative(srcRoot, path).split(sep).join('/'))
      .filter((relativePath) => !allowedPrefixes.some((prefix) => relativePath.startsWith(prefix)))
      .filter((relativePath) =>
        importsSystemSubpath.test(readFileSync(join(srcRoot, relativePath), 'utf8')),
      );
    expect(offenders).toEqual([]);
  });
});
