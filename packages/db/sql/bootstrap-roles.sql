-- Bootstrap de roles y extensiones. Corre UNA sola vez, como superusuario,
-- antes de que exista ninguna migración de Drizzle:
--   - infra/docker/postgres/init/00-bootstrap-roles.sh lo ejecuta al iniciar
--     el contenedor de Postgres por primera vez.
--   - packages/db/src/testing/postgres-harness.ts lo ejecuta contra el
--     contenedor de Testcontainers antes de migrar.
--
-- Los passwords NO están acá: los dos callers reemplazan los placeholders
-- __APP_OWNER_PASSWORD__, __APP_LOGIN_PASSWORD__ y __APP_WORKER_PASSWORD__
-- antes de ejecutar este archivo. Nunca va un password real a git.
--
-- Las extensiones se crean acá y no en la migración 0000 porque algunas
-- (pgcrypto) requieren privilegios que un rol no-superusuario puede no
-- tener; 0000_extensions.sql las vuelve a pedir con IF NOT EXISTS para que
-- la migración quede documentada y sea inofensiva si ya existen.

create extension if not exists btree_gist;
create extension if not exists pg_trgm;
create extension if not exists pgcrypto;
create extension if not exists ltree;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_owner') then
    -- Dueño del esquema. Corre las migraciones. La aplicación nunca lo usa.
    create role app_owner login password '__APP_OWNER_PASSWORD__';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    -- Rol de grupo con los permisos de tabla. NOLOGIN: nada se conecta
    -- directamente como app_user, y sin BYPASSRLS las policies siempre
    -- aplican, incluso a este rol.
    create role app_user nologin nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'app_login') then
    -- Rol de conexión de la aplicación. Hereda los permisos de app_user.
    create role app_login login nosuperuser nocreatedb nocreaterole nobypassrls
      password '__APP_LOGIN_PASSWORD__';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'app_worker') then
    -- ADR-017 §5: usuario de base de los workers y los scripts, distinto del
    -- de la API. Las funciones auxiliares de RLS conceden el privilegio de
    -- sistema solo si la sesión se abrió con este usuario (session_user), así
    -- que la API no puede declararse "sistema" aunque fije el GUC. Mismos
    -- permisos de tabla que app_login (los hereda de app_user); sin BYPASSRLS.
    create role app_worker login nosuperuser nocreatedb nocreaterole nobypassrls
      password '__APP_WORKER_PASSWORD__';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'app_rls_helper') then
    -- ADR-017 §3-4: dueño de las funciones auxiliares de RLS por proyecto
    -- (SECURITY DEFINER). Es el ÚNICO rol con BYPASSRLS, y la aplicación nunca
    -- lo usa: NOLOGIN, sin membresías en ningún sentido, nadie puede hacer
    -- SET ROLE hacia él. Sus permisos de tabla (solo SELECT, y solo sobre lo
    -- que las funciones leen) los otorga la migración del PR de
    -- comportamiento, no este archivo: acá todavía no existe ninguna tabla.
    create role app_rls_helper nologin nosuperuser nocreatedb nocreaterole bypassrls;
  end if;
end
$$;

grant app_user to app_login;
grant app_user to app_worker;

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
