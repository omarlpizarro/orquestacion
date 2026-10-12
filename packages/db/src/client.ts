import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema/index.js';

export type Db = NodePgDatabase<typeof schema>;

/**
 * Cuando una conexión ociosa del pool se rompe (Postgres reinicia, un
 * `pg_terminate_backend`, un corte de red), pg-pool la descarta solo y lo
 * informa con `pool.emit('error', err, client)`. Si el pool no tiene listener
 * de `'error'`, Node lo tira como excepción no capturada y se cae el proceso
 * entero (la API, el worker, un script), aunque el pool ya se haya recuperado:
 * la próxima consulta abre otra conexión. Este listener deja el error en el log
 * y nada más. Dice de qué pool se trata para que en el servidor se entienda.
 *
 * Lo registra `createPool`; los pools que se crean sin pasar por él
 * (`migrate.ts`, el superusuario del harness de tests) lo llaman a mano.
 */
export function attachPoolErrorLogger<T extends Pool>(pool: T, name: string): T {
  pool.on('error', (error: Error & { code?: string }) => {
    const code = error.code ? ` (${error.code})` : '';
    console.error(
      `[pg-pool ${name}] conexión ociosa descartada tras un error${code}: ${error.message}`,
    );
  });
  return pool;
}

/**
 * Único lugar del repo donde se importa `pg` fuera de la capa de base
 * (CLAUDE.md §2.3, regla dura de dependency-cruiser
 * `only-database-layer-touches-the-driver`). `name` identifica el pool en el
 * log (`api`, `auth`, `worker`, `script:<nombre>`).
 */
export function createPool(config: PoolConfig, name: string): Pool {
  return attachPoolErrorLogger(new Pool(config), name);
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}
