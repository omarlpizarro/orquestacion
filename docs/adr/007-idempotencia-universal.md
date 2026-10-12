# 007. Idempotencia universal desde fase 2

- **Estado:** aceptada
- **Fecha:** 2026-09-20

## Contexto

`CLAUDE.md` §9 y `docs/data-model.md` (sección "Sincronización offline")
enmarcaban `client_mutation_id` + `mutation_log` como el mecanismo de
idempotencia para mutaciones que **pueden originarse en el móvil**: la app
offline reintenta un envío tras perder señal, y el servidor necesita
distinguir un reintento de una mutación nueva.

El brief de fase 2 generaliza esto: todo endpoint de escritura, sin importar
si puede o no originarse offline, acepta `client_mutation_id` y lo registra
en `mutation_log`.

## Decisión

Todo endpoint de escritura de la API — incluidos los que solo se llaman
desde el dashboard web, que nunca corre offline — acepta `client_mutation_id`
(UUIDv7) y lo registra en `mutation_log` antes de devolver la respuesta. Un
reintento con el mismo id devuelve el resultado anterior en vez de aplicar la
mutación de nuevo.

Mismo criterio que adelantar roles y RLS a fase 1 (`docs/data-model.md`,
sección "Migraciones y decisiones abiertas"): es cara de retrofitear. Agregar
idempotencia a un endpoint que ya está en producción exige coordinar un
cambio de contrato con todos los clientes a la vez; adelantarla mientras el
sistema todavía no tiene usuarios reales es gratis en comparación.

`mutation_log` no cambia de forma — sus columnas (`member_id`,
`organization_id`, `kind`, `entity_id`, `result`, `rejection_reason`) ya eran
genéricas, no específicas de móvil.

## Consecuencias

**A favor**

- Un mismo mecanismo cubre el reintento de una app offline y el de una
  pestaña de navegador que reintenta un POST por un timeout de red — no hace
  falta distinguir el origen del cliente.
- Todo slice de fase 2 en adelante sigue la misma forma del slice de
  referencia (PR 1), sin una rama especial "si viene del móvil".

**En contra, asumido**

- Cada endpoint de escritura paga una sentencia a `mutation_log` al
  principio de la transacción, incluso cuando nunca se lo llama con un id
  repetido. Se acepta: es un `INSERT` por clave primaria (desde la
  actualización de abajo, ya no un `SELECT` más un `INSERT`), y la alternativa
  (retrofitear después) es más cara.

## Alternativas descartadas

- **Dejar el alcance limitado a mutaciones "que pueden originarse en el
  móvil".** Exige decidir, endpoint por endpoint, si "puede" originarse
  offline — una clasificación que cambia con el tiempo (hoy un endpoint es
  solo-web, mañana el móvil lo necesita) y que ya se demostró cara de
  cambiar retroactivamente en el caso de roles/RLS.

## Actualización (2026-10-13): se reserva la mutación antes de leer

**Qué falló.** La primera forma del patrón era: buscar la mutación previa
(`SELECT`), leer el estado, aplicar, y registrar la mutación al final
(`INSERT`). Con dos pedidos simultáneos con el mismo `client_mutation_id`,
ninguno ve el registro del otro al empezar; el segundo lee el estado que el
primero ya confirmó y responde un error de dominio en vez de la respuesta del
primero: un 409 de versión (`change-task-status`, `change-project-visibility`)
o un 422 por una transición que ya no existe (`in_progress` → `in_progress`).
Un reintento posterior sí devolvía lo correcto, pero el pedido en vuelo
recibía un error que el cliente móvil no sabe interpretar como "ya está hecho".
Medido: el test de pedidos simultáneos de `change-task-status` fallaba 9 de 14
corridas.

**Decisión.** Todo endpoint de escritura **reserva la mutación como primera
sentencia de la transacción, antes de leer nada**:

```sql
INSERT INTO mutation_log (client_mutation_id, organization_id, member_id, kind, entity_id, result)
VALUES (...) ON CONFLICT (client_mutation_id) DO NOTHING RETURNING client_mutation_id
```

Es `claimMutation` (`apps/api/src/shared/database/mutation-log.js`).

- **Devuelve fila:** la mutación es de este pedido y sigue.
- **No devuelve fila:** otro pedido con el mismo id ya confirmó. Postgres hizo
  esperar a este `INSERT` hasta que aquel confirmara, así que lo registrado ya
  es visible. Se lee lo registrado y se **reconstruye la respuesta** (cada
  handler sabe armarla: lee la entidad por el `entity_id` guardado), sin error
  y sin reintento.
- **Un rechazo de dominio** (cualquier error después de reservar) hace
  rollback de la transacción y se lleva la reserva: un reintento con el mismo
  id empieza de cero. Si el primero hace rollback mientras el segundo espera,
  el segundo reserva y sigue como si fuera el primero.
- **`entity_id` se conoce al reservar:** es el id que ya viene en el pedido
  (la tarea o el proyecto que se crea, o el recurso sobre el que se actúa).
  Por eso la reserva es una sola sentencia, sin un `UPDATE` posterior.
- **El id es de otra organización:** `mutation_log` tiene RLS por organización,
  así que la fila existe pero no se ve. No hay nada que reconstruir:
  `MutationIdReusedError` (409, `client_mutation_id_reused`), sin decir de
  quién era.
- **Los eventos de dominio** se emiten solo cuando la mutación se reservó, no
  en el reintento.

**Lo que esto no resuelve y sigue siendo de cada handler:** las otras
unicidades. Dos pedidos con **distinto** `client_mutation_id` que chocan por una
restricción de negocio no se serializan en `claimMutation`: `create-project`
traduce la violación de su código (único por organización) y de su `id` a
errores de dominio (`project_code_taken`, `project_id_taken`), y
`add-project-member` usa `INSERT ... ON CONFLICT DO NOTHING` sobre el índice
único parcial de miembros activos, para que agregar a quien ya es miembro
sea idempotente también entre pedidos distintos. Ya no hay reintentos
automáticos por violación de unicidad (`retryOnceOnUniqueViolation` se
eliminó).

**Un id reusado para otra operación (mitigación parcial de CLAUDE.md §13 #6).**
Cuando `claimMutation` no reserva y encuentra la mutación previa, compara su
`kind` y su `entity_id` con los del pedido actual (los ids, en minúsculas: la
columna es `uuid` y el cliente pudo mandarlo en mayúsculas). Si no coinciden no
es un reintento sino un id reusado: `MutationIdReusedError` (409,
`client_mutation_id_reused`) y no se toca nada. Sin esto, crear la tarea A y
después cambiar el estado de la tarea B con el mismo id devolvía la respuesta de
A como si fuera la de B. **Lo que sigue sin detectarse:** el mismo `kind` y la
misma entidad con datos distintos (otro `to_status` sobre la misma tarea, otro
miembro en `add-project-member` sobre el mismo proyecto) sigue devolviendo el
resultado anterior en silencio; cerrarlo exige guardar un hash del payload.

**Cómo se aplica a un handler nuevo.** `claimMutation` va antes de cualquier
lectura; la rama "ya reservada" reconstruye la respuesta sin volver a evaluar
reglas de negocio contra el estado actual; el resto de la lógica va después, en
la misma transacción. Cada handler de escritura tiene un test de dos pedidos
simultáneos con el mismo `client_mutation_id` (los dos reciben la misma
respuesta exitosa y hay un solo efecto), y `claim-mutation.integration.spec.ts`
verifica la reserva contra Postgres real (espera, rollback, otra organización, id reusado para otro `kind` o entidad).
