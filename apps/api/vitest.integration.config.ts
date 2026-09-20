import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.integration.spec.ts'],
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
