# 015. `member_site_access` sin columna `role`

- **Estado:** aceptada
- **Fecha:** 2026-09-29

## Contexto

`member_site_access` (`docs/data-model.md`, migración `0003`) nació con una
columna `role` (`CHECK role IN ('manager','operator')`) junto a la clave
`(member_id, site_id)`. Nada del sistema la usa: ningún código de la
aplicación lee ni escribe esa tabla, y el diseño de alcance por sitio la
necesita ahora por primera vez.

Al diseñarlo apareció la pregunta que la columna dejaba abierta: ¿ese `role`
es una copia del rol de la organización, o un rol distinto por sitio? El rol
de un miembro ya vive en `auth.member.role` (Better Auth) y todo lo demás lo
asume único por miembro: las capacidades se resuelven en código a partir de él
(`CLAUDE.md` §7), y `parseSingleOrgRole` falla a propósito si un miembro
llega con dos roles distintos.

## Decisión

1. **Se elimina la columna `role` de `member_site_access`** (migración
   `0011_member_site_access_drop_role.sql`), y con ella su `CHECK`.
2. La tabla significa únicamente **"este miembro trabaja en este sitio"**. La
   fila existe o no existe; no dice qué puede hacer ahí.
3. **El rol sale siempre de la organización** (`auth.member.role`). Las
   capacidades siguen resolviéndose en código, nunca en la base.
4. Si algún día hace falta un rol distinto por sitio (una persona encargada en
   un sitio y operaria en otro), se agrega como **expansión** —una columna
   nueva, nulable, con su propia decisión y su propio ADR—, no resucitando esta.

## Por qué no las otras dos

- **Dejar la columna como espejo, ignorada por la autorización.** Es una
  segunda copia del rol. Si a alguien lo pasan de `operator` a `manager` en la
  organización, la fila sigue diciendo `operator`, y nada obliga a que
  coincidan. Una columna que ninguna regla lee pero que un futuro código puede
  leer por error es el tipo de dato que diverge en silencio.
- **Rol independiente por sitio.** Es más flexible, pero obliga a resolver el
  rol según el sitio del recurso en cada chequeo, y por lo tanto a rehacer la
  matriz de transiciones de `task.status` (ADR-012) y `parseSingleOrgRole` para
  que dependan del sitio. Hoy no hay un caso de negocio que lo pida.

## Consecuencias

- **Es un `DROP COLUMN`, y es una excepción razonada a la regla dura 7**
  (`CLAUDE.md` §2) y al principio de §6 sobre migraciones que solo agregan. La
  regla existe para que el código que sigue desplegado (o al que se vuelve con
  `deploy.sh --to`) no pierda una columna que usa. Acá esa condición ya se
  cumple: ningún código la usó nunca, y la tabla está vacía en el único ambiente
  (verificado con una búsqueda en `apps/` y `packages/`, y con un `SELECT` de
  solo lectura en el server de demo). Por eso el borrado no espera a un
  despliegue posterior. No es un precedente para columnas que el código sí usa.
- La migración va en su propio PR, antes del slice que empieza a escribir filas
  en esta tabla (`CLAUDE.md` §12: el prerrequisito se mergea antes). Ese slice
  no podría insertar sin resolver una columna `NOT NULL` que no tiene de dónde
  sacar.
- `docs/data-model.md` se actualiza (esquema y plan de migraciones, que se
  corre un lugar).
- `member_site_access` sigue sin las columnas estándar de `CLAUDE.md` §6
  (`created_at`, `created_by_member_id`, ...): es una brecha de fase 1 que este
  ADR no toca. Consecuencia práctica: la tabla no registra quién otorgó cada
  acceso; eso queda para el audit trail (`docs/data-model.md`, "Se audita:
  ... `member_site_access`").
