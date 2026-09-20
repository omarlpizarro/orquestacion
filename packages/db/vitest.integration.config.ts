import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.integration.spec.ts'],
    // Primera corrida baja la imagen de Postgres; dejamos margen generoso.
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
