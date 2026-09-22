# 006. Jerarquía de subtareas: `ltree` en el esquema, límite de tres niveles en el dominio

- **Estado:** aceptada
- **Fecha:** 2026-09-20

## Contexto

`docs/data-model.md` dejaba esta decisión abierta como binaria: árbol libre
con `ltree`, o dos niveles fijos sin `ltree` (más simple, pero exige quitar la
columna y el índice GiST si se elegía esa opción).

El brief de fase 2 la cierra, pero no elige ninguna de las dos ramas
originales: pide mantener `ltree` en el esquema y, aparte, limitar la
profundidad real a tres niveles desde la capa de dominio.

## Decisión

- La columna `task.path ltree` y su índice `gist (path)` se mantienen tal
  como están en `docs/data-model.md`. El esquema sigue soportando profundidad
  libre.
- `domain/` (no un `CHECK` de base) rechaza crear una subtarea que dejaría el
  árbol en más de tres niveles. El límite vive como una constante de
  aplicación (`MAX_TASK_DEPTH = 3`), no como una restricción de esquema.
- Un error de base (`CHECK` violado) es opaco para un capataz en un frente de
  obra, tal como ya se argumenta en `docs/data-model.md` para las transiciones
  de estado; la misma razón aplica acá.

## Consecuencias

**A favor**

- Cambiar el límite de tres a otro número no pide migración, solo un cambio
  de constante y su test.
- El mensaje de rechazo puede ser específico en español ("esta tarea ya tiene
  tres niveles de subtareas, no se puede descomponer más"), algo que un
  `CHECK` no puede dar.
- `ltree` sigue disponible para consultas de subárbol (`WHERE path <@
  'raiz.rama'`) aunque hoy el árbol nunca pase de tres niveles — si el límite
  sube más adelante, la infraestructura de consulta ya está.

**En contra, asumido**

- Se paga el costo de mantener `ltree` (el trigger que actualiza `path` al
  insertar o mover) sin aprovechar todavía su ventaja principal, que es
  evitar el CTE recursivo en árboles grandes. Con tres niveles, ese CTE
  tampoco sería costoso. Se acepta la redundancia a cambio de no tener que
  migrar el día que el límite se relaje.

## Alternativas descartadas

- **Dos niveles fijos, sin `ltree`.** Es la opción que planteaba
  `docs/data-model.md` como alternativa a mantener `ltree`. Se descarta
  porque el brief pide explícitamente mantener la columna.
- **Límite de profundidad como `CHECK` sobre `nlevel(path)`.** Técnicamente
  posible, pero repite el problema ya identificado para las transiciones de
  estado de `task`: el error queda en manos de Postgres, no de un mensaje de
  dominio en español.
