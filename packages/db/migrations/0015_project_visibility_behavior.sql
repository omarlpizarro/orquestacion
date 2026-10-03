-- ADR-017 (docs/adr/017-visibilidad-de-proyectos.md), PR 3 de 3: el
-- COMPORTAMIENTO del modelo de proyectos reservados. 0012 dejó la estructura;
-- acá se agregan las seis funciones auxiliares de RLS, las policies por
-- proyecto y el traspaso de las funciones al rol auxiliar.
--
-- Todo lo de abajo es nuevo (funciones, policies): el código anterior a esta
-- migración sigue andando salvo por lo que el modelo cambia a propósito: un
-- miembro que no ve un proyecto deja de ver sus tareas.
--
-- Requiere que se haya corrido packages/db/sql/ensure-roles.sql (crea
-- app_rls_helper, app_worker y el puente de dueño de las funciones).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls_helper')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    RAISE EXCEPTION 'Faltan los roles app_rls_helper y/o app_worker: corré packages/db/sql/ensure-roles.sql como superusuario antes de migrar (ver README, "Roles de Postgres en un ambiente que ya existe").';
  END IF;
  IF to_regprocedure('public.app_transfer_rls_helper_function(regprocedure, boolean)') IS NULL THEN
    RAISE EXCEPTION 'Falta el puente app_transfer_rls_helper_function: corré packages/db/sql/ensure-roles.sql como superusuario antes de migrar (ver README, "Roles de Postgres en un ambiente que ya existe").';
  END IF;
END
$guard$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. Permisos del rol auxiliar: SOLO SELECT, y solo sobre lo que leen las
--    funciones (ADR-017 §4.3). Sin CREATE en ningún esquema.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO app_rls_helper;
--> statement-breakpoint
GRANT USAGE ON SCHEMA auth TO app_rls_helper;
--> statement-breakpoint
GRANT SELECT ON project, project_member, task, member_site_access TO app_rls_helper;
--> statement-breakpoint
GRANT SELECT ON auth.member TO app_rls_helper;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Las seis funciones auxiliares (ADR-017 §3), exactamente estas y nada más.
-- ---------------------------------------------------------------------------
-- Cada una filtra siempre por `app.current_org`: llamada con la organización de
-- otro tenant no devuelve nada de la primera. Solo devuelven boolean o listas
-- de ids, nunca columnas de datos. Se crean como app_owner y se traspasan al
-- rol auxiliar al final (puente de ensure-roles.sql), que valida las
-- condiciones del ADR antes de ceder cada una.
--
-- Un miembro con varios roles ("owner,manager") NO es privilegiado acá: se
-- compara el valor completo. Es el lado seguro (menos acceso) y coincide con
-- que el código también se niega a elegir uno por su cuenta (parseSingleOrgRole).
--
-- search_path = pg_catalog, public, pg_temp, y TODA tabla y función calificada
-- con su esquema. Es lo que el manual de Postgres exige de una función
-- SECURITY DEFINER: para las relaciones, Postgres busca primero en el esquema
-- temporal salvo que pg_temp figure explícito en el search_path, y estas
-- funciones corren con BYPASSRLS en la sesión de quien las llama. Sin esto, una
-- sesión de la API podría crear una tabla temporal project_member (o task,
-- project, member_site_access) con filas falsas y la función la leería en vez de
-- la real. Con el esquema explícito, la tabla temporal no se puede interponer
-- (verificado por project-isolation-temp-tables.integration.spec.ts).

-- Privilegiado: owner/director de la organización, o el contexto de sistema.
-- El sistema se concede por la IDENTIDAD de la conexión (session_user), no por
-- el GUC: dentro de una función SECURITY DEFINER current_user es el dueño de la
-- función, y session_user es el usuario con que se abrió la conexión, que solo
-- un superusuario puede cambiar. Así la API (app_login) no puede declararse
-- "sistema" aunque fije app.scope.
CREATE FUNCTION app_is_privileged() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT
    (nullif(current_setting('app.scope', true), '') = 'system' AND session_user = 'app_worker')
    OR EXISTS (
      SELECT 1 FROM auth.member m
       WHERE m.id = nullif(current_setting('app.current_member', true), '')
         AND m.organization_id = nullif(current_setting('app.current_org', true), '')
         AND m.role IN ('owner', 'director')
    )
$fn$;
--> statement-breakpoint

