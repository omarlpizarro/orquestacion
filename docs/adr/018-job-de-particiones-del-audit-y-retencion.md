# 018. Job de particiones del audit, worker en el servidor y retención

- **Estado:** aceptada
- **Fecha:** 2026-10-17

## Contexto

`audit_log` es la única tabla que crece sin cota por diseño, y está particionada por mes
sobre `created_at` (`0012`). Hasta ahora las particiones del mes actual y de los doce
siguientes salen de la propia migración; cuando se acaben, los `INSERT` caen en la partición
`DEFAULT`. Hace falta un proceso que cree las particiones por adelantado, y una decisión
sobre cuánto tiempo se conserva el audit (CLAUDE.md §13, punto 4).

Tres hechos del esquema acotan las opciones:

- **La partición es global, no por tenant.** Una partición contiene el mes de todas las
  organizaciones. No se puede retener distinto por organización borrando particiones, y
  tampoco borrando filas: `app_user` no tiene `DELETE` sobre `audit_log` y así debe seguir.
- **La `DEFAULT` estorba.** Postgres no deja crear la partición de un mes si la `DEFAULT` ya
  tiene filas de ese mes (`23514`, verificado en los tests de `0012`).
- **`app_worker` no es dueño de nada.** Crear una partición exige ser dueño de `audit_log`.
  `app_ensure_audit_partitions(desde, meses)` ya existe (`0012`, ampliada en `0015`) y es
  `SECURITY DEFINER` de `app_owner`, con el `EXECUTE` revocado a `PUBLIC` y sin otorgar a nadie.

## Decisión

### 1. El job

`audit.maintain` es una cola de pg-boss en `apps/worker`. Llama a
`app_ensure_audit_partitions(hoy_UTC, 13)`: el mes actual y doce más, que es lo que la `0012`
ya dejó. Corre **al arrancar el worker** (con una clave que evita acumular una corrida por
cada reinicio seguido) y **todos los días a las 03:00 UTC**. Es idempotente, y como mantiene
unos doce meses por delante, un día en que falle no es crítico. Reintenta tres veces con
espera creciente. No lee filas de negocio: corre sin tenant (`withoutTenantTransaction`) y lee
las particiones del catálogo.

### 2. Si la `DEFAULT` tiene filas, el job falla fuerte

No las mueve. Reubicarlas exigiría una función `SECURITY DEFINER` nueva que apague y vuelva a
encender el `FORCE ROW LEVEL SECURITY` de la `DEFAULT` dentro de una transacción, para que el
dueño pueda leerlas: es un riesgo que solo se justificaría si el caso ocurre, y la `0012` lo
evita con el margen de doce meses. Si ocurre, el job falla con `23514`, la falla queda en
`pgboss.job`, en el log y en la prueba de humo, y lo resuelve una persona.

### 3. Retención: un umbral en código, y por ahora no se borra nada

- `AUDIT_RETENTION_MONTHS = 60` en `apps/worker/src/audit-maintain.ts`, **solo como umbral**.
  Pasado el umbral, el job **informa** en el log qué particiones lo superaron. No hace
  `DETACH` ni `DROP`.
- **La política futura es archivar, no borrar:** `DETACH`, exportar a object storage,
  verificar la exportación y recién después `DROP`. Eso va en su propio ADR y su propio PR, y
  se hace cuando existan **backups con restore probado** (condición de ADR-014) y
  **object storage** (hoy no hay MinIO desplegado).
- **Salud.** Recordamos que la historia clínica se conserva diez años, pero **no está
  verificado**. Es una pregunta para un asesor legal **antes del primer cliente de ese
  sector**; el audit de tareas operativas puede no ser parte de la historia clínica. Hasta
  que se responda, 60 meses es una cifra de trabajo, no un compromiso con ningún cliente.
- **Variación por plan comercial.** Como la retención física es una sola para todos (primer
  punto del contexto), el plan solo podrá variar una **ventana de lectura** (cuánta historia
  ve cada plan). Eso es de la fase 7. La constante en código, y no una fila en la base, sigue
  el criterio de las capacidades.

Opciones evaluadas: 12 meses (poco espacio, pero insuficiente para cualquier cliente con
exigencia legal y sin vuelta atrás), 24 meses (cubre auditorías anuales, tampoco alcanza para
sectores regulados) y 60 meses (cubre casi todo lo exigible fuera de salud; son 60 tablas, que
Postgres maneja sin problema, a costa del espacio de todos los planes). Se eligió 60 como
umbral porque, al no borrarse nada todavía, equivocarse hacia arriba no cuesta nada y hacia
abajo no se puede deshacer.

### 4. Guardas dentro de `app_ensure_audit_partitions` (`0020`)

Desde ahora la llama `app_worker`, así que valida sus parámetros por dentro, con
`22023` (`invalid_parameter_value`) y antes del primer `CREATE`, de modo que una llamada fuera
de rango no crea nada:

- `p_months` entre 1 y 24 (ninguno nulo);
- `p_from` a un mes o menos de hoy (UTC, como el resto del audit).

Rigen también para `app_owner`: una migración futura no puede crear particiones de 2099.
Conserva `SECURITY DEFINER`, `SET search_path = pg_catalog, public, pg_temp` y los nombres
calificados (CLAUDE.md §6).

### 5. Sin locks fuertes en el día a día

