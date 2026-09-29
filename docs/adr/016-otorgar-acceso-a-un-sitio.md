# 016. Otorgar acceso a un sitio: explícito, y automático cuando hay uno solo

- **Estado:** aceptada
- **Fecha:** 2026-09-29

## Contexto

`member_site_access` (ADR-015: "este miembro trabaja en este sitio") es lo que
va a decidir qué sitios ve y toca un `manager` o un `operator`. Hoy nada escribe
en ella. Si el alcance por sitio se despliega sin una forma de darles acceso,
todo miembro de nivel 2 o 3 queda afuera de todo, sin salida.

Los `owner` y `director` no necesitan filas: trabajan en todos los sitios
(`hasImplicitAllSitesAccess`, `shared/auth/org-role.ts`).

## Decisión

1. **Otorgar acceso es un endpoint explícito**, `POST
   /tenancy/sites/{site_id}/access` con `member_id`, y solo lo pueden usar
   `owner` y `director` (capacidad `site:grant_access`, definida en código,
   nunca en la base).
2. **Valida que el miembro sea de la organización** y que el sitio también. Un
   miembro inexistente y uno de otra organización dan el mismo error, para no
   revelar qué ids son reales en otros tenants. `auth.member` no tiene RLS
   (ADR-011): el filtro por `organization_id` del `WHERE` es la única barrera.
3. **Permite otorgar a cualquier miembro, también a un `owner` o `director`.** Para
   ellos la fila no cambia lo que pueden hacer (ya trabajan en todos los
   sitios), pero deja registrado que trabajan en ese sitio y, como la tabla no
   tiene rol (ADR-015), no se pierde si después cambian de rol. La primera versión
   de este slice los rechazaba con un 422; se revirtió porque era una
   restricción sin un riesgo concreto que la justificara.
4. **Es idempotente de dos maneras:** por `client_mutation_id` (`mutation_log`,
   ADR-007) y porque otorgar un acceso que ya existe no es un error.
5. **Si la organización tiene un solo sitio, todo miembro recibe acceso a él
   automáticamente, sin excepción por rol** — también el `owner` y el
   `director`. Con un solo sitio no hay nada que elegir; con más de uno no se
   adivina y decide alguien con autoridad. `owner` y `director` no necesitan la
   fila para trabajar (ya lo hacen en todos los sitios), pero la reciben porque
   la tabla no tiene rol (ADR-015): la fila sobrevive a un cambio de rol, y un
   `director` que pasa a `manager` conserva su acceso sin que nadie intervenga.
   La función que lo hace (`grantAccessToSingleSite`) no mira el rol de nadie, así
   que un rol corrupto tampoco puede dejar a un miembro sin acceso. Se dispara
   desde tres hooks de Better Auth, porque hay tres momentos en que aparece un
   miembro y ninguno dispara el hook de otro (verificado en
   `dist/plugins/organization/routes/` del paquete instalado):
   - `afterAddMember`: `addMember` de servidor (`crud-members.mjs`).
   - `afterAcceptInvitation`: aceptar una invitación crea el miembro con el
     adaptador y dispara solo este (`crud-invites.mjs`).
   - `afterCreateOrganization`: para **el dueño al crear la organización**. Ahí
     `afterAddMember` también corre, pero *antes* de que exista el sitio por
     defecto: Better Auth ejecuta `createMember` → `afterAddMember` → … →
     `afterCreateOrganization` (`crud-org.mjs`, líneas 100, 101 y 137), y el sitio
     lo crea el último. Con solo `afterAddMember`, el dueño se quedaba sin fila
     (probado: sin la llamada en `afterCreateOrganization` falla el test).
6. **El script operativo `ensure-default-sites` asegura la misma invariante**, para
   todos los miembros existentes: en toda organización de un solo sitio, todo
   miembro tiene acceso a él, sin excepción por rol. Usa la misma función que los
   hooks (`grantAccessToSingleSite`), así que es a la vez el backfill de los
   miembros que ya existían cuando se introdujo el alcance por sitio (incluidos
   los dueños) y la reparación de un otorgamiento automático fallido. Con eso el
   script asegura dos invariantes: toda organización tiene su sitio (ADR-013) y,
   en las de un solo sitio, todo miembro tiene acceso.

## Si el hook falla

Mismo criterio que ADR-013: los hooks corren **después** de que el miembro ya
existe, sin una transacción que los envuelva, así que no pueden deshacerlo.
Verificado en el paquete instalado (`dist/plugins/organization/routes/`):

- `addMember` (`crud-members.mjs`): `adapter.createMember` ya resuelto, y recién
  después `afterAddMember`.
- Aceptar una invitación (`crud-invites.mjs`): la invitación pasa a `accepted` y se
  crea el miembro; la reversión a `pending` solo cubre una falla **antes** de
  crearlo. `afterAcceptInvitation` corre después, fuera de ese `catch`.

Qué pasa entonces si el otorgamiento automático lanza:

1. **El error se propaga, no se traga.** La respuesta de `addMember` o de
   `accept-invitation` es un error, aunque el miembro ya quedó creado. En una
   invitación, quien la aceptó ve un error pero ya es miembro y la invitación
   queda aceptada: reintentar aceptar no repara nada.
2. **El miembro queda sin acceso al sitio.** No ve ni toca nada de un sitio hasta
   que alguien lo repare; no queda en un estado peligroso, queda inútil.
3. **Se repara sin hacerlo a mano**, con cualquiera de dos caminos, ambos
   idempotentes: correr `ensure-default-sites` (punto 6), que lo encuentra y lo
   corrige junto con cualquier otro caso, o que un `owner`/`director` lo otorgue
   con `grant-site-access`.

Como el otorgamiento no interpreta el rol, ya no hay un caso de "rol ilegible" que
quede sin otorgar ni que haya que loguear aparte: cualquier miembro de una
organización de un solo sitio recibe su fila.

El otorgamiento automático y el endpoint comparten un único `INSERT`
(`shared/auth/member-site-access.ts`), en `shared/` por el mismo motivo que
`ensure-default-site.ts`: el hook no puede importar `modules/*`.

## Lo que este ADR no resuelve (a propósito)

- **Una organización que pasa de uno a más sitios.** Los miembros que ya tenían la
  fila conservan el acceso al primero, y los miembros nuevos no reciben ninguno
  automáticamente (con más de un sitio no se adivina). Es lo esperado: alguien
  con autoridad decide a qué sitios va cada uno.
- **Revocar acceso** y **quitar a un miembro de la organización** no borran filas
  de `member_site_access` (sin FK a `auth.member`, ADR-010): quedan filas de
  miembros que ya no existen. No dan acceso a nada, pero conviene limpiarlas
  cuando existan esos flujos.
- **Quién otorgó cada acceso** no queda registrado: `member_site_access` no tiene
  columnas estándar (brecha de fase 1). Lo cubre el audit trail
  (`docs/data-model.md`: "Se audita: ... `member_site_access`").
