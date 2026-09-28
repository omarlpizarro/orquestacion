# 013. `project.site_id` obligatorio, sitio por defecto al crear la organización

- **Estado:** aceptada
- **Fecha:** 2026-09-28

## Contexto

`docs/data-model.md` (decisión abierta #5) y `CLAUDE.md` §13 dejaban
`project.site_id` nulable, sin cerrar. Fase 2 solo había resuelto un
fallback de zona horaria para ese caso (`organization_profile.timezone`
cuando `site_id` es null, ver ADR-008), no la pregunta de fondo.

Esa pregunta se vuelve bloqueante recién ahora: el diseño de alcance por
sitio (RBAC de `manager`/`operator` vía `member_site_access`, todavía sin
implementar) necesita responder qué puede hacer un manager sobre un
proyecto sin sitio. Si `site_id` sigue nulable, cada capacidad con alcance
(`task:create`, la regla de `operator` en `resolveTaskStatusTransition`,
las que vengan después) tiene que decidir por separado qué significa "sin
sitio" — ¿lo ve todo el mundo?, ¿nadie?, ¿solo `owner`/`director`? — y
repetir esa decisión en cada call site es exactamente el antipatrón que
"Mi Día" ya mostró con la clasificación duplicada en `WHERE` y en
TypeScript: dos lugares que pueden divergir en vez de una sola regla.

## Decisión

1. `project.site_id` pasa a `NOT NULL`. No hay migración de datos que
   resolver: el CRUD de proyectos todavía no existe (es el siguiente
   trabajo después del alcance por sitio en el orden de la fase), así que
   no hay ninguna fila de `project` en ningún ambiente todavía.

2. Al crear una organización se crea automáticamente un `site` por
   defecto, para que nunca exista una organización sin al menos un sitio al
   que apuntar. Mecanismo: `organizationHooks.afterCreateOrganization` del
   plugin `organization` de `better-auth@1.7.5` — verificado en el paquete
   instalado
   (`node_modules/.pnpm/better-auth@1.7.5.../node_modules/better-auth/dist/plugins/organization/types.d.mts:338`),
   corre después de que Better Auth confirma la fila en
   `auth.organization` y recibe `{ organization, member, user }`. El hook
   inserta en `site`:
   - `id`: generado con `newId()` (`packages/contracts/src/shared/id.ts`),
     el mismo generador UUIDv7 que usa el resto de la app — nunca
     `gen_random_uuid()` del lado servidor (regla dura 6). El hook corre en
     proceso de la API, no en SQL; "cliente" acá es ese código, no
     Postgres.
   - `organization_id`: `data.organization.id`.
   - `name`: `'Sede principal'`, editable después — no hay todavía ningún
     endpoint de `site` para editarlo, queda anotado como parte del alcance
     de una fase posterior si hace falta antes.
   - `timezone`: `'America/Argentina/Buenos_Aires'`, mismo default que
     `organization_profile.timezone` (`packages/db/migrations/0003_tenancy.sql`),
     aunque las dos filas no están relacionadas por FK.
   - `is_active`: `true`.

3. **Explícitamente fuera de esta decisión:** `organization_profile` sigue
   sin crearse automáticamente. Es una decisión previa y deliberada, no un
   descubrimiento de esta sesión — está documentada en el comentario de
   `apps/api/test/create-task.integration.spec.ts` ("el slice de onboarding
   que la crea es de una fase posterior", CLAUDE.md §14, fase 7). `site` no
   tiene FK a `organization_profile` (ambas referencian `auth.organization`
   directamente, son tablas hermanas, no hay dependencia entre ellas), así
   que este hook no necesita que `organization_profile` exista para
   insertar el `site` por defecto.

4. **La migración a `NOT NULL` se hace en dos despliegues** (convención
   NOT VALID + VALIDATE de CLAUDE.md §6, primer caso real de esa
   convención): `packages/db/migrations/0009_project_site_id_check_not_valid.sql`
   agrega `CHECK (site_id IS NOT NULL) NOT VALID` (instantáneo, no mira
   filas existentes); una segunda migración, en un despliegue posterior y
   después de correr el backfill (`apps/api/src/scripts/ensure-default-sites.ts`)
   contra el ambiente real, valida ese CHECK y recién ahí hace
   `ALTER COLUMN site_id SET NOT NULL` de verdad. Esto deja una
   **divergencia intencional, documentada en el propio `0009`**: el
   esquema de Drizzle (`packages/db/src/schema/projects/schema.ts`) y el
   snapshot de esa migración ya declaran `site_id` como `NOT NULL` desde
   el primer despliegue, aunque la base recién lo sea de verdad después
   del segundo. Va en la dirección segura — el snapshot "adelantado" nunca
   hace que `drizzle-kit` genere un `ALTER` peligroso sin querer, en el
   peor caso hace que alguien asuma sin filas nulas una columna que
   todavía puede tenerlas — y es la misma anticipación que la convención
   ya usa para ampliar un `CHECK` existente, aplicada acá por primera vez
   a una columna que pasa a `NOT NULL`. Consecuencia práctica: la segunda
   migración no se puede generar con `drizzle-kit generate` normal (no va
   a detectar ninguna diferencia, esquema y snapshot ya coinciden), hace
   falta `generate --custom` para el archivo vacío que se llena a mano.

## Consecuencias

**A favor**

- El diseño de alcance por sitio no necesita un caso especial para
  "proyecto sin sitio": todo proyecto de acá en adelante tiene un
  `site_id` real, incluso si es el sitio por defecto de una organización de
  un solo local.
- Una organización recién creada queda en un estado consistente de
  entrada — puede crear un proyecto sin que el primer paso sea "primero
  andá a crear un sitio".

**En contra, asumido**

- El fallback de zona horaria de ADR-008
  (`organization_profile.timezone` cuando `site_id` es null) queda sin uso
  para proyectos creados de acá en adelante — no se borra, porque sigue
  siendo la ruta correcta si algún camino futuro llegara a insertar
  `site_id` null de todos modos (la columna es `NOT NULL`, así que eso ya
  no debería ser posible salvo un bug; el fallback pasa de "caso de negocio
  esperado" a "defensa ante ese bug").
- El nombre `'Sede principal'` es un placeholder sin UI para cambiarlo
  todavía — una organización real con nombre distinto para su único local
  lo ve así hasta que exista un endpoint de edición de `site`.
- Una organización que en verdad tiene múltiples sitios desde el día uno
  (alta por script, no por el flujo normal de Better Auth) igual arranca
  con un sitio de más, que hay que borrar o renombrar a mano — no hay forma
  de que el hook sepa de antemano que hacen falta varios.
- Mientras el segundo despliegue (punto 4) no esté aplicado, el tipo de
  `siteId` en TypeScript es `string` (no `string | null`) pero una fila de
  `project` creada antes del primer despliegue, en un ambiente que todavía
  no corrió el backfill, puede tener `site_id` null en la base de verdad.
  Ningún código de este PR lee `project.site_id` con ese supuesto (el hook
  y el script solo escriben), pero cualquier código nuevo que sí lo lea
  antes de que el segundo despliegue esté aplicado tiene que saber que el
  tipo miente en esa ventana.

## Alternativas descartadas

- **Mantener `site_id` nullable y modelar "sin sitio = ve todos los sitios
  de la organización" como regla explícita en cada capacidad de alcance.**
  Descartado: duplica la misma decisión en cada call site en vez de
  resolverla una sola vez en el modelo, y un `manager` sin alcance
  restringido en ese caso contradice la razón de ser de
  `member_site_access` — el problema que ese alcance existe para resolver
  reaparecería justo para el caso "sin sitio".
- **Crear `organization_profile` en el mismo hook**, ya que
  `afterCreateOrganization` de todos modos corre en ese momento. Descartado
  por ahora: es una decisión distinta (cuándo se completa el perfil de la
  organización — industria, razón social — que hoy requiere datos que el
  alta de Better Auth no captura), ya tomada y diferida a onboarding
  (fase 7). Revertir esa decisión de paso, sin que nadie la haya pedido,
  sería tocar algo que no estaba roto para este cambio.
