import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachPoolErrorLogger, createPool } from './client.js';

describe('attachPoolErrorLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('un error del pool deja una línea en el log, con el nombre del pool, y no tira', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pool = attachPoolErrorLogger(new Pool(), 'api');
    const error = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    });

    expect(() => pool.emit('error', error, {})).not.toThrow();

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]?.[0]).toBe(
      '[pg-pool api] conexión ociosa descartada tras un error (57P01): terminating connection due to administrator command',
    );
  });

  it('sin el listener, el mismo error sí tira (lo que tiraba el proceso)', () => {
    const pool = new Pool();
    expect(() => pool.emit('error', new Error('boom'), {})).toThrow('boom');
  });

  it('createPool lo registra', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pool = createPool({}, 'worker');
    expect(() => pool.emit('error', new Error('boom'), {})).not.toThrow();
  });
});

/**
 * Todo `Pool` del repo tiene que pasar por `createPool` o llamar a mano a
 * `attachPoolErrorLogger`: un pool sin listener de `'error'` tira el proceso
 * entero cuando se rompe una conexión ociosa. Esto falla si alguien suma un
 * `new Pool(` en otro lado.
 */
describe('todo Pool lleva el listener de error', () => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const allowed = [
    'packages/db/src/client.ts',
    'packages/db/src/migrate.ts',
    'packages/db/src/testing/postgres-harness.ts',
  ];

  function* sourceFiles(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === '.next') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) yield* sourceFiles(path);
      else if (path.endsWith('.ts') && !path.endsWith('.spec.ts')) yield path;
    }
  }

  const sourceRoots = ['apps', 'packages'].flatMap((group) =>
    readdirSync(join(repoRoot, group))
      .map((name) => join(repoRoot, group, name, 'src'))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      }),
  );
  const creators = sourceRoots
    .flatMap((root) => [...sourceFiles(root)])
    .map((path) => relative(repoRoot, path).split(sep).join('/'))
    .filter((path) => /\bnew Pool\(/.test(readFileSync(join(repoRoot, path), 'utf8')));

  it('solo client.ts, migrate.ts y el harness crean un Pool a mano', () => {
    expect(creators.sort()).toEqual([...allowed].sort());
  });

  it('y cada uno registra el listener', () => {
    for (const path of allowed) {
      expect(readFileSync(join(repoRoot, path), 'utf8'), path).toContain('attachPoolErrorLogger(');
    }
  });
});
