-- Crea (o repara) los roles de la aplicación. Idempotente: se puede correr las
-- veces que haga falta. Única fuente de la creación de roles:
--   - infra/docker/postgres/init/00-bootstrap-roles.sh lo corre al crear el
--     volumen de Postgres, junto con bootstrap-roles.sql.
--   - packages/db/src/testing/postgres-harness.ts lo corre contra el
--     contenedor de Testcontainers antes de migrar.
--   - En un ambiente que ya existe (el server de demo) lo corre una persona,
--     como superusuario, ANTES de las migraciones que dependen de los roles
--     (ver README, "Despliegue").
--
-- Las contraseñas llegan por variable de ENTORNO y las lee psql con \getenv:
-- nunca van como argumento de línea de comando (quedarían en la lista de
-- procesos y en el historial) ni se sustituyen con sed (una contraseña con
-- "/" o "&" rompería la sustitución). format(%L) las cita sea cual sea su
-- contenido.
--
--   APP_OWNER_PASSWORD, APP_LOGIN_PASSWORD, APP_WORKER_PASSWORD
--
-- Solo se usan para crear un rol que falta. NO cambia la contraseña de un rol
-- que ya existe.

\getenv app_owner_password APP_OWNER_PASSWORD
\getenv app_login_password APP_LOGIN_PASSWORD
\getenv app_worker_password APP_WORKER_PASSWORD

-- \getenv deja la variable sin definir si el entorno no la tiene; se normaliza
-- a vacío para que el chequeo de abajo sea uno solo.
\if :{?app_owner_password} \else \set app_owner_password '' \endif
\if :{?app_login_password} \else \set app_login_password '' \endif
\if :{?app_worker_password} \else \set app_worker_password '' \endif

-- Falla fuerte y con el nombre de la variable, con una excepción y no con
-- \quit (en psql 17 \quit no admite código de salida y terminaría en 0): un rol creado con contraseña
-- vacía no podría conectarse y nadie se enteraría hasta que arrancara algo.
select
  (not exists (select 1 from pg_roles where rolname = 'app_owner')
     and :'app_owner_password' = '') as missing_owner,
  (not exists (select 1 from pg_roles where rolname = 'app_login')
     and :'app_login_password' = '') as missing_login,
  (not exists (select 1 from pg_roles where rolname = 'app_worker')
     and :'app_worker_password' = '') as missing_worker
\gset
\if :missing_owner
  do $$ begin raise exception 'falta APP_OWNER_PASSWORD (el rol app_owner no existe todavía).'; end $$;
\endif
\if :missing_login
  do $$ begin raise exception 'falta APP_LOGIN_PASSWORD (el rol app_login no existe todavía).'; end $$;
\endif
\if :missing_worker
  do $$ begin raise exception 'falta APP_WORKER_PASSWORD (el rol app_worker no existe todavía).'; end $$;
\endif

-- Dueño del esquema. Corre las migraciones. La aplicación nunca lo usa.
select format('create role app_owner login password %L', :'app_owner_password')
 where not exists (select 1 from pg_roles where rolname = 'app_owner')
\gexec

-- Rol de grupo con los permisos de tabla. NOLOGIN: nada se conecta
-- directamente como app_user, y sin BYPASSRLS las policies siempre aplican,
-- incluso a este rol.
select 'create role app_user nologin'
 where not exists (select 1 from pg_roles where rolname = 'app_user')
\gexec

-- Rol de conexión de la API. Hereda los permisos de app_user.
select format('create role app_login login password %L', :'app_login_password')
 where not exists (select 1 from pg_roles where rolname = 'app_login')
\gexec

-- ADR-017 §5: usuario de base de los workers y los scripts, distinto del de la
-- API. Las funciones auxiliares de RLS conceden el privilegio de sistema solo
-- si la sesión se abrió con este usuario (session_user), así que la API no
-- puede declararse "sistema" aunque fije el GUC. Mismos permisos de tabla que
-- app_login (los hereda de app_user); sin BYPASSRLS.
select format('create role app_worker login password %L', :'app_worker_password')
 where not exists (select 1 from pg_roles where rolname = 'app_worker')
\gexec

-- ADR-017 §3-4: dueño de las funciones auxiliares de RLS por proyecto
-- (SECURITY DEFINER). Es el ÚNICO rol con BYPASSRLS, y la aplicación nunca lo
-- usa: NOLOGIN, sin membresías en ningún sentido, nadie puede hacer SET ROLE
-- hacia él. Sus permisos de tabla (solo SELECT, y solo sobre lo que las
-- funciones leen) los otorga la migración, no este archivo.
select 'create role app_rls_helper nologin'
 where not exists (select 1 from pg_roles where rolname = 'app_rls_helper')
\gexec

-- En cada corrida se reafirman los atributos, para reparar una deriva (alguien
-- que haya hecho un ALTER ROLE a mano).
alter role app_owner login nosuperuser nocreatedb nocreaterole nobypassrls;
alter role app_user nologin nosuperuser nocreatedb nocreaterole nobypassrls;
alter role app_login login nosuperuser nocreatedb nocreaterole nobypassrls;
alter role app_worker login nosuperuser nocreatedb nocreaterole nobypassrls;
alter role app_rls_helper nologin nosuperuser nocreatedb nocreaterole bypassrls;

grant app_user to app_login;
grant app_user to app_worker;

-- Verificación final: si algo de lo que garantiza ADR-017 §4 no se cumple, esto
-- aborta en vez de dejar el ambiente a medias.
do $verify$
declare
  offender text;
begin
  -- Ningún rol de la aplicación puede asumir app_rls_helper, y él no pertenece
  -- a nada: sin membresías en ningún sentido.
  select string_agg(format('%s -> %s', member.rolname, grp.rolname), ', ')
    into offender
    from pg_auth_members m
    join pg_roles member on member.oid = m.member
    join pg_roles grp on grp.oid = m.roleid
   where member.rolname = 'app_rls_helper' or grp.rolname = 'app_rls_helper';
  if offender is not null then
    raise exception 'app_rls_helper tiene membresías (%): ADR-017 exige que ningún rol pueda asumirlo.', offender;
  end if;

  -- Ningún otro rol no superusuario puede tener BYPASSRLS.
  select string_agg(rolname, ', ')
    into offender
    from pg_roles
   where rolbypassrls and not rolsuper and rolname <> 'app_rls_helper';
  if offender is not null then
    raise exception 'Roles no superusuario con BYPASSRLS distintos de app_rls_helper: %', offender;
  end if;
end
$verify$;
