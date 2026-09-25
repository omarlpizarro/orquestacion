# 012. `done` es reversible, `cancelled` no

- **Estado:** aceptada
- **Fecha:** 2026-09-25

## Contexto

`docs/phase-2-brief.md` fijaba tres reglas para la máquina de estados de
`task.status` pero dejaba abierta una cuarta pregunta, implícita: ¿son `done`
y `cancelled` terminales por igual, o hay una diferencia entre "el trabajo
terminó" y "el trabajo se cancela"?

En el trabajo de campo (construcción, agroindustria, salud) cerrar una tarea
por error es habitual: se toca la pantalla equivocada con guantes puestos, se
marca "listo" antes de terminar por apuro, alguien completa la tarea de otro
por confusión. Si `done` fuera terminal como `cancelled`, la única forma de
corregir eso sería crear una tarea nueva — y esa tarea nueva no hereda la
bitácora (`task_update`), los adjuntos ni el `audit_log` de la original, que
es justamente lo que este sistema existe para conservar (CLAUDE.md §1: "el
trabajo pasa hoy por cuadernos, llamadas y grupos de WhatsApp").

## Decisión

- `done → in_progress` es una transición válida, reservada a
  `owner`/`director`/`manager` (nunca `operator`: reabrir es una decisión de
  gerencia, no del operativo que hizo — o dijo haber hecho — el trabajo).
- Exige motivo (`requiresReason: 'reopen'`), con el mismo mecanismo que ya
  exigía motivo para bloquear una tarea. Reabrir sin dejar por qué sería
  autorizar a corregir un cierre sin dejar rastro de que se corrigió — el
  problema exacto que "dejar rastro" busca evitar.
- La transición limpia `actual_end_at` (`clearsActualEndAt: true`): si no se
  limpiara, la tarea reabierta quedaría "en curso" con una fecha de fin ya
  cargada, y el KPI de desviación de tiempo (RF-F2, `docs/data-model.md`)
  la seguiría contando como terminada mientras se sigue trabajando en ella.
  Al completarse de nuevo, `actual_end_at` se fija una vez más con la hora
  del servidor: el fin real que cuenta es el último, no el primero.
- `cancelled` sigue siendo terminal, sin excepción. Cancelar es una decisión
  de negocio deliberada (una cirugía se suspende, una cosecha se cancela por
  lluvia), no un error de tipeo. Si hace falta revivir el trabajo después de
  cancelarlo, se crea una tarea nueva — a diferencia de reabrir, acá no hay
  una corrección que reparar, hay una decisión distinta que tomar, y una
  tarea nueva es justamente eso.

## Consecuencias

**A favor**

- El caso de uso real más común de "reabrir" (cerrar por error) queda
  cubierto sin perder historial.
- El motivo obligatorio y el rol restringido hacen de reabrir una acción
  visible y deliberada, no un acceso silencioso que erosione la confianza en
  que "`done`" significa terminado.
- El KPI de desviación de RF-F2 no queda contaminado por tareas reabiertas
  con una fecha de fin vieja todavía cargada.

**En contra, asumido**

- `isTerminalTaskStatus` ya no puede usarse como sinónimo de "no se puede
  tocar más" para `done` específicamente — cualquier código futuro que
  asuma que un estado no terminal siempre admite más de una transición
  saliente, o que "terminal" es equivalente a "no volvió a cambiar nunca",
  tiene que revisar contra la tabla real, no contra esa función a secas.
- Un `done → in_progress → done` dos veces seguidas es indistinguible, en
  `actual_end_at`, de una tarea que nunca se reabrió — solo el historial de
  `task_update` (con el motivo de la reapertura) conserva esa diferencia.
  Se acepta porque `actual_end_at` es "cuándo terminó de verdad", no "cuántas
  veces se marcó terminada".

## Alternativas descartadas

- **`done` terminal como `cancelled`, corregir con una tarea nueva.** Es el
  diseño más simple y el que se asumía por defecto antes de esta decisión.
  Se descarta porque pierde bitácora, adjuntos y audit trail de la tarea
  original — el costo que este ADR existe para evitar.
- **Permitir reabrir a cualquier rol, no solo gerencia.** Se descarta:
  dejaría que la misma persona que cerró la tarea por error la reabra sin
  que nadie más se entere, que es exactamente el control que el motivo
  obligatorio más el rol restringido buscan imponer.
- **No limpiar `actual_end_at` al reabrir.** Técnicamente más simple, pero
  contamina el KPI de desviación de RF-F2 mientras la tarea reabierta sigue
  en curso — descartado apenas se lo pensó contra ese reporte.
