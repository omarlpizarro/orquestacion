import { describe, expect, it } from 'vitest';
import { loadServerEnv } from './server.js';

describe('loadServerEnv', () => {
  it('aplica los valores por defecto', () => {
    const env = loadServerEnv({
      DATABASE_URL: 'postgres://app_login:x@localhost:5432/orq',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      BETTER_AUTH_URL: 'http://localhost:3000',
    });
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
  });

  it('lanza un error en español si falta DATABASE_URL', () => {
    expect(() => loadServerEnv({})).toThrowError(/DATABASE_URL/);
  });

  it('rechaza el BETTER_AUTH_SECRET de .env.example', () => {
    expect(() =>
      loadServerEnv({
        DATABASE_URL: 'postgres://app_login:x@localhost:5432/orq',
        BETTER_AUTH_SECRET: 'dev_secret_cambiar_en_cada_ambiente_1234567890',
        BETTER_AUTH_URL: 'http://localhost:3000',
      }),
    ).toThrowError(/BETTER_AUTH_SECRET/);
  });
});
