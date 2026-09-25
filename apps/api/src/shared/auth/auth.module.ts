import { Global, Module } from '@nestjs/common';
import type { Db } from '@orq/db';
import { SERVER_ENV, type ServerEnv } from '../config/config.module.js';
import { DB } from '../database/database.tokens.js';
import { AUTH } from './auth.tokens.js';
import { buildAuth } from './build-auth.js';

@Global()
@Module({
  providers: [
    {
      provide: AUTH,
      inject: [SERVER_ENV, DB],
      useFactory: (env: ServerEnv, db: Db) => buildAuth(env, db),
    },
  ],
  exports: [AUTH],
})
export class AuthModule {}
