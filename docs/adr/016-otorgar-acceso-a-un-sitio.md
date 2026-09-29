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
3. **Rechaza otorgar a un `owner` o `director`** (422): ya trabajan en todos los
   sitios, una fila no les daría nada y sugeriría una restricción que no
   existe. Es fácil de relajar si algún día hace falta; no lo es de deshacer si
   ya hay filas sin sentido.
4. **Es idempotente de dos maneras:** por `client_mutation_id` (`mutation_log`,
   ADR-007) y porque otorgar un acceso que ya existe no es un error.
5. **Si la organización tiene un solo sitio, un miembro nuevo de nivel 2 o 3
   recibe acceso automáticamente.** Con un solo sitio no hay nada que elegir; con
   más de uno no se adivina y decide alguien con autoridad. Se dispara desde
   los hooks de Better Auth `afterAddMember` **y** `afterAcceptInvitation`: son
   dos formas de sumar a alguien y ninguna dispara el hook de la otra (verificado
   en `dist/plugins/organization/routes/` del paquete instalado: `addMember` de
   servidor → `afterAddMember`; aceptar una invitación crea el miembro con el
   adaptador y dispara solo `afterAcceptInvitation`).

## Mismo criterio que ADR-013

El hook corre después de que el miembro ya existe y no puede evitarlo si
falla; el error se propaga (no se traga) para que quien llamó se entere, y la
reparación es volver a otorgar: la operación es idempotente. Por eso el
otorgamiento automático y el endpoint comparten un único `INSERT`
(`shared/auth/member-site-access.ts`), en `shared/` por el mismo motivo por el
que `ensure-default-site.ts` está ahí: el hook no puede importar `modules/*`.

## Lo que este ADR no resuelve (a propósito)

- **Backfill de miembros existentes.** Lo trae el PR de alcance por sitio, que es
  quien deja de dejar pasar a quien no tiene fila. En el server de demo hoy los
  únicos miembros son `owner`, así que no hay nada que reparar ahí.
- **Cambio de rol.** Un `director` degradado a `manager` en una organización de un
  solo sitio no recibe acceso (no se cablea `afterUpdateMemberRole`): hay que
  otorgárselo. Queda anotado para el PR de alcance.
- **Revocar acceso** y **quitar a un miembro de la organización** no borran filas
  de `member_site_access` (sin FK a `auth.member`, ADR-010): quedan filas de
  miembros que ya no existen. No dan acceso a nada, pero conviene limpiarlas
  cuando existan esos flujos.
- **Quién otorgó cada acceso** no queda registrado: `member_site_access` no tiene
  columnas estándar (brecha de fase 1). Lo cubre el audit trail
  (`docs/data-model.md`: "Se audita: ... `member_site_access`").