-- Acceso completo: privilegiado, miembro explícito, o proyecto 'site' de un
-- sitio al que el miembro tiene acceso (misma definición que
-- TenancyService.canAccessSite para manager/operator).
CREATE FUNCTION app_full_access_project_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT p.id
    FROM public.project p
   WHERE p.organization_id = nullif(current_setting('app.current_org', true), '')
     AND (
       (SELECT public.app_is_privileged())
       OR EXISTS (
         SELECT 1 FROM public.project_member pm
          WHERE pm.organization_id = p.organization_id
            AND pm.project_id = p.id
            AND pm.member_id = nullif(current_setting('app.current_member', true), '')
            AND pm.deleted_at IS NULL
       )
       OR (
         p.visibility = 'site'
         AND EXISTS (
           SELECT 1 FROM public.member_site_access a
            WHERE a.organization_id = p.organization_id
              AND a.member_id = nullif(current_setting('app.current_member', true), '')
              AND a.site_id = p.site_id
         )
       )
     )
$fn$;
--> statement-breakpoint

-- "Solo asignado": al menos una tarea asignada, no borrada, en cualquier estado
-- (done y cancelled cuentan).
CREATE FUNCTION app_assigned_project_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT DISTINCT t.project_id
    FROM public.task t
   WHERE t.organization_id = nullif(current_setting('app.current_org', true), '')
     AND t.assignee_member_id = nullif(current_setting('app.current_member', true), '')
     AND t.deleted_at IS NULL
$fn$;
--> statement-breakpoint

CREATE FUNCTION app_assigned_task_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT t.id
    FROM public.task t
   WHERE t.organization_id = nullif(current_setting('app.current_org', true), '')
     AND t.assignee_member_id = nullif(current_setting('app.current_member', true), '')
     AND t.deleted_at IS NULL
$fn$;
--> statement-breakpoint

-- Para la aplicación (ProjectAccessService): hay UNA sola implementación del
-- cálculo, la de la base, y el código no la reescribe en TypeScript.
CREATE FUNCTION app_has_full_project_access(p_project_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.app_full_access_project_ids() f(id) WHERE f.id = p_project_id)
$fn$;
--> statement-breakpoint

CREATE FUNCTION app_has_assigned_project_access(p_project_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.app_assigned_project_ids() f(id) WHERE f.id = p_project_id)
$fn$;
--> statement-breakpoint

