-- ADR-015: `member_site_access` significa solo "este miembro trabaja en este
-- sitio". El rol de un miembro sale siempre de la organización
-- (`auth.member.role`); una columna `role` acá sería una segunda copia que la
-- autorización ignora y que va a divergir.
--
-- Esto es un DROP COLUMN, y la regla dura 7 (CLAUDE.md §2) y el principio de
-- §6 ("las migraciones solo agregan y no rompen lo que usa el código
-- anterior") lo restringen: normalmente se deja de escribir la columna, se
-- despliega, se verifica y recién en un despliegue posterior se borra. Acá la
-- condición de fondo de esa regla ya se cumple sin un despliegue previo:
--   * Ningún código de la aplicación leyó ni escribió nunca esta columna:
--     `member_site_access` solo aparece en su esquema, en `0003_tenancy.sql` y
--     en comentarios (verificado con una búsqueda en `apps/` y `packages/`).
--     El código desplegado antes de esta migración no la usa, así que una
--     vuelta atrás a él sigue funcionando.
--   * La tabla está vacía en el único ambiente que existe (verificado con un
--     SELECT de solo lectura en el server de demo).
--
-- El CHECK de la columna se borra explícitamente antes que ella, tal como lo
-- genera drizzle-kit; dejarlo lo haría caer solo con la columna, pero así el
-- historial queda a la vista.
--
-- SET LOCAL lock_timeout, mismo motivo que en 0009/0010: DROP COLUMN pide un
-- lock exclusivo; si hay una transacción larga abierta sobre la tabla, mejor
-- fallar rápido y reintentar que encolarse y bloquear toda consulta detrás.
-- LOCAL para que no sobreviva al COMMIT ni quede pegado a la conexión del
-- pool de `app_owner`.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "member_site_access" DROP CONSTRAINT "member_site_access_role_check";--> statement-breakpoint
ALTER TABLE "member_site_access" DROP COLUMN "role";
