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

- Cada endpoint de escritura paga una consulta extra a `mutation_log` antes
  de aplicar la mutación, incluso cuando nunca se lo llama con un id
  repetido. Se acepta: es un `SELECT` por clave primaria, y la alternativa
  (retrofitear después) es más cara.

## Alternativas descartadas

- **Dejar el alcance limitado a mutaciones "que pueden originarse en el
  móvil".** Exige decidir, endpoint por endpoint, si "puede" originarse
  offline — una clasificación que cambia con el tiempo (hoy un endpoint es
  solo-web, mañana el móvil lo necesita) y que ya se demostró cara de
  cambiar retroactivamente en el caso de roles/RLS.