-- EXECUTE solo para app_user (que heredan app_login y app_worker). El puente
-- exige que PUBLIC no tenga EXECUTE antes de traspasar; el dueño original
-- (app_owner) queda sin él a propósito: una función SECURITY DEFINER del rol
-- auxiliar no es algo que el rol de las migraciones tenga que poder llamar.
REVOKE ALL ON FUNCTION app_is_privileged() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_full_access_project_ids() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_assigned_project_ids() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_assigned_task_ids() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_has_full_project_access(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_has_assigned_project_access(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_is_privileged() TO app_user;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_full_access_project_ids() TO app_user;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_assigned_project_ids() TO app_user;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_assigned_task_ids() TO app_user;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_has_full_project_access(uuid) TO app_user;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_has_assigned_project_access(uuid) TO app_user;
--> statement-breakpoint

-- Traspaso al rol auxiliar, por el puente (valida las condiciones del ADR).
SELECT app_transfer_rls_helper_function('app_is_privileged()'::regprocedure, true);
--> statement-breakpoint
SELECT app_transfer_rls_helper_function('app_full_access_project_ids()'::regprocedure, true);
--> statement-breakpoint
SELECT app_transfer_rls_helper_function('app_assigned_project_ids()'::regprocedure, true);
--> statement-breakpoint
SELECT app_transfer_rls_helper_function('app_assigned_task_ids()'::regprocedure, true);
--> statement-breakpoint
SELECT app_transfer_rls_helper_function('app_has_full_project_access(uuid)'::regprocedure, true);
--> statement-breakpoint
SELECT app_transfer_rls_helper_function('app_has_assigned_project_access(uuid)'::regprocedure, true);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Policies por proyecto (ADR-017 §3), una por comando.
-- ---------------------------------------------------------------------------
-- RESTRICTIVE: se suman (AND) a la `<tabla>_tenant_isolation` permisiva que ya
-- existe y que no se toca. Así el aislamiento de tenant sigue siendo lo
-- primero y el escáner de RLS no cambia. Los `(SELECT ...)` hacen que Postgres
-- calcule cada función una vez por sentencia (InitPlan / hashed SubPlan), no
-- por fila.

-- task: ver/modificar con acceso completo o si la tarea es del miembro. INSERT
-- SIN la rama "asignada": con una sola policy, quien ve un proyecto solo por
-- asignación podría insertar tareas en él.
CREATE POLICY "task_project_access_select" ON "task" AS RESTRICTIVE FOR SELECT
  USING ((SELECT app_is_privileged())
         OR project_id IN (SELECT app_full_access_project_ids())
         OR id IN (SELECT app_assigned_task_ids()));
--> statement-breakpoint
CREATE POLICY "task_project_access_update" ON "task" AS RESTRICTIVE FOR UPDATE
  USING ((SELECT app_is_privileged())
         OR project_id IN (SELECT app_full_access_project_ids())
         OR id IN (SELECT app_assigned_task_ids()))
  WITH CHECK ((SELECT app_is_privileged())
         OR project_id IN (SELECT app_full_access_project_ids())
         OR id IN (SELECT app_assigned_task_ids()));
--> statement-breakpoint
CREATE POLICY "task_project_access_delete" ON "task" AS RESTRICTIVE FOR DELETE
  USING ((SELECT app_is_privileged())
         OR project_id IN (SELECT app_full_access_project_ids())
         OR id IN (SELECT app_assigned_task_ids()));
--> statement-breakpoint
CREATE POLICY "task_project_access_insert" ON "task" AS RESTRICTIVE FOR INSERT
  WITH CHECK ((SELECT app_is_privileged())
              OR project_id IN (SELECT app_full_access_project_ids()));
--> statement-breakpoint

-- project: el asignado lo ve (con un DTO reducido, que decide la aplicación).
-- INSERT queda sin policy restrictiva: quién crea un proyecto lo decide la
-- capacidad en código, y el creador entra como miembro en la misma transacción
-- (ver el PR del CRUD de proyectos; el INSERT ... RETURNING de un proyecto
-- reservado todavía sin miembros no pasa la policy de SELECT).
CREATE POLICY "project_project_access_select" ON "project" AS RESTRICTIVE FOR SELECT
  USING ((SELECT app_is_privileged())
         OR id IN (SELECT app_full_access_project_ids())
         OR id IN (SELECT app_assigned_project_ids()));
--> statement-breakpoint
CREATE POLICY "project_project_access_update" ON "project" AS RESTRICTIVE FOR UPDATE
  USING ((SELECT app_is_privileged())
         OR id IN (SELECT app_full_access_project_ids())
         OR id IN (SELECT app_assigned_project_ids()))
  WITH CHECK ((SELECT app_is_privileged())
         OR id IN (SELECT app_full_access_project_ids())
         OR id IN (SELECT app_assigned_project_ids()));
--> statement-breakpoint
CREATE POLICY "project_project_access_delete" ON "project" AS RESTRICTIVE FOR DELETE
  USING ((SELECT app_is_privileged())
         OR id IN (SELECT app_full_access_project_ids())
         OR id IN (SELECT app_assigned_project_ids()));
--> statement-breakpoint

-- project_member: el asignado no ve quién más participa.
CREATE POLICY "project_member_project_access_select" ON "project_member" AS RESTRICTIVE FOR SELECT
  USING ((SELECT app_is_privileged()) OR project_id IN (SELECT app_full_access_project_ids()));
--> statement-breakpoint
CREATE POLICY "project_member_project_access_insert" ON "project_member" AS RESTRICTIVE FOR INSERT
  WITH CHECK ((SELECT app_is_privileged()) OR project_id IN (SELECT app_full_access_project_ids()));
--> statement-breakpoint
CREATE POLICY "project_member_project_access_update" ON "project_member" AS RESTRICTIVE FOR UPDATE
  USING ((SELECT app_is_privileged()) OR project_id IN (SELECT app_full_access_project_ids()))
  WITH CHECK ((SELECT app_is_privileged()) OR project_id IN (SELECT app_full_access_project_ids()));
--> statement-breakpoint
CREATE POLICY "project_member_project_access_delete" ON "project_member" AS RESTRICTIVE FOR DELETE
  USING ((SELECT app_is_privileged()) OR project_id IN (SELECT app_full_access_project_ids()));
--> statement-breakpoint

-- audit_log: SELECT para privilegiados y para quien tiene acceso completo al
-- proyecto de la entrada; las entradas sin project_id solo las ven los
-- privilegiados. INSERT queda solo por organización (lo hace el trigger).
-- Padre y particiones: quien lee una partición por su nombre no pasa por las
-- policies del padre, y `app_apply_project_policies` (abajo) no alcanza porque
-- audit_log no tiene task_id: se recorre el catálogo con una función propia.
-- Idempotente. `app_ensure_audit_partitions` (0012) crea las particiones futuras
-- con RLS y el REVOKE, y ahora también tienen que recibir esta policy: se
-- vuelve a definir (abajo) llamando a esta función al final.
CREATE FUNCTION app_apply_audit_project_policies() RETURNS void AS $fn$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind IN ('r', 'p')
       AND (c.relname = 'audit_log' OR c.relname LIKE 'audit\_log\_%')
       AND (c.relkind = 'p' OR c.relispartition)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = rec.table_name
         AND policyname = rec.table_name || '_project_access_select'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I AS RESTRICTIVE FOR SELECT USING ((SELECT app_is_privileged()) OR project_id IN (SELECT app_full_access_project_ids()))',
        rec.table_name || '_project_access_select',
        rec.table_name
      );
    END IF;
  END LOOP;
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint
SELECT app_apply_audit_project_policies();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_ensure_audit_partitions(p_from date, p_months integer) RETURNS void AS $fn$
DECLARE
  month_start date;
  part_name text;
  i integer;
BEGIN
  CREATE TABLE IF NOT EXISTS public.audit_log_default PARTITION OF public.audit_log DEFAULT;
  REVOKE UPDATE, DELETE ON public.audit_log_default FROM app_user;

  FOR i IN 0 .. p_months - 1 LOOP
    month_start := (date_trunc('month', p_from) + make_interval(months => i))::date;
    part_name := 'audit_log_' || to_char(month_start, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.audit_log FOR VALUES FROM (%L) TO (%L)',
      part_name,
      (month_start::timestamp AT TIME ZONE 'UTC')::text,
      ((month_start + interval '1 month')::timestamp AT TIME ZONE 'UTC')::text
    );
    EXECUTE format('REVOKE UPDATE, DELETE ON public.%I FROM app_user', part_name);
  END LOOP;

  PERFORM public.app_apply_tenant_policies();
  PERFORM public.app_apply_audit_project_policies();
END;
$fn$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Tablas hijas de una tarea: por catálogo, igual que las otras tres
--    funciones `app_apply_*` (CLAUDE.md §6).
-- ---------------------------------------------------------------------------
-- Toda tabla con `project_id` Y `task_id` (hoy `task_update`; mañana
-- `attachment` y `task_acknowledgement`) recibe: SELECT e INSERT con acceso
-- completo al proyecto o tarea asignada. UPDATE y DELETE con lo mismo que
-- SELECT (más estricto que la letra del ADR, que solo nombra SELECT e INSERT):
-- sin ellas, un UPDATE o DELETE sin WHERE a una novedad de un proyecto ajeno
-- solo tendría la policy de organización.
CREATE FUNCTION app_apply_project_policies() RETURNS void AS $fn$
DECLARE
  rec record;
  access_expr constant text :=
    '(SELECT app_is_privileged()) OR project_id IN (SELECT app_full_access_project_ids()) OR task_id IN (SELECT app_assigned_task_ids())';
BEGIN
  FOR rec IN
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind = 'r' AND NOT c.relispartition
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'project_id' AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'task_id' AND NOT a.attisdropped)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = rec.table_name
         AND policyname = rec.table_name || '_project_access_select'
    ) THEN
      EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR SELECT USING (%s)',
        rec.table_name || '_project_access_select', rec.table_name, access_expr);
      EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR INSERT WITH CHECK (%s)',
        rec.table_name || '_project_access_insert', rec.table_name, access_expr);
      EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR UPDATE USING (%s) WITH CHECK (%s)',
        rec.table_name || '_project_access_update', rec.table_name, access_expr, access_expr);
      EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR DELETE USING (%s)',
        rec.table_name || '_project_access_delete', rec.table_name, access_expr);
    END IF;
  END LOOP;
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Cierre de toda migración que crea policies o tablas de negocio.
-- ---------------------------------------------------------------------------
SELECT app_apply_project_policies();
--> statement-breakpoint
SELECT app_apply_tenant_policies();
