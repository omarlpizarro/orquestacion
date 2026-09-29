import { loadServerEnv } from '@orq/config';
import { createDb, createPool } from '@orq/db';
import { ensureDefaultSitesForAllOrganizations } from '../shared/auth/ensure-default-sites-batch.js';

/**
 * CLI para `ensureDefaultSitesForAllOrganizations` (ver ese archivo para
 * qué hace y por qué). Este archivo solo resuelve la conexión y reporta el
 * resultado — la lógica está separada para poder integration-testearla
 * sin pasar por `process.env`/el ciclo de vida del pool.
 */
async function main() {
  const env = loadServerEnv();
  const pool = createPool({ connectionString: env.DATABASE_URL });
  const db = createDb(pool);

  try {
    const result = await ensureDefaultSitesForAllOrganizations(db);

    console.log(
      `Organizaciones revisadas: ${result.organizationsReviewed}. ` +
        `Sitios creados: ${result.sitesCreated}. ` +
        `Proyectos completados: ${result.projectsBackfilled}. ` +
        `Accesos otorgados: ${result.memberAccessGranted}. ` +
        `Fallidas: ${result.failed.length}.`,
    );
    for (const failure of result.failed) {
      console.error(`Falló la organización ${failure.organizationId}:`, failure.error);
    }
    if (result.failed.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
