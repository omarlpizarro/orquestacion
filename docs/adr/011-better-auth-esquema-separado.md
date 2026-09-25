# 011. Las tablas de Better Auth viven en su propio esquema de Postgres (`auth`)

- **Estado:** aceptada
- **Fecha:** 2026-09-20

## Contexto

`app_apply_tenant_policies()` (`packages/db/migrations/0001_roles_rls.sql`)
recorre `information_schema.columns` buscando cualquier tabla con una
columna `organization_id` en el esquema `public`, y le aplica RLS + la
policy estándar automáticamente. Es idempotente a propósito, para que toda
migración que agregue una tabla de negocio quede cubierta sin escribir la
policy a mano.

El esquema que genera `auth generate` para el plugin `organization` incluye
`member.organization_id` e `invitation.organization_id` — columnas reales,
con ese nombre exacto. Si esas tablas cayeran en `public` (el default), la
próxima vez que corriera cualquier migración que llame a
`app_apply_tenant_policies()` (toda migración de tabla de negocio, por
convención), la función las alcanzaría y les aplicaría RLS.

Eso rompería la autenticación en producción, no en un test: Better Auth
gestiona su propio ciclo de vida de conexión (el `db` que se le pasa a
`drizzleAdapter`), completamente separado de
`withTenantTransaction`/`withSystemTransaction`
(`packages/db/src/transaction.ts`). Nunca setea `app.current_org`. Con RLS
forzado sobre `member`/`invitation`, cualquier operación interna de Better
Auth (login, invitar a alguien, listar miembros) empezaría a ver cero filas
de forma silenciosa.

## Decisión

El adaptador de Drizzle de Better Auth se configura con
`schemaName: 'auth'` (`apps/api/src/shared/auth/auth.config.ts`). La CLI
genera sus tablas dentro de `pgSchema('auth')`
(`packages/db/src/schema/auth/schema.ts`), y `drizzle-kit generate` emite
`CREATE SCHEMA "auth"` automáticamente como parte de la migración
(`0002_auth.sql`).

Como consecuencia, hace falta otorgarle a `app_user` los mismos privilegios
sobre el esquema `auth` que ya tiene sobre `public` — el
`GRANT ... ON ALL TABLES IN SCHEMA public` de `0001_roles_rls.sql` no
alcanza a un esquema nuevo. Esos `GRANT` se agregan a mano al final de
`0002_auth.sql`, después del contenido generado por la CLI, con un
comentario que explica por qué no es parte de lo generado.

## Consecuencias

**A favor**

- `app_apply_tenant_policies()` nunca ve las tablas de Better Auth: su
  filtro (`col.table_schema = 'public'`) las excluye por construcción, sin
  necesitar una lista de exclusión que alguien tiene que acordarse de
  mantener.
- El test paramétrico de aislamiento de tenant de CLAUDE.md §10 (que recorre
  `information_schema` sobre `public`) tampoco las toca — no hace falta una
  excepción ahí tampoco.
- Separación visual clara en cualquier cliente de administración de Postgres
  (`\dn` lista dos esquemas: `public` para negocio, `auth` para identidad).

**En contra, asumido**

- Toda referencia SQL a una tabla de Better Auth desde una migración propia
  necesita el prefijo `auth.` (`REFERENCES auth.organization(id)`, no
  `REFERENCES organization(id)`). Es una línea más larga, sin otro costo.
- Un cliente de administración que solo mire `public` por default no muestra
  las tablas de identidad — hay que saber que existe el esquema `auth`. Se
  documenta acá y en `docs/data-model.md` para que no sea una sorpresa.

## Alternativas descartadas

- **Dejar las tablas de Better Auth en `public` y excluirlas a mano en
  `app_apply_tenant_policies()`** (por ejemplo, con una lista de nombres de
  tabla a ignorar). Descartada: es una lista que hay que acordarse de
  actualizar cada vez que un plugin nuevo de Better Auth agregue una tabla
  con `organizationId` (por ejemplo, si más adelante se habilita `teams` del
  mismo plugin `organization`). Un esquema separado no depende de que nadie
  se acuerde de nada.
- **Aplicarles RLS de verdad, y hacer que Better Auth corra bajo el mismo
  contexto de transacción que el resto de la app.** Requeriría interceptar
  cada llamada interna del adaptador de Better Auth para setear
  `app.current_org` antes de cada query — no hay un punto de extensión
  documentado para eso, y el adaptador no expone sus queries individuales,
  solo operaciones de alto nivel (`create`, `findOne`, etc.). Costo alto para
  un beneficio que el esquema separado ya da gratis: Better Auth de por sí
  filtra por `organizationId` en sus propias queries cuando corresponde,
  RLS sería una segunda capa redundante en este punto específico.
