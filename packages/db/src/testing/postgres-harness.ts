import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { getContainerRuntimeClient } from 'testcontainers';
import { createDb, createPool, type Db } from '../client.js';

const migrationsFolder = fileURLToPath(new URL('../../migrations', import.meta.url));
const bootstrapRolesSqlPath = fileURLToPath(
  new URL('../../sql/bootstrap-roles.sql', import.meta.url),
);

export interface PostgresHarness {
  container: StartedPostgreSqlContainer;
  /** Pool conectado como app_login: lo que usan los tests de comportamiento. */
  appPool: Pool;
  /** Pool conectado como app_owner: para setup/aserciones administrativas. */
  ownerPool: Pool;
  /** Connection strings crudas, para tests que necesitan configurar su propio Pool (p. ej. max: 1). */
  appConnectionUri: string;
  ownerConnectionUri: string;
  /** Conectado como app_login: para leer/escribir tablas de negocio respetando RLS. */
  db: Db;
  /** Conectado como app_owner: para crear tablas de prueba (DDL) en los meta-tests. */
  ownerDb: Db;
  stop(): Promise<void>;
}

async function preflightDocker(): Promise<void> {
  try {
    await getContainerRuntimeClient();
  } catch (cause) {
    throw new Error(
      'Docker no está corriendo. Arrancá Docker Desktop y reintentá `pnpm test:integration`.',
      { cause },
    );
  }
}

function withCredentials(uri: string, username: string, password: string): string {
  const url = new URL(uri);
  url.username = username;
  url.password = password;
  return url.toString();
}

export async function startPostgresHarness(): Promise<PostgresHarness> {
  await preflightDocker();

  const image = process.env.POSTGRES_IMAGE ?? 'postgres:17-alpine';
  const container = await new PostgreSqlContainer(image).start();

  const superuserUri = container.getConnectionUri();
  const bootstrapSql = readFileSync(bootstrapRolesSqlPath, 'utf8')
    .replaceAll('__APP_OWNER_PASSWORD__', 'app_owner_test_password')
    .replaceAll('__APP_LOGIN_PASSWORD__', 'app_login_test_password');

  const superuserPool = new Pool({ connectionString: superuserUri });
  try {
    await superuserPool.query(bootstrapSql);
  } finally {
    await superuserPool.end();
  }

  const migrationUri = withCredentials(superuserUri, 'app_owner', 'app_owner_test_password');
  const appUri = withCredentials(superuserUri, 'app_login', 'app_login_test_password');

  const ownerPool = createPool({ connectionString: migrationUri });
  const ownerDb = createDb(ownerPool);
  await migrate(ownerDb, { migrationsFolder });

  const appPool = createPool({ connectionString: appUri });
  const db = createDb(appPool);

  return {
    container,
    appPool,
    ownerPool,
    appConnectionUri: appUri,
    ownerConnectionUri: migrationUri,
    db,
    ownerDb,
    async stop() {
      await appPool.end();
      await ownerPool.end();
      await container.stop();
    },
  };
}
