import { type Db, withoutTenantTransaction } from '@orq/db';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

export const AUDIT_MAINTAIN_QUEUE = 'audit.maintain';

/** Cuántos meses se mantienen creados, contando el actual. La función de base admite hasta 24. */
export const AUDIT_PARTITIONS_AHEAD_MONTHS = 13;

/**
 * Cuánto espera el job por un lock antes de rendirse. Si hay una transacción larga abierta
 * sobre alguna tabla que necesita bloquear, falla (55P03) y pg-boss reintenta, en lugar de
 * quedar encolado y bloquear todo lo que llegue detrás. Un día sin particiones por crear no
 * toma ningún lock fuerte (migración 0020); esto cubre el día en que sí hay que crear una.
 */
export const AUDIT_LOCK_TIMEOUT_MS = 5_000;

/**
 * Umbral de retención del audit (ADR-018). Solo informa: pasado el umbral la política
 * futura es archivar (DETACH, exportar, verificar, DROP), no borrar, y no existe todavía.
 * Este job no toca ninguna partición vieja.
 */
export const AUDIT_RETENTION_MONTHS = 60;

const PARTITION_NAME = /^audit_log_(\d{4})_(\d{2})$/;

export interface AuditPartitionSummary {
  /** Particiones mensuales posteriores al mes actual. */
  monthsAhead: number;
  /** Nombres de las particiones más viejas que el umbral de retención. */
  beyondRetention: string[];
}

/** Número de mes absoluto (año * 12 + mes), para comparar y restar meses sin fechas. */
const monthIndex = (year: number, month: number) => year * 12 + (month - 1);

export function summarizeAuditPartitions(
  names: readonly string[],
  now: Date,
  retentionMonths: number = AUDIT_RETENTION_MONTHS,
): AuditPartitionSummary {
  const current = monthIndex(now.getUTCFullYear(), now.getUTCMonth() + 1);
  let monthsAhead = 0;
  const beyondRetention: string[] = [];
  for (const name of [...names].sort()) {
    const match = PARTITION_NAME.exec(name);
    if (!match) continue; // `audit_log_default` y cualquier otra cosa que no sea mensual.
    const index = monthIndex(Number(match[1]), Number(match[2]));
    if (index > current) monthsAhead += 1;
    if (index < current - retentionMonths) beyondRetention.push(name);
  }
  return { monthsAhead, beyondRetention };
}

/**
 * Asegura las particiones mensuales de `audit_log`. Idempotente: se puede correr todos
 * los días. Si la partición `DEFAULT` ya tiene filas de un mes por crear, Postgres
 * rechaza la creación (`23514`) y el job falla fuerte, a propósito: es una falla que una
 * persona tiene que mirar, no algo para arreglar solo (ADR-018). Si no consigue un lock en
 * `lockTimeoutMs`, falla y pg-boss reintenta.
 *
 * Corre sin tenant: la función es SECURITY DEFINER del dueño y no lee filas de negocio.
 * Las particiones se leen del catálogo, que no tiene RLS.
 */
export async function maintainAuditPartitions(
  db: Db,
  requestId: string,
  options: { now?: Date; lockTimeoutMs?: number } = {},
): Promise<AuditPartitionSummary> {
  const { now = new Date(), lockTimeoutMs = AUDIT_LOCK_TIMEOUT_MS } = options;
  const names = await withoutTenantTransaction(db, { requestId }, async (tx) => {
    // `is_local = true`: vale solo para esta transacción y no queda pegado a la conexión.
    await tx.execute(sql`select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`);
    await tx.execute(
      sql`select public.app_ensure_audit_partitions((now() at time zone 'UTC')::date, ${AUDIT_PARTITIONS_AHEAD_MONTHS})`,
    );
    const result = await tx.execute<{ relname: string }>(sql`
      select c.relname
        from pg_catalog.pg_inherits i
        join pg_catalog.pg_class c on c.oid = i.inhrelid
       where i.inhparent = 'public.audit_log'::regclass
    `);
    return result.rows.map((row) => row.relname);
  });
  return summarizeAuditPartitions(names, now);
}

/**
 * Particiones de `audit_log` (ADR-018): una corrida al arrancar y otra todos los días.
 * La función de base es idempotente, así que repetir no cuesta nada, y como mantiene
 * 13 meses por delante un día perdido no es crítico.
 */
export async function startAuditMaintenance(boss: PgBoss, db: Db) {
  // Reintentos con espera creciente: una falla de conexión pasajera no debería
  // quedar como falla del día.
  await boss.createQueue(AUDIT_MAINTAIN_QUEUE, {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
  });

  await boss.work(AUDIT_MAINTAIN_QUEUE, async () => {
    const summary = await maintainAuditPartitions(db, crypto.randomUUID());
    console.log(`audit.maintain: ${summary.monthsAhead} mes(es) de particiones hacia adelante.`);
    if (summary.beyondRetention.length > 0) {
      // Solo se informa: no se borra ni se archiva nada (ADR-018).
      console.warn(
        `audit.maintain: ${summary.beyondRetention.length} partición(es) pasaron el umbral de retención de ${AUDIT_RETENTION_MONTHS} meses (${summary.beyondRetention.join(', ')}). No se tocan.`,
      );
    }
    return summary;
  });

  await boss.schedule(AUDIT_MAINTAIN_QUEUE, '0 3 * * *', null, { tz: 'UTC' });
  // Al arrancar, para que un despliegue deje las particiones al día sin esperar a las 3.
  // La clave evita acumular una corrida por cada reinicio seguido.
  await boss.send(AUDIT_MAINTAIN_QUEUE, {}, { singletonKey: 'startup', singletonSeconds: 3600 });
}
