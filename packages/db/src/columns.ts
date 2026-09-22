import { customType, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle no trae un helper de `bytea` (a diferencia de `uuid` o `point`).
 * `pg` devuelve columnas `bytea` como `Buffer` de Node por defecto, sin
 * configuración adicional.
 */
export const bytea = customType<{ data: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * `ltree` es un tipo de la extensión del mismo nombre, no algo que Drizzle
 * conozca. Se mapea como texto plano del lado de la aplicación (Postgres lo
 * acepta como literal de texto en `INSERT`/`UPDATE`); las consultas que
 * necesitan los operadores de `ltree` (`<@`, `nlevel()`, etc.) se escriben
 * con `sql` crudo, no con el query builder de Drizzle.
 */
export const ltree = customType<{ data: string }>({
  dataType: () => 'ltree',
});

/**
 * Columnas estándar de toda tabla de negocio (docs/data-model.md, líneas 13-23).
 * `id` no lleva `.defaultRandom()`: los IDs son UUIDv7 generados en el cliente
 * (CLAUDE.md regla dura 6), nunca `gen_random_uuid()` del lado del servidor.
 * `version` lo incrementa un trigger, no la aplicación.
 *
 * `organizationId` y `createdByMemberId` son `text`, no `uuid` (ADR-010):
 * referencian `auth.organization.id` / `auth.member.id`, que Better Auth
 * genera como strings opacos de 32 caracteres, no UUIDs. Una columna `uuid`
 * rechazaría el valor al insertar.
 */
export function standardColumns() {
  return {
    id: uuid('id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    version: integer('version').notNull().default(1),
    createdByMemberId: text('created_by_member_id').notNull(),
  };
}
