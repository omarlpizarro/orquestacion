import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface TenantContext {
  organizationId: string;
  memberId: string;
  requestId: string;
}

export interface SystemContext {
  requestId: string;
}

/**
 * La única forma de llegar a tablas de negocio (CLAUDE.md §7). El tercer
 * parámetro `true` de `set_config` hace el valor local a la transacción: sin
 * él, el pool de conexiones filtra el contexto de un tenant al request
 * siguiente. Es el bug más grave que este sistema puede tener — no se toca
 * sin correr `transaction-context.integration.spec.ts`.
 */
export async function withTenantTransaction<T>(
  db: Db,
  ctx: TenantContext,
  handler: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select set_config('app.current_org',    ${ctx.organizationId}, true),
             set_config('app.current_member', ${ctx.memberId},       true),
             set_config('app.request_id',     ${ctx.requestId},      true)
    `);
    return handler(tx);
  });
}

/**
 * Para trabajo sin tenant (jobs de sistema, health checks). Deliberadamente
 * NO setea `app.current_org`: como toda policy de RLS compara contra
 * `current_setting('app.current_org', true)`, que devuelve NULL cuando no
 * está seteado, el predicado nunca evalúa a TRUE. Una transacción de sistema
 * es estructuralmente incapaz de leer o escribir una fila de tenant.
 */
export async function withSystemTransaction<T>(
  db: Db,
  ctx: SystemContext,
  handler: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.request_id', ${ctx.requestId}, true)`);
    return handler(tx);
  });
}
