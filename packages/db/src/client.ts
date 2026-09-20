import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema/index.js';

export type Db = NodePgDatabase<typeof schema>;

/**
 * Único lugar del repo donde se importa `pg` fuera de la capa de base
 * (CLAUDE.md §2.3, regla dura de dependency-cruiser
 * `only-database-layer-touches-the-driver`).
 */
export function createPool(config: PoolConfig): Pool {
  return new Pool(config);
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}
