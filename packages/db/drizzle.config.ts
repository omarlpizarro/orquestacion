import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  // drizzle-kit corre con las credenciales de `app_owner`: es quien migra.
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL ?? '',
  },
});
