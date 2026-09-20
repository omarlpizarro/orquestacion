import { integer, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Columnas estándar de toda tabla de negocio (docs/data-model.md, líneas 13-23).
 * `id` no lleva `.defaultRandom()`: los IDs son UUIDv7 generados en el cliente
 * (CLAUDE.md regla dura 6), nunca `gen_random_uuid()` del lado del servidor.
 * `version` lo incrementa un trigger, no la aplicación.
 */
export function standardColumns() {
  return {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    version: integer('version').notNull().default(1),
    createdByMemberId: uuid('created_by_member_id').notNull(),
  };
}
