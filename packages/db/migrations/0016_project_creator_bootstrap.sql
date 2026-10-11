-- ADR-017, adenda "El creador entra como miembro": app_full_access_project_ids()
-- suma una rama que da acceso completo al creador de un proyecto SOLO durante
-- la transacción que lo creó, para que pueda insertar su fila de project_member
-- (la policy de project_member exige acceso completo a un proyecto que todavía
-- no ve). Después del COMMIT lo único que persiste es esa fila.
--
-- Cambio de cuerpo, no de firma: la función ya es de app_rls_helper, así que
-- se devuelve a app_owner con el puente, se reemplaza, se vuelven a fijar los
-- permisos y se traspasa de nuevo, todo en esta transacción (ADR-017,
-- "Corregir el cuerpo de una función ya traspasada"). No cambia la lista del
-- puente ni toca ensure-roles.sql.
SELECT app_transfer_rls_helper_function('app_full_access_project_ids()'::regprocedure, false);
--> statement-breakpoint

-- La rama nueva depende de que created_at venga del DEFAULT now() de la base y
-- de que version sea 1: ningún código de aplicación manda created_at ni version
-- al insertar un proyecto (tampoco el offline). version = 1 impide que alguien
-- con acceso "solo asignado" (que puede hacer UPDATE de la fila) se reescriba
-- created_by_member_id y created_at: app_bump_version sube version en cada
-- UPDATE. Por lo mismo, un UPDATE del proyecto antes del INSERT del miembro
-- corta el acceso transitorio.
CREATE OR REPLACE FUNCTION app_full_access_project_ids() RETURNS SETOF uuid
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
       -- Creador en la transacción de creación (ver el comentario de arriba).
       OR (
         p.created_by_member_id = nullif(current_setting('app.current_member', true), '')
         AND p.created_at = transaction_timestamp()
         AND p.version = 1
       )
     )
$fn$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app_full_access_project_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_full_access_project_ids() TO app_user;
--> statement-breakpoint
SELECT app_transfer_rls_helper_function('app_full_access_project_ids()'::regprocedure, true);
