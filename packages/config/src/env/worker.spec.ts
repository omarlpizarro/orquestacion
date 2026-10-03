import { describe, expect, it } from 'vitest';
import { loadWorkerEnv } from './worker.js';

describe('loadWorkerEnv', () => {
  it('exige DATABASE_WORKER_URL', () => {
    expect(() => loadWorkerEnv({})).toThrowError(/DATABASE_WORKER_URL/);
  });

  it('no acepta DATABASE_URL (la de la API) como reemplazo', () => {
    expect(() =>
      loadWorkerEnv({ DATABASE_URL: 'postgres://app_login:x@localhost:5432/orq' }),
    ).toThrowError(/DATABASE_WORKER_URL/);
  });

  it('lee la URL del rol de workers', () => {
    const env = loadWorkerEnv({
      DATABASE_WORKER_URL: 'postgres://app_worker:x@localhost:5432/orq',
    });
    expect(env.DATABASE_WORKER_URL).toContain('app_worker');
  });
});
