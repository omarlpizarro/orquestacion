import { loadWorkerEnv } from '@orq/config';
import { createDb, createPool, withoutTenantTransaction } from '@orq/db';
import { sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';

const QUEUE_HEALTH_PING = 'health.ping';

async function main() {
  const env = loadWorkerEnv();
  const pool = createPool({ connectionString: env.DATABASE_WORKER_URL });
  const db = createDb(pool);

  // El esquema `pgboss` lo instala y actualiza el paso de migraciones
  // (`packages/db/src/pgboss-install.ts`) con las credenciales de app_owner.
  // `app_worker` no es dueño: con `migrate: false` y `createSchema: false`,
  // subir pg-boss sin haber migrado falla fuerte acá, que es lo deseado. Tampoco
  // se usan `persistQueueStats` ni colas `partition: true`: hacen DDL.
  const boss = new PgBoss({
    connectionString: env.DATABASE_WORKER_URL,
    migrate: false,
    createSchema: false,
  });
  boss.on('error', (error: Error) => console.error(error));
  await boss.start();

  // pg-boss v12 exige registrar la cola antes de mandarle o sacarle trabajos.
  await boss.createQueue(QUEUE_HEALTH_PING);

  await boss.work(QUEUE_HEALTH_PING, async () => {
    // Un job que procesa varios tenants abre una transacción por tenant
    // (CLAUDE.md §7); este worker de ejemplo no toca tablas de negocio, así
    // que corre por withoutTenantTransaction, con un `requestId` propio por job.
    await withoutTenantTransaction(db, { requestId: crypto.randomUUID() }, async (tx) => {
      await tx.execute(sql`select 1`);
    });
    console.log('health.ping procesado');
  });

  console.log('worker escuchando en', QUEUE_HEALTH_PING);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
