import type { Pool } from 'pg';
import { PgBoss } from 'pg-boss';

/**
 * Instala o actualiza el esquema `pgboss` y le otorga a `app_worker` lo mínimo
 * para trabajar. Forma parte del paso de migraciones (`migrate.ts`), no es un
 * paso aparte: así subir la versión de pg-boss nunca puede saltearse la
 * actualización de su esquema.
 *
 * Por qué acá y no en el worker: con los defaults, `PgBoss.start()` crea el
 * esquema si falta y lo migra si está atrasado, y eso exige ser dueño. El
 * worker conecta como `app_worker`, que no lo es, así que arranca con
 * `migrate: false` y falla fuerte si el esquema no está al día.
 *
 * Corre con las credenciales de `app_owner`. `supervise` y `schedule` apagados:
 * este proceso instala y se va, no procesa trabajos.
 */
export async function installPgBoss(params: {
  connectionString: string;
  pool: Pool;
}): Promise<void> {
  const boss = new PgBoss({
    connectionString: params.connectionString,
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
  });
  boss.on('error', (error: Error) => console.error(error));

  try {
    await boss.start();
    await grantWorkerAccess(params.pool);
  } finally {
    // Sin esto el pool de pg-boss mantiene vivo el event loop y el contenedor
    // de migraciones queda colgado (y `deploy.sh` esperándolo). `graceful:
    // false` porque no hay trabajos que terminar; `close` (default) cierra el pool.
    await boss.stop({ graceful: false, close: true });
  }
}

/**
 * Se vuelve a ejecutar en cada corrida, a propósito: una actualización de
 * pg-boss puede traer tablas nuevas y `GRANT ... ON ALL TABLES` solo cubre las
 * que existen. `ALTER DEFAULT PRIVILEGES` cubre las que aparezcan después sin
 * depender de que esta función corra de nuevo. Solo permisos de datos, nunca
 * DDL: `persistQueueStats` y las colas `partition: true` hacen DDL y no andan
 * con `app_worker` (verificado), así que el worker no las usa.
 */
async function grantWorkerAccess(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('grant usage on schema pgboss to app_worker');
    await client.query(
      'grant select, insert, update, delete on all tables in schema pgboss to app_worker',
    );
    await client.query('grant usage, select on all sequences in schema pgboss to app_worker');
    await client.query(`
      alter default privileges for role app_owner in schema pgboss
        grant select, insert, update, delete on tables to app_worker
    `);
    await client.query(`
      alter default privileges for role app_owner in schema pgboss
        grant usage, select on sequences to app_worker
    `);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
