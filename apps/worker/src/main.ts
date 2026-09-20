import { loadServerEnv } from '@orq/config';
import { createDb, createPool, withSystemTransaction } from '@orq/db';
import { sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';

const QUEUE_HEALTH_PING = 'health.ping';

async function main() {
  const env = loadServerEnv();
  const pool = createPool({ connectionString: env.DATABASE_URL });
  const db = createDb(pool);

  const boss = new PgBoss(env.DATABASE_URL);
  boss.on('error', (error: Error) => console.error(error));
  await boss.start();

  // pg-boss v12 exige registrar la cola antes de mandarle o sacarle trabajos.
  await boss.createQueue(QUEUE_HEALTH_PING);

  await boss.work(QUEUE_HEALTH_PING, async () => {
    // Un job que procesa varios tenants abre una transacción por tenant
    // (CLAUDE.md §7); este worker de ejemplo no toca tablas de negocio, así
    // que corre por withSystemTransaction, con un `requestId` propio por job.
    await withSystemTransaction(db, { requestId: crypto.randomUUID() }, async (tx) => {
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
