import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const variable = 'LOAD_SPEC_VARIABLE_FROM_DOTENV';
const schema = z.object({ [variable]: z.string() });

describe('parseEnv y dotenv', () => {
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'orq-dotenv-'));
    writeFileSync(join(workDir, '.env'), `${variable}=desde-el-archivo\n`);
    process.chdir(workDir);
    delete process.env[variable];
    // `dotenvLoaded` es estado del módulo: cada caso necesita una copia nueva.
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(workDir, { recursive: true, force: true });
    delete process.env[variable];
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('fuera de producción carga el .env del directorio de trabajo', async () => {
    process.env.NODE_ENV = 'development';
    const { parseEnv } = await import('./load.js');

    expect(parseEnv(schema)[variable]).toBe('desde-el-archivo');
  });

  it('en producción NO lo carga: la variable faltante hace fallar el arranque', async () => {
    process.env.NODE_ENV = 'production';
    const { parseEnv } = await import('./load.js');

    expect(() => parseEnv(schema)).toThrow(variable);
    expect(process.env[variable]).toBeUndefined();
  });

  it('en producción respeta lo que ya está en el entorno', async () => {
    process.env.NODE_ENV = 'production';
    process.env[variable] = 'desde-el-despliegue';
    const { parseEnv } = await import('./load.js');

    expect(parseEnv(schema)[variable]).toBe('desde-el-despliegue');
  });
});
