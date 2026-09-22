# 009. Eventos de dominio: `EventEmitter` nativo de Node

- **Estado:** aceptada
- **Fecha:** 2026-09-20

## Contexto

`CLAUDE.md` §5 dice que los módulos se comunican por servicios exportados y
"eventos in-process" para reaccionar a algo, pero nunca fijó el mecanismo
concreto. El brief de fase 2 pide emitir eventos de dominio (`TaskCreated`,
`TaskAssigned`, `TaskStatusChanged`, `TaskRescheduled`) desde ahora, aunque
todavía no haya ningún módulo consumiéndolos.

Ningún paquete de eventos está en la tabla de stack de `CLAUDE.md` §3. La
opción más idiomática en NestJS, `@nestjs/event-emitter`, es una dependencia
nueva no evaluada.

## Decisión

Los eventos de dominio se emiten con la clase `EventEmitter` nativa de
Node (`node:events`), sin agregar `@nestjs/event-emitter` ni ningún otro
paquete. Cada módulo que emite eventos expone su propio emisor (o uno
compartido en `apps/api/src/shared/domain-events/`, a definir en el PR que lo
necesite) tipado con los payloads de sus eventos — no un emisor genérico
`string → unknown` para todo el sistema.

## Consecuencias

**A favor**

- Cero dependencias nuevas para algo que el runtime ya resuelve.
- Sin acoplar la forma de los eventos de dominio al ciclo de releases de un
  paquete de terceros — si más adelante hace falta algo que
  `@nestjs/event-emitter` sí resuelve (por ejemplo, eventos asíncronos con
  `waitFor` o wildcards), migrar es local al emisor, no a cada `emit()`.

**En contra, asumido**

- Se pierde la integración de DI de Nest (`@OnEvent()` como decorador). Un
  listener se registra a mano (`emitter.on('task.created', handler)`) en el
  `onModuleInit` del módulo que escucha. Es más código de plomería que un
  decorador, pero es código que no depende de un paquete externo.
- `EventEmitter` no tiene entrega garantizada ni persistencia: si el proceso
  cae entre el `emit()` y que el listener corra, el evento se pierde. Esto es
  aceptable mientras los eventos de dominio no tengan efectos que necesiten
  esa garantía (esta fase no tiene consumidores todavía); el día que un
  efecto de un evento de dominio necesite garantía de entrega, ese efecto va
  encolado con pg-boss dentro del mismo listener, no en el emisor.

## Alternativas descartadas

- **`@nestjs/event-emitter`.** Es un wrapper delgado sobre `eventemitter3`
  con integración de DI. Se descarta por ahora porque el brief no exige nada
  que el `EventEmitter` nativo no cubra (no hay consumidores todavía) y
  agregar una dependencia sin un caso de uso concreto que la necesite va
  contra el criterio de minimalismo ya aplicado a Redis en la tabla de stack
  ("todavía no hace falta"). Revisar si aparece un caso real que necesite
  wildcards, espera asíncrona de listeners, o la ergonomía de `@OnEvent()`
  en varios módulos a la vez.
- **pg-boss para los eventos de dominio.** Da persistencia y entrega
  garantizada, pero es la herramienta de jobs asíncronos, no de eventos
  in-process síncronos dentro del mismo request. Mezclar los dos conceptos
  (evento de dominio = job encolado) agrega latencia y complejidad a algo que
  hoy es "notificar a otro módulo dentro del mismo proceso". Sigue siendo la
  herramienta correcta para el *efecto* de un evento que necesite garantías
  (por ejemplo, encolar una notificación cuando `TaskStatusChanged` diga
  `blocked`), no para el evento mismo.
