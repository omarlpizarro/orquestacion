-- Job de particiones del audit (ADR-018). Dos cambios sobre `app_ensure_audit_partitions`:
--
-- 1. Guardas de parámetros. Hasta ahora solo la llamaba `app_owner` (migraciones);
--    desde acá también la llama `app_worker`, que corre con los permisos del dueño
--    porque la función es SECURITY DEFINER. Un parámetro desbocado (`p_months`
--    enorme, o una fecha de 2099) crearía miles de tablas, así que se valida
--    adentro: `p_months` entre 1 y 24, y `p_from` dentro de un mes de hoy (UTC, como
--    el resto del audit). Si no, error `22023` y no se crea nada: las guardas corren
--    antes del primer `CREATE`.
--
-- 2. `GRANT EXECUTE` a `app_worker`. Hoy está revocado a PUBLIC y no se otorgó a nadie
--    (0015). Va en una migración y no en `ensure-roles.sql`: ese script corre antes
--    de las migraciones (en un volumen nuevo y en el harness de tests) y la función
--    todavía no existe. `ensure-roles.sql` y la lista fija del puente no cambian: la
--    función es de `app_owner` y no necesita BYPASSRLS.
--
-- 3. Sin locks fuertes cuando no hay nada que crear. Hasta ahora esta función corría solo
--    en migraciones, y cada llamada hacía `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY`
--    sobre TODAS las tablas de negocio (vía `app_apply_tenant_policies()`), aunque ya
--    estuvieran así, más un `REVOKE` por partición. Verificado con `pg_locks`: cada llamada
--    tomaba `AccessExclusiveLock` sobre `task`, `project`, `task_update`, `mutation_log`...
--    Con el job corriendo todos los días, una transacción larga abierta sobre cualquiera de
--    ellas lo dejaba encolado y bloqueaba todo lo que llegara detrás. Ahora:
--      - `app_apply_tenant_policies()` solo hace el `ALTER` si `relrowsecurity` o
--        `relforcerowsecurity` están en falso;
--      - esta función crea, revoca y aplica policies únicamente si CREÓ alguna partición.
--    Un día sin particiones nuevas no toma ningún lock fuerte (lo prueba un test con
--    `pg_locks`). El job suma además un `lock_timeout` corto.
--
-- Mismo cuerpo que la 0015, con las guardas al principio. `CREATE OR REPLACE`
-- conserva el dueño, el `REVOKE` a PUBLIC y el `SECURITY DEFINER`; se repiten
-- `SET search_path = pg_catalog, public, pg_temp` y los nombres calificados
-- (CLAUDE.md §6). Compatible hacia atrás: la 0012 la llama con (hoy, 13), dentro
-- del rango. Una llamada fuera del rango (algún código viejo con otra fecha) pasa a
-- fallar: es el cambio buscado.
-- `app_apply_tenant_policies()` (0012): el mismo recorrido, pero el `ALTER TABLE` solo corre si
-- hace falta. `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` toma ACCESS EXCLUSIVE aunque no
-- cambie nada. Sin cambios para las migraciones: una tabla nueva (RLS apagada) recibe los dos.
-- Califica `public` en cada nombre (corre también como parte de una función SECURITY DEFINER).
CREATE OR REPLACE FUNCTION public.app_apply_tenant_policies() RETURNS void AS $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT DISTINCT c.relname AS table_name,
           c.relrowsecurity AS has_rls,
           c.relforcerowsecurity AS has_forced_rls
    FROM information_schema.columns col
    JOIN pg_class c
      ON c.relname = col.table_name AND c.relkind IN ('r', 'p')
    JOIN pg_namespace n
      ON n.oid = c.relnamespace AND n.nspname = col.table_schema
    WHERE col.table_schema = 'public'
      AND col.column_name = 'organization_id'
  LOOP
    IF NOT rec.has_rls THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', rec.table_name);
    END IF;
    IF NOT rec.has_forced_rls THEN
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', rec.table_name);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = rec.table_name
        AND policyname = rec.table_name || '_tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I USING (organization_id = nullif(current_setting(''app.current_org'', true), '''')) WITH CHECK (organization_id = nullif(current_setting(''app.current_org'', true), ''''))',
        rec.table_name || '_tenant_isolation',
        rec.table_name
      );
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_ensure_audit_partitions(p_from date, p_months integer) RETURNS void AS $fn$
DECLARE
  today_utc constant date := (now() AT TIME ZONE 'UTC')::date;
  month_start date;
  part_name text;
  i integer;
  created_any boolean := false;
BEGIN
  IF p_from IS NULL OR p_months IS NULL THEN
    RAISE EXCEPTION 'app_ensure_audit_partitions: p_from y p_months son obligatorios.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_months < 1 OR p_months > 24 THEN
    RAISE EXCEPTION 'app_ensure_audit_partitions: p_months tiene que estar entre 1 y 24 (llegó %).', p_months
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_from < (today_utc - interval '1 month')::date OR p_from > (today_utc + interval '1 month')::date THEN
    RAISE EXCEPTION 'app_ensure_audit_partitions: p_from tiene que estar a un mes o menos de hoy, % (llegó %).', today_utc, p_from
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- `to_regclass` y no `IF NOT EXISTS`: mirar el catálogo no toma ningún lock sobre la tabla.
  IF to_regclass('public.audit_log_default') IS NULL THEN
    CREATE TABLE public.audit_log_default PARTITION OF public.audit_log DEFAULT;
    REVOKE UPDATE, DELETE ON public.audit_log_default FROM app_user;
    created_any := true;
  END IF;

  FOR i IN 0 .. p_months - 1 LOOP
    month_start := (date_trunc('month', p_from) + make_interval(months => i))::date;
    part_name := 'audit_log_' || to_char(month_start, 'YYYY_MM');
    IF to_regclass(format('public.%I', part_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.audit_log FOR VALUES FROM (%L) TO (%L)',
        part_name,
        (month_start::timestamp AT TIME ZONE 'UTC')::text,
        ((month_start + interval '1 month')::timestamp AT TIME ZONE 'UTC')::text
      );
      EXECUTE format('REVOKE UPDATE, DELETE ON public.%I FROM app_user', part_name);
      created_any := true;
    END IF;
  END LOOP;

  -- RLS y policies solo si nació alguna partición: son las únicas que las necesitan.
  IF created_any THEN
    PERFORM public.app_apply_tenant_policies();
    PERFORM public.app_apply_audit_project_policies();
  END IF;
END;
$fn$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.app_ensure_audit_partitions(date, integer) TO app_worker;
