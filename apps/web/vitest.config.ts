import { defineConfig } from 'vitest/config';

export default defineConfig({
  // El `tsconfig.json` de la web dice `jsx: preserve` (lo compila Next); en los tests el JSX se transforma.
  // Vite 8 transforma con Oxc, no con esbuild.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.{ts,tsx}'],
    passWithNoTests: true,
    // La primera compilación de Tailwind tarda más que un test común.
    testTimeout: 30_000,
  },
});
