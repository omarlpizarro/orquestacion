import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organization } from '../auth/schema.js';

/**
 * ADR-007: adelantada desde la migración `sync` planeada (`docs/data-model.md`)
 * porque la idempotencia se adelanta a fase 2. `client_mutation_id` es
 * UUIDv7 generado por el cliente (CLAUDE.md regla dura 6) — no se ve
 * afectado por ADR-010, que es sobre columnas que referencian identidades
 * de Better Auth, no sobre ids que genera el cliente.
 */
export const mutationLog = pgTable(
  'mutation_log',
  {
    clientMutationId: uuid('client_mutation_id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id),
    memberId: text('member_id').notNull(),
    kind: text('kind').notNull(),
    entityId: uuid('entity_id'),
    result: text('result').notNull(),
    rejectionReason: text('rejection_reason'),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('mutation_log_result_check', sql`${table.result} in ('applied','rejected','duplicate')`),
  ],
);
