# 010. `organization_id` y las referencias a `member`/`user` son `text`, no `uuid`

- **Estado:** aceptada
- **Fecha:** 2026-09-20

## Contexto

`docs/data-model.md` fijaba `organization_id uuid NOT NULL` como convención
transversal de toda tabla de negocio, y CLAUDE.md regla dura 6 pide UUIDv7
generado en el cliente para los IDs.

Al instalar Better Auth (`better-auth@1.7.5`, ya elegido en la tabla de
stack) y generar su esquema real con `auth generate`, apareció un hecho
verificable que bloquea aplicar esa convención sin cambios:
`@better-auth/core`'s `generateId` (`dist/utils/id.mjs`) no genera UUIDs — genera
strings alfanuméricos random de 32 caracteres (`a-z`, `A-Z`, `0-9`). La CLI
generó `id: text('id').primaryKey()` para `organization`, `user` y `member`
en `packages/db/src/schema/auth/schema.ts`, consistente con eso.

Una columna Postgres `uuid` valida el formato del literal al insertar. Un id
de Better Auth como `"aB3fK9..."` no es un literal UUID válido: el `INSERT`
se rechaza a nivel de tipo, antes de llegar a cualquier `FOREIGN KEY`. No es
que falte la FK — es que la columna no puede ni guardar el valor.

## Decisión

- `organization_id` en toda tabla de negocio pasa de `uuid` a `text`, con
  `REFERENCES auth.organization(id)` donde corresponda.
- Toda columna que referencia a un miembro (`created_by_member_id`,
  `assignee_member_id`, `actor_member_id`, `author_member_id`,
  `override_by_member_id`, `applied_by_member_id`, `uploaded_by_member_id`,
  `recipient_member_id`, `member_id` en tablas puente) pasa de `uuid` a
  `text`, porque referencia a `auth.member.id` / `auth.user.id`, igual de
  opaco.
- El `id` **propio** de cada tabla de negocio (`task.id`, `project.id`,
  `resource.id`, etc.) sigue siendo `uuid` UUIDv7 generado en el cliente — la
  regla dura 6 de CLAUDE.md no cambia para eso. Solo cambian las columnas que
  apuntan a una identidad de Better Auth.
- Las claves foráneas compuestas `(organization_id, <id>)` entre tablas de
  negocio siguen funcionando igual: Postgres permite mezclar tipos en una
  clave compuesta (`organization_id text` + `id uuid`), y ambos lados de cada
  comparación siguen siendo del mismo tipo columna a columna.
- La policy de RLS (`app_apply_tenant_policies()`,
  `packages/db/migrations/0001_roles_rls.sql`) deja de castear a `::uuid`:
  compara `organization_id` (ahora `text`) directo contra
  `nullif(current_setting('app.current_org', true), '')`, que ya es `text`.
  El `nullif` se mantiene por la razón de siempre (GUC que vuelve a `''`, no
  a `NULL`, tras la primera transacción que lo toca), aunque ya no evita un
  error de cast — evita comparar contra `''` en vez de `NULL`, que es
  cosmético pero más claro.

## Consecuencias

**A favor**

- El esquema de negocio queda alineado con la identidad real que emite
  Better Auth, en vez de una que nunca podría insertarse.
- `packages/db/src/columns.ts` (`standardColumns()`) es el único lugar que
  hay que tocar para que todo slice nuevo herede el tipo correcto — ya se
  actualizó como parte de esta decisión.

**En contra, asumido**

- Es un cambio de convención transversal documentado en fase 1 y nunca antes
  ejercitado contra datos reales (ninguna tabla de negocio existía todavía),
  así que no hay dato en producción que migrar. Si hubiera existido, este
  hubiera sido un cambio de tipo de columna en cada tabla, mucho más caro.
- Perder la propiedad "estructuralmente imposible referenciar una fila de
  otro tenant por typo" que dan los `uuid` (Postgres valida el formato) para
  la columna `organization_id` específicamente: un `text` acepta cualquier
  string. La integridad ahí la sigue dando la `FOREIGN KEY` hacia
  `auth.organization(id)` (rechaza un id que no exista), no el tipo de la
  columna.

## Alternativas descartadas

- **Forzar a Better Auth a generar IDs `uuid`.** Requiere: (1) sobreescribir
  `generateId` con un generador UUIDv7 propio vía
  `advanced.database.generateId`, y (2) reemplazar el `schema.ts` que genera
  la CLI por columnas `uuid` a mano. Descartada porque el punto (2)
  contradice directamente CLAUDE.md §7 ("Tablas generadas por su CLI, no se
  editan a mano") y porque cada `auth generate` futuro (nuevo plugin, nueva
  versión) volvería a generar `text` y habría que reaplicar el override a
  mano — un costo recurrente, no uno solo.
