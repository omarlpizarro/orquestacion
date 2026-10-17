import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    // La primera corrida baja la imagen de Postgres.
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
