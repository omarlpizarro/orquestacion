-- Bootstrap de extensiones y dueño del esquema. Corre UNA sola vez, como
-- superusuario, antes de que exista ninguna migración de Drizzle, y DESPUÉS de
-- ensure-roles.sql (que crea los roles; este archivo necesita app_owner):
--   - infra/docker/postgres/init/00-bootstrap-roles.sh lo ejecuta al iniciar
--     el contenedor de Postgres por primera vez.
--   - packages/db/src/testing/postgres-harness.ts lo ejecuta contra el
--     contenedor de Testcontainers antes de migrar.
--
-- Los roles y sus contraseñas ya no están acá: viven en ensure-roles.sql, que
-- lee las contraseñas del entorno. Nunca va un password real a git.
--
-- Las extensiones se crean acá y no en la migración 0000 porque algunas
-- (pgcrypto) requieren privilegios que un rol no-superusuario puede no
-- tener; 0000_extensions.sql las vuelve a pedir con IF NOT EXISTS para que
-- la migración quede documentada y sea inofensiva si ya existen.

create extension if not exists btree_gist;
create extension if not exists pg_trgm;
create extension if not exists pgcrypto;
create extension if not exists ltree;

-- Que app_user no sea dueño de las tablas es esencial: el dueño de una tabla
-- ignora sus propias policies salvo que se fuerce con
-- ALTER TABLE ... FORCE ROW LEVEL SECURITY. app_owner es quien crea y posee
-- todo; app_login nunca puede saltarse una policy porque no es dueño de nada
-- y no tiene BYPASSRLS.
alter schema public owner to app_owner;

-- CREATE de esquema es un privilegio de base de datos, no de schema: sin
-- esto, app_owner no puede crear el esquema "drizzle" que trackea las
-- migraciones (Postgres 15+ ya no lo regala vía PUBLIC).
do $$
begin
  execute format('grant create on database %I to app_owner', current_database());
end
$$;
