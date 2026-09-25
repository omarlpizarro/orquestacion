import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@orq/db';
import { type Tx, withSystemTransaction, withTenantTransaction } from '@orq/db';
import { getRequestContext } from '../request-context/request-context.js';
import { DB } from './database.tokens.js';

/**
 * Envoltorio delgado: la lógica de las dos transacciones vive en
 * packages/db/src/transaction.ts (CLAUDE.md §7 dice que los workers de
 * pg-boss hacen exactamente lo mismo, así que el primitivo no puede vivir
 * solo acá). Este servicio agrega el `requestId` y la identidad de tenant
 * (`organizationId`/`memberId`) desde el `RequestContext` que
 * `RequestContextMiddleware` resolvió a partir de la sesión de Better Auth
 * — nunca los recibe como parámetro, para que no exista una vía por la que
 * un handler termine operando sobre el tenant de otra sesión.
 */
@Injectable()
export class TransactionService {
  constructor(@Inject(DB) private readonly db: Db) {}

  withTenant<T>(handler: (tx: Tx) => Promise<T>): Promise<T> {
    const { requestId, tenant } = getRequestContext();
    if (!tenant) {
      throw new Error(
        'No hay organización activa en este request. ¿El endpoint debería requerir sesión?',
      );
    }
    return withTenantTransaction(this.db, { ...tenant, requestId }, handler);
  }

  withSystem<T>(handler: (tx: Tx) => Promise<T>): Promise<T> {
    const { requestId } = getRequestContext();
    return withSystemTransaction(this.db, { requestId }, handler);
  }
}
