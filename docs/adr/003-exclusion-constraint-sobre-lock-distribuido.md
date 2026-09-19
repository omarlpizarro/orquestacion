# 003. Exclusion constraint en Postgres en lugar de lock distribuido en Redis

- **Estado:** aceptada
- **Fecha:** 2026-09-19

## Contexto

RF-B3 exige que el sistema verifique la disponibilidad de un recurso físico en
una franja horaria, emita una advertencia de sobre-reserva ante conflicto, y
permita a un perfil autorizado forzar la asignación.

La propuesta inicial resolvía esto con locks distribuidos en Redis durante la
validación de disponibilidad.

El costo de un error acá es alto y concreto: dos cirugías en el mismo quirófano,
dos frentes de obra reclamando el mismo camión pluma.

## Decisión

La integridad la garantiza PostgreSQL con una exclusion constraint GiST sobre
`resource_booking`:

```sql
CONSTRAINT resource_no_overlap EXCLUDE USING gist (
  organization_id WITH =,
  resource_id     WITH =,
  period          WITH &&
) WHERE (NOT is_override AND status <> 'cancelled')
```

El flujo de aplicación es: consultar solapamientos para mostrar la advertencia
con los datos del conflicto, insertar normalmente, y traducir un
`exclusion_violation` de Postgres a esa misma advertencia.

El forzado inserta con `is_override = true`, valor que el predicado `WHERE`
excluye de la constraint a propósito, y registra en `overridden_booking_ids` qué
reservas pisó.

Redis queda fuera del proyecto hasta que haya una necesidad medida de caché.

## Consecuencias

**A favor**

- No existe ventana de carrera. La garantía es atómica y vive en el motor.
- No hay TTL que pueda expirar en el momento equivocado, ni dependencia de la
  disponibilidad de Redis para una regla de negocio crítica.
- Un servicio menos que desplegar, monitorear y respaldar.

**En contra, asumido**

- La detección de conflicto no funciona sin conexión. Las reservas creadas desde
  el móvil offline entran como `tentative` y el servidor las confirma o las
  rechaza al sincronizar.
- Un recurso con capacidad mayor a uno no se puede modelar con esta constraint.
  Por eso cada unidad física es una fila de `resource`, agrupada por `category`.
  Ver decisión abierta 2 en `docs/data-model.md`.

## Alternativas descartadas

- **Lock distribuido en Redis.** Agrega un punto de falla y una dependencia
  temporal para una garantía que la base ya ofrece de forma atómica.
- **Verificación solo en la aplicación.** Funciona con un usuario a la vez y
  falla exactamente en el escenario que el requerimiento describe.
