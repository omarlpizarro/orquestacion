import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { installPgBoss } from './pgboss-install.js';

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

    // Mismo proceso y mismo paso que las migraciones de Drizzle: no hay forma
    // de correr unas sin las otras, así que actualizar pg-boss no puede
    // dejar el esquema `pgboss` atrasado.
    await installPgBoss({ connectionString, pool });
    console.log('Esquema pgboss al día.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