`app_ensure_audit_partitions` terminaba llamando a `app_apply_tenant_policies()`, que hace
`ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` sobre **todas** las tablas de negocio en cada
llamada, aunque ya estuvieran así, y repetía el `REVOKE` de cada partición. `ALTER TABLE` toma
`ACCESS EXCLUSIVE` aunque no cambie nada. Eso era inocuo mientras solo corría en migraciones; con
un job diario, una transacción larga abierta sobre `task`, `project` o cualquier otra dejaba al
job encolado y bloqueaba todo lo que llegara detrás. **Verificado con `pg_locks`** antes de
arreglarlo: cada corrida tomaba `AccessExclusiveLock` sobre las 9 tablas de negocio y
todas las tablas del audit.

La `0020` lo corrige en tres puntos:

- `app_apply_tenant_policies()` solo hace el `ALTER` si `relrowsecurity` o
  `relforcerowsecurity` están en falso (una tabla nueva sigue recibiendo los dos).
- `app_ensure_audit_partitions` mira el catálogo con `to_regclass` (sin locks) y crea,
  revoca y aplica policies **solo si creó alguna partición**. Un día sin particiones nuevas no
  toma ningún lock fuerte.
- El job fija `lock_timeout` en 5 segundos dentro de su transacción (`set_config(..., true)`:
  no queda pegado a la conexión). Si el día en que sí hay que crear una partición no consigue el
  lock, falla con `55P03` y pg-boss reintenta, en lugar de bloquear a los demás.

Tests: con `pg_locks`, una segunda corrida no toma ningún `AccessExclusiveLock` y una que crea
una partición solo bloquea tablas del audit; en el worker, con una transacción larga abierta
sobre `task`, `project` y `audit_log`, una corrida sin nada que crear no espera, y una que
tiene que crear una falla en el tiempo fijado sin crear nada.

### 6. El `EXECUTE` de `app_worker` va en una migración, no en `ensure-roles.sql`

`GRANT EXECUTE ON FUNCTION public.app_ensure_audit_partitions(date, integer) TO app_worker` va
en la `0020`. `ensure-roles.sql` corre **antes** de las migraciones (en un volumen nuevo y en
el arnés de tests), cuando la función todavía no existe, y el `GRANT` fallaría. `app_owner` es
dueño de la función, así que puede otorgarlo, y `app_worker` ya existe por la guarda de la
`0015`.

**`ensure-roles.sql` no cambia, y la lista fija del puente tampoco.** El puente es para
funciones que pasan a ser de `app_rls_helper` (el único rol con `BYPASSRLS`);
`app_ensure_audit_partitions` es de `app_owner` y no necesita `BYPASSRLS`. Sumarla a la lista
ampliaría ese rol sin motivo.

### 7. El worker en `compose.server.yml`

Servicio `worker`, misma imagen que la API con otro comando (`node dist/main.js` desde
`/repo/apps/worker`), que conecta como `app_worker` y solo recibe `DATABASE_WORKER_URL`.
`restart: unless-stopped`, logs `json-file` de 10 MB × 3 como los demás, `mem_limit` y
`memswap_limit` de 256 MB, `cpus: 0.5`, `NODE_OPTIONS=--max-old-space-size=192`,
`cap_drop: [ALL]`, `no-new-privileges`, sin puertos. Sin healthcheck a propósito: no escucha
en ningún puerto, y un healthcheck inventado diría "sano" sin saberlo. La señal real es el job.

### 8. Cómo se ve que anda

- `scripts/deploy.sh` suma un paso 6, después de las migraciones y de reiniciar la API:
  `up -d --wait worker`. El orden importa: el worker necesita el esquema `pgboss` y el
  `EXECUTE` que deja el migrador.
- `scripts/smoke-test.sh` suma el paso 7, **de solo lectura**: falla si la última corrida
  terminada de `audit.maintain` no está `completed` o es de hace más de 48 horas, si hay menos
  de dos meses de particiones por delante del mes actual, o si `audit_log_default` tiene filas.
  Un worker caído se ve en el despliegue siguiente.
- `scripts/verify-audit-worker.sh` muestra el detalle (contenedor, logs, últimas corridas,
  particiones) y aplica los mismos tres criterios. De solo lectura: Postgres lo hace cumplir
  con `default_transaction_read_only=on`.

## Consecuencias

- El worker pasa a ser parte del despliegue. La imagen ahora trae `apps/worker`, y una vuelta
  atrás con `deploy.sh --to` hacia un commit anterior a esta decisión deja el contenedor del
  worker huérfano, corriendo la imagen nueva; es inofensivo (el `GRANT` es aditivo y el job es
  idempotente) y se baja a mano.
- Una llamada a `app_ensure_audit_partitions` fuera de rango, que hoy no existe en el código,
  pasa a fallar. Los tests que usaban fechas de 2099 se movieron a fechas relativas a hoy.
- Nada se borra todavía. Las particiones que pasen el umbral solo se informan; hasta que
  exista el ADR de archivado, ocupan espacio.
- Si la `DEFAULT` llega a tener filas, el mantenimiento se detiene hasta que alguien las
  mueva a mano.

## Pendiente

- ADR y PR de archivado de particiones viejas (backups con restore probado y object storage).
- Pregunta al asesor legal sobre la retención para salud, antes del primer cliente del sector.
- Ventana de lectura por plan (fase 7).
