import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { getContainerRuntimeClient } from 'testcontainers';
import { createDb, createPool, type Db } from '../client.js';

const migrationsFolder = fileURLToPath(new URL('../../migrations', import.meta.url));
const sqlFolder = fileURLToPath(new URL('../../sql/', import.meta.url));
const containerSqlFolder = '/bootstrap-sql';

export interface PostgresHarness {
  container: StartedPostgreSqlContainer;
  /** Pool conectado como app_login: lo que usan los tests de comportamiento. */
  appPool: Pool;
  /** Pool conectado como app_owner: para setup/aserciones administrativas. */
  ownerPool: Pool;
  /** Pool conectado como app_worker: el usuario de los workers y los scripts (ADR-017 §5). */
  workerPool: Pool;
  /** Connection strings crudas, para tests que necesitan configurar su propio Pool (p. ej. max: 1). */
  appConnectionUri: string;
  ownerConnectionUri: string;
  workerConnectionUri: string;
  /** Conectado como app_login: para leer/escribir tablas de negocio respetando RLS. */
  db: Db;
  /** Conectado como app_worker: para ejercer el contexto de sistema. */
  workerDb: Db;
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
  // Los mismos dos scripts que corre el init de Postgres en el server, por el
  // mismo camino (psql dentro del contenedor, contraseñas por entorno): lo que
  // se prueba es lo que se despliega.
  const container = await new PostgreSqlContainer(image)
    .withCopyFilesToContainer([
      { source: `${sqlFolder}ensure-roles.sql`, target: `${containerSqlFolder}/ensure-roles.sql` },
      {
        source: `${sqlFolder}bootstrap-roles.sql`,
        target: `${containerSqlFolder}/bootstrap-roles.sql`,
      },
    ])
    .start();

  const superuserUri = container.getConnectionUri();
  const bootstrap = await container.exec(
    [
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      container.getUsername(),
      '-d',
      container.getDatabase(),
      '-f',
      `${containerSqlFolder}/ensure-roles.sql`,
      '-f',
      `${containerSqlFolder}/bootstrap-roles.sql`,
    ],
    {
      env: {
        APP_OWNER_PASSWORD: 'app_owner_test_password',
        APP_LOGIN_PASSWORD: 'app_login_test_password',
        APP_WORKER_PASSWORD: 'app_worker_test_password',
      },
    },
  );
  if (bootstrap.exitCode !== 0) {
    throw new Error(`No se pudieron crear los roles de prueba:
${bootstrap.output}`);
  }

  const migrationUri = withCredentials(superuserUri, 'app_owner', 'app_owner_test_password');
  const appUri = withCredentials(superuserUri, 'app_login', 'app_login_test_password');
  const workerUri = withCredentials(superuserUri, 'app_worker', 'app_worker_test_password');

  const ownerPool = createPool({ connectionString: migrationUri });
  const ownerDb = createDb(ownerPool);
  await migrate(ownerDb, { migrationsFolder });

  const appPool = createPool({ connectionString: appUri });
  const db = createDb(appPool);
  const workerPool = createPool({ connectionString: workerUri });
  const workerDb = createDb(workerPool);

  return {
    container,
    appPool,
    workerPool,
    ownerPool,
    appConnectionUri: appUri,
    ownerConnectionUri: migrationUri,
    workerConnectionUri: workerUri,
    db,
    workerDb,
    ownerDb,
    async stop() {
      await appPool.end();
      await workerPool.end();
      await ownerPool.end();
      await container.stop();
    },
  };
}
