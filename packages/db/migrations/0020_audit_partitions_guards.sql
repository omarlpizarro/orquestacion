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
-- Mismo cuerpo que la 0015, con las guardas al principio. `CREATE OR REPLACE`
-- conserva el dueño, el `REVOKE` a PUBLIC y el `SECURITY DEFINER`; se repiten
-- `SET search_path = pg_catalog, public, pg_temp` y los nombres calificados
-- (CLAUDE.md §6). Compatible hacia atrás: la 0012 la llama con (hoy, 13), dentro
-- del rango. Una llamada fuera del rango (algún código viejo con otra fecha) pasa a
-- fallar: es el cambio buscado.
CREATE OR REPLACE FUNCTION public.app_ensure_audit_partitions(p_from date, p_months integer) RETURNS void AS $fn$
DECLARE
  today_utc constant date := (now() AT TIME ZONE 'UTC')::date;
  month_start date;
  part_name text;
  i integer;
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

GRANT EXECUTE ON FUNCTION public.app_ensure_audit_partitions(date, integer) TO app_worker;
