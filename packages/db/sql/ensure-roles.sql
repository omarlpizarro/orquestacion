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

-- ---------------------------------------------------------------------------
-- Puente de dueño de las funciones auxiliares de RLS (ADR-017 §4).
-- ---------------------------------------------------------------------------
-- Las funciones auxiliares tienen que ser de app_rls_helper (el único rol con
-- BYPASSRLS), pero las migraciones las crea app_owner, y un rol que no es
-- superusuario no puede cederle una función a otro sin poder asumirlo
-- (verificado: "must be able to SET ROLE"), ni sin que el destino tenga CREATE
-- en el esquema. Dar esa membresía a app_owner (WITH ADMIN OPTION) le permitiría
-- además otorgar el rol auxiliar a cualquiera, incluido el de la API: una línea
-- equivocada en una migración le daría a la API un BYPASSRLS. Por eso el
-- traspaso lo hace esta función, que es del superusuario que corre este script.
--
-- Es un control humano deliberado, no una limitación: la lista de abajo está
-- escrita acá y no en una tabla ni en un argumento. Sumar una función auxiliar
-- (o cambiar su firma) exige modificar este archivo y que una persona con
-- acceso de superusuario lo vuelva a correr. Ninguna migración puede ampliarla.
--
-- Antes de traspasar valida las condiciones de ADR-017 §4, no solo el nombre:
-- firma exacta de la lista, esquema public, SECURITY DEFINER, STABLE,
-- search_path exactamente pg_catalog, public, pg_temp, lenguaje sql o plpgsql, retorno boolean o setof uuid y
-- sin EXECUTE para PUBLIC. Si algo no cumple, rechaza.
--
-- Corregir el cuerpo de una función ya traspasada: app_owner dejó de ser su
-- dueño y no puede reemplazarla. La migración que la corrige la devuelve con
-- (función, false), hace CREATE OR REPLACE, vuelve a fijar los permisos y la
-- traspasa otra vez con (función, true), todo en la misma transacción. Devolver
-- exige solo que la función esté en la lista y sea hoy del rol auxiliar.
create or replace function public.app_transfer_rls_helper_function(
  p_function regprocedure,
  p_to_helper boolean
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $bridge$
declare
  allowed constant text[] := array[
    'public.app_is_privileged()',
    'public.app_full_access_project_ids()',
    'public.app_assigned_project_ids()',
    'public.app_assigned_task_ids()',
    'public.app_has_full_project_access(uuid)',
    'public.app_has_assigned_project_access(uuid)'
  ];
  -- Con public en el search_path, regprocedure::text imprime sin esquema: la
  -- firma se arma del catálogo, siempre calificada.
  signature text;
  qualified text;
  f pg_proc%rowtype;
  language_name text;
begin
  if p_function is null or p_to_helper is null then
    raise exception 'app_transfer_rls_helper_function: los dos argumentos son obligatorios.';
  end if;

  select n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')',
         format('%I.%I(%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes))
    into signature, qualified
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where p.oid = p_function::oid;

  if not (signature = any (allowed)) then
    raise exception 'La función % no está en la lista fija del puente (%). Sumar una función auxiliar exige modificar ensure-roles.sql y volver a correrlo.',
      signature, array_to_string(allowed, ', ');
  end if;

  select * into f from pg_proc where oid = p_function::oid;

  if not p_to_helper then
    if f.proowner <> 'app_rls_helper'::regrole then
      raise exception 'La función % no es de app_rls_helper (es de %): no hay nada que devolver.',
        signature, f.proowner::regrole;
    end if;
    execute format('alter function %s owner to app_owner', qualified);
    return;
  end if;

  if f.proowner <> 'app_owner'::regrole then
    raise exception 'La función % debe ser de app_owner para traspasarla (es de %).',
      signature, f.proowner::regrole;
  end if;
  if f.prokind <> 'f' then
    raise exception 'La función % debe ser una función común.', signature;
  end if;
  if not f.prosecdef then
    raise exception 'La función % debe ser SECURITY DEFINER.', signature;
  end if;
  if f.provolatile <> 's' then
    raise exception 'La función % debe ser STABLE.', signature;
  end if;
  -- Exactamente este y nada más. pg_catalog primero y pg_temp al final y
  -- explícito: sin pg_temp en el search_path, Postgres busca primero en el
  -- esquema temporal para las relaciones, y una tabla temporal de la sesión que
  -- llama podría interponerse (manual de Postgres, "Writing SECURITY DEFINER
  -- Functions Safely").
  if f.proconfig is distinct from array['search_path=pg_catalog, public, pg_temp'] then
    raise exception 'La función % debe fijar exactamente SET search_path = pg_catalog, public, pg_temp (tiene %).',
      signature, coalesce(f.proconfig::text, 'nada');
  end if;
  select l.lanname into language_name from pg_language l where l.oid = f.prolang;
  if language_name not in ('sql', 'plpgsql') then
    raise exception 'La función % debe estar escrita en sql o plpgsql (es %).', signature, language_name;
  end if;
  if not (f.prorettype = 'boolean'::regtype or (f.prorettype = 'uuid'::regtype and f.proretset)) then
    raise exception 'La función % debe devolver boolean o setof uuid (devuelve %).',
      signature, case when f.proretset then 'setof ' else '' end || f.prorettype::regtype;
  end if;
  if f.proacl is null or exists (
    select 1 from aclexplode(f.proacl) a where a.grantee = 0
  ) then
    raise exception 'La función % no debe tener EXECUTE para PUBLIC (REVOKE ALL ... FROM PUBLIC antes de traspasarla).',
      signature;
  end if;

  execute format('alter function %s owner to app_rls_helper', qualified);
end
$bridge$;

revoke all on function public.app_transfer_rls_helper_function(regprocedure, boolean) from public;
grant execute on function public.app_transfer_rls_helper_function(regprocedure, boolean) to app_owner;

-- ---------------------------------------------------------------------------
-- Sin tablas temporales para los roles de la aplicación (defensa adicional).
-- ---------------------------------------------------------------------------
-- Por defecto PUBLIC puede crear tablas temporales en toda base. Ningún rol de
-- la aplicación las necesita (ni la API, ni los workers, ni pg-boss, ni las
-- migraciones), y una tabla temporal es el vector de ataque a una función
-- SECURITY DEFINER con un search_path sin pg_temp explícito. Las funciones de
-- RLS ya no son vulnerables (search_path = pg_catalog, public, pg_temp y todo
-- calificado); esto cierra el vector para cualquier función futura que alguien
-- escriba mal. Si algún día hace falta, se otorga a un rol puntual: no a PUBLIC.
select format('revoke temporary on database %I from public', current_database())
\gexec

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

  -- El puente concede un traspaso de dueño que ningún rol de la aplicación puede
  -- hacer por su cuenta: si su dueño no es un superusuario, no es el control que
  -- el ADR describe (o este script lo corrió quien no debía).
  select r.rolname into offender
    from pg_proc p
    join pg_roles r on r.oid = p.proowner
   where p.oid = 'public.app_transfer_rls_helper_function(regprocedure, boolean)'::regprocedure
     and not r.rolsuper;
  if offender is not null then
    raise exception 'El puente app_transfer_rls_helper_function es de % y no de un superusuario: volvé a correr este script como superusuario.', offender;
  end if;

  -- Ningún rol de la aplicación puede crear tablas temporales.
  select string_agg(r.rolname, ', ')
    into offender
    from pg_roles r
   where r.rolname in ('app_owner', 'app_user', 'app_login', 'app_worker', 'app_rls_helper')
     and has_database_privilege(r.rolname, current_database(), 'TEMPORARY');
  if offender is not null then
    raise exception 'Estos roles todavía pueden crear tablas temporales: %. Revisá los GRANT TEMPORARY de la base.', offender;
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
