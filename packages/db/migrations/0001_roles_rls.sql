-- Roles ya creados por packages/db/sql/bootstrap-roles.sql. Esta migración
-- (corre como app_owner, dueño del esquema desde el bootstrap) le da a
-- app_user los permisos de tabla y deja lista la función que aplica el
-- aislamiento de tenant a cualquier tabla nueva.

-- GRANT ... ON ALL TABLES solo alcanza a las tablas que existen en este
-- momento (ninguna todavía). Por eso el ALTER DEFAULT PRIVILEGES de abajo no
-- es redundante: es lo único que cubre las tablas que crean las migraciones
-- futuras.
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- Los privilegios por defecto se registran por rol OTORGANTE. Las
-- migraciones corren como app_owner, así que el "FOR ROLE app_owner" es
-- obligatorio: sin él, el default queda registrado bajo el rol que ejecutó
-- este script a mano y no hace nada útil en producción.
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- Función generadora de policies de aislamiento de tenant. Recorre pg_catalog
-- buscando tablas de `public` con una columna `organization_id` y les aplica
-- ENABLE + FORCE ROW LEVEL SECURITY más la policy estándar, si todavía no la
-- tienen. Es idempotente a propósito: toda migración que crea una tabla de
-- negocio nueva termina con `select app_apply_tenant_policies();`, y así
-- queda cubierta sin tener que escribir la policy a mano en cada una.
CREATE OR REPLACE FUNCTION app_apply_tenant_policies() RETURNS void AS $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT DISTINCT c.relname AS table_name
    FROM information_schema.columns col
    JOIN pg_class c
      ON c.relname = col.table_name AND c.relkind = 'r'
    JOIN pg_namespace n
      ON n.oid = c.relnamespace AND n.nspname = col.table_schema
    WHERE col.table_schema = 'public'
      AND col.column_name = 'organization_id'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', rec.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', rec.table_name);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = rec.table_name
        AND policyname = rec.table_name || '_tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I USING (organization_id = current_setting(''app.current_org'', true)::uuid) WITH CHECK (organization_id = current_setting(''app.current_org'', true)::uuid)',
        rec.table_name || '_tenant_isolation',
        rec.table_name
      );
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- No-op hoy (no hay tablas de negocio todavía). Se re-ejecuta al final de
-- toda migración futura que cree una.
SELECT app_apply_tenant_policies();
