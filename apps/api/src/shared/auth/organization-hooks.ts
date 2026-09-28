import { newId } from '@orq/contracts';
import type { Db } from '@orq/db';
import { withTenantTransaction } from '@orq/db';
import { ensureDefaultSite } from './ensure-default-site.js';

/**
 * ADR-013: crea el sitio por defecto de una organización recién creada.
 *
 * `afterCreateOrganization` corre en el código de Better Auth, no en un
 * request de la API: no hay `RequestContext` resuelto (`getRequestContext`
 * lanzaría), así que arma su propia transacción de tenant con
 * `withTenantTransaction` en vez de pasar por `TransactionService`. `site`
 * tiene RLS forzada (CLAUDE.md §2 regla 2) — sin `app.current_org` seteado
 * en la transacción, el INSERT no pasaría el `WITH CHECK` de la policy
 * (`organization_id = nullif(current_setting('app.current_org', true), '')`
 * nunca es `TRUE` si el setting no está, `0001_roles_rls.sql`) y Postgres
 * lo rechaza con un error explícito — `new row violates row-level
 * security policy for table "site"` — no en silencio. Ese rechazo
 * silencioso (0 filas, sin error) es el comportamiento de `UPDATE`/`DELETE`
 * (filtran por `USING`, no hay fila que falle un chequeo) y de `SELECT`,
 * no el de un `INSERT` con `WITH CHECK`. La conclusión no cambia: sin la
 * transacción de tenant, esto no funciona — pero falla ruidoso, no callado.
 * `app.current_member` se completa con `data.member.id`, el miembro que
 * Better Auth acaba de crear como dueño de la organización (`creatorRole`
 * en `build-auth.ts`) — es quien "está haciendo" esto, aunque `site` no
 * tenga columna `created_by_member_id` para guardarlo (`site` todavía no
 * tiene las columnas estándar de CLAUDE.md §6; gap preexistente de fase 1,
 * no se toca acá).
 *
 * **La organización y su member ya están confirmados en la base cuando
 * esto corre** (verificado en el paquete instalado,
 * `node_modules/.pnpm/better-auth@1.7.5.../dist/plugins/organization/routes/crud-org.mjs:74-141`:
 * `adapter.createOrganization` y `adapter.createMember` son dos llamadas
 * `await` separadas, cada una ya resuelta, antes de que el endpoint llegue
 * a invocar `afterCreateOrganization`; no hay ninguna transacción
 * envolvente en ese handler que las una a esto). Si el INSERT de acá
 * falla, la organización YA EXISTE sin sitio — este hook no puede
 * evitarlo, solo puede fallar la respuesta HTTP de `/organization/create`
 * para que quien la llamó se entere. La reparación de ese caso (y el
 * backfill de organizaciones que ya existían antes de este hook) corren
 * por `apps/api/src/scripts/ensure-default-sites.ts`, que hace exactamente
 * lo mismo y es igual de idempotente — seguro de repetir sobre la misma
 * organización.
 */
export async function handleOrganizationCreated(
  db: Db,
  data: { organization: { id: string }; member: { id: string } },
): Promise<void> {
  await withTenantTransaction(
    db,
    { organizationId: data.organization.id, memberId: data.member.id, requestId: newId() },
    (tx) => ensureDefaultSite(tx, { organizationId: data.organization.id }),
  );
}
