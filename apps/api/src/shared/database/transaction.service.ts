import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@orq/db';
import { type Tx, withSystemTransaction, withTenantTransaction } from '@orq/db';
import { getRequestContext } from '../request-context/request-context.js';
import { DB } from './database.tokens.js';

export interface TenantScope {
  organizationId: string;
  memberId: string;
}

/**
 * Envoltorio delgado: la lógica de las dos transacciones vive en
 * packages/db/src/transaction.ts (CLAUDE.md §7 dice que los workers de
 * pg-boss hacen exactamente lo mismo, así que el primitivo no puede vivir
 * solo acá). Este servicio solo agrega el `requestId` desde el
 * AsyncLocalStorage del request actual.
 */
@Injectable()
export class TransactionService {
  constructor(@Inject(DB) private readonly db: Db) {}

  withTenant<T>(scope: TenantScope, handler: (tx: Tx) => Promise<T>): Promise<T> {
    const { requestId } = getRequestContext();
    return withTenantTransaction(this.db, { ...scope, requestId }, handler);
  }

  withSystem<T>(handler: (tx: Tx) => Promise<T>): Promise<T> {
    const { requestId } = getRequestContext();
    return withSystemTransaction(this.db, { requestId }, handler);
  }
}
