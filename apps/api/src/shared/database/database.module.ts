import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { createDb, createPool } from '@orq/db';
import type { Pool } from 'pg';
import { SERVER_ENV, type ServerEnv } from '../config/config.module.js';
import { DB, DB_POOL } from './database.tokens.js';
import { TransactionService } from './transaction.service.js';

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL,
      inject: [SERVER_ENV],
      useFactory: (env: ServerEnv) => createPool({ connectionString: env.DATABASE_URL }),
    },
    {
      provide: DB,
      inject: [DB_POOL],
      useFactory: (pool: Pool) => createDb(pool),
    },
    TransactionService,
  ],
  exports: [DB, DB_POOL, TransactionService],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
