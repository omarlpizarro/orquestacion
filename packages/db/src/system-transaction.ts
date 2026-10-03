import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import type { Tx } from './transaction.js';

export interface SystemContext {
  organizationId: string;
  /** Qué trabajo es, para el rastro: `app.request_id` queda como `system:<job>:<requestId>`. */
  job: string;
  requestId: string;
}

/**
 * Contexto de sistema de ADR-017 §5: una organización fija y visibilidad de
 * todos sus proyectos, sin un miembro detrás. Es para lo que de verdad necesita
 * ver toda la organización (escalamientos, reparaciones); un job que actúa en
 * nombre de una persona usa el contexto de esa persona (`withTenantTransaction`).
 *
 * Fija `app.scope = 'system'` y NO setea `app.current_member`. Eso solo no
 * alcanza para ser "sistema": `app_is_privileged()` exige además
 * `session_user = 'app_worker'`, así que un llamador conectado como `app_login`
 * (la API) obtiene exactamente lo mismo que sin este helper. El privilegio lo
 * concede la identidad de la conexión, no un valor que el código escribe.
 *
 * Se exporta por el subpath `@orq/db/system`, no por el índice del paquete, y
 * solo `apps/worker` y los scripts lo importan; lo hace cumplir
 * `apps/api/src/shared/database/system-transaction-barrier.spec.ts`. Es una
 * barrera contra errores: la barrera contra una API comprometida es el usuario
 * de base.
 */
export async function withSystemTransaction<T>(
  db: Db,
  ctx: SystemContext,
  handler: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select set_config('app.current_org', ${ctx.organizationId}, true),
             set_config('app.scope',       'system',              true),
             set_config('app.request_id',  ${`system:${ctx.job}:${ctx.requestId}`}, true)
    `);
    return handler(tx);
  });
}
