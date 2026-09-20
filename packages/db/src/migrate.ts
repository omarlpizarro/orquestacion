import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

async function main() {
  const connectionString = process.env.DATABASE_MIGRATION_URL;
  if (!connectionString) {
    throw new Error(
      'Falta DATABASE_MIGRATION_URL: las migraciones corren con las credenciales de app_owner, nunca con las de la aplicación.',
    );
  }

  const pool = new Pool({ connectionString });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
    console.log('Migraciones aplicadas.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
