# 005. oRPC en lugar de ts-rest para la capa de contratos

- **Estado:** aceptada
- **Fecha:** 2026-09-19

## Contexto

La tabla de stack fijaba "Zod + ts-rest, fuente única en `packages/contracts`".
Se revisa por un hecho verificable, no por preferencia — el procedimiento que la
sección 3 de `CLAUDE.md` habilita explícitamente para este tipo de caso.

El bloqueo, con evidencia: `@ts-rest/nest@3.52.1`, última versión estable
publicada el **2025-03-04**, declara peer `@nestjs/core ^9 || ^10 || ^11` y
`zod ^3.22.3`. NestJS va por la **12.0.3** (2026-09-15) y Zod por la **4.6.5**.
El release candidate que soporta Zod 4 (`3.53.0-rc.1`) lleva desde
**2025-06-02** sin salir de RC, y su `@ts-rest/nest` correspondiente sigue
topado en Nest 11. **Cero releases estables en dieciocho meses y medio.**
Adoptar ts-rest tal cual clava el repo en Nest 11 + Zod 3 indefinidamente.

Dos hechos nuevos cambian el tablero frente a la decisión original:

- **NestJS 12 se publica como ESM puro**: `@nestjs/common`, `@nestjs/core` y
  `@nestjs/platform-fastify` declaran `"type": "module"` sin condición
  `require`.
- **NestJS 12 trae validación Standard Schema nativa** en `@Body()`, `@Query()`
  y `@Param()`. Zod 4 funciona directo, sin una capa intermedia como
  `nestjs-zod`.

Lo que no se negocia, y que cualquier reemplazo tiene que seguir cumpliendo:
fuente única en `packages/contracts` (sección 8), Zod como lenguaje de
esquemas (se usa más allá de HTTP: validación de entorno, invariantes de
dominio, payloads de PowerSync), NestJS 12 + Fastify, REST real (enlaces de
invitado de nivel 4, webhooks de pago, conector de PowerSync, subidas
presignadas) y el envelope `client_mutation_id` (sección 9).

## Decisión

oRPC **1.15.2** exacta (`@orpc/contract`, `@orpc/server`, `@orpc/nest`,
`@orpc/client`, `@orpc/openapi-client`), todas al mismo número porque
`@orpc/zod` declara peer exacto sobre `@orpc/server` y `@orpc/contract`.

- Los contratos se definen con `oc.route({ method, path })` +
  `.input()` / `.output()` / `.errors()` en `packages/contracts`. Los
  controllers los implementan con `@Implement` dentro de controllers de Nest
  normales — NestJS no se reemplaza, oRPC se monta sobre él.
- `packages/contracts` se empaqueta **ESM puro** (`"type": "module"`), no CJS.
  Todo el stack alrededor (Nest 12, oRPC, Next) es ESM; un solo formato evita
  el dual-package hazard, y CJS sería el que rema contra la corriente.
- Webhooks de pago y el conector de PowerSync se implementan como
  `@Controller` comunes al lado de los de oRPC. No es un parche: es la razón
  por la que se eligió una librería que se monta sobre Nest en vez de una que
  lo reemplaza.
- Regla de contención, verificada por `dependency-cruiser`
  (`orpc-stays-at-the-edge` en `.dependency-cruiser.cjs`): ningún import de
  `@orpc/*` en `apps/` fuera de `*.controller.ts` y `apps/web/src/lib/api.ts`.
  Los handlers de dominio reciben y devuelven tipos planos, nunca `ORPCError`.

## Consecuencias

**A favor**

- `@orpc/nest@1.15.2` declara `@nestjs/common`/`core >= 11.0.0`, abierto: es
  el único candidato evaluado cuyo peer admite Nest 12 sin override.
- Ritmo de desarrollo real: 51 releases estables en los últimos doce meses, el
  último publicado el mismo día de esta decisión. Contra cero de ts-rest.
- Zod 4 nativo vía Standard Schema (`@orpc/zod` peer `zod >=3.25.0`).
- REST de verdad: `inputStructure: 'detailed'` da
  `{ params, query, headers, body }` y `outputStructure: 'detailed'` da
  `{ status, headers, body }`. Cubre los casos de la sección 8 sin inventar
  nada por fuera del contrato.
- `.errors({ CODE: { status, message } })` calca el contrato de error de la
  sección 8: un tipo por caso, `code` estable, `message` en español, y el
  cliente lo estrecha con `safe()` / `isDefinedError()`. La especificación
  OpenAPI sale del mismo contrato, sin generarla a mano.

**En contra, asumido**

- **Un solo mantenedor** (`dinwwwh`, más de mil commits; el siguiente
  colaborador humano, cuatro). Es el mismo tipo de riesgo del que se está
  saliendo con ts-rest. Mitigación: la regla de contención de arriba — si el
  proyecto muere, salir cuesta entre tres y cinco días y unas 400-500 líneas
  propias (contrato + pegamento de decorador + cliente tipado), y el dominio,
  la base y los tests no se tocan.
- **La rama estable `1.x` no corre CI contra Nest 12**: fija
  `@nestjs/* ^11.1.16` en sus propias devDependencies; Nest 12 solo se
  ejercita en la rama `main` (la que preparó la v2). El peer range admite
  Nest 12 igual, y quedó verificado a mano en el esqueleto: instalación sin
  warnings de peers y el endpoint `/health` sirviendo de punta a punta bajo
  Fastify en Nest 12.0.3. Si en algún momento se rompe, la salida es montar
  `OpenAPIHandler` sobre Fastify directamente y descartar `@orpc/nest` — un
  cambio confinado a `apps/api/src/`.
- **Viene una v2** con cambios incompatibles semanales desde junio de 2026.
  La migración se presupuesta como trabajo aparte cuando llegue, no se
  improvisa.
- **La documentación de orpc.dev describe la v2, no la 1.15.2 instalada acá.**
  No hay sitio de documentación para la v1. Un agente que lea la doc va a
  escribir `oc.meta(openapi({...}))` y no va a compilar. Queda anotado en la
  tabla de stack de `CLAUDE.md` sección 3.
- **oRPC es ESM puro**, lo que obligó a cambiar el empaquetado de
  `packages/contracts` que se había planeado como CJS. Se asume porque Nest 12
  tomó el mismo camino.

## Alternativas descartadas

- **Seguir con ts-rest clavado en Nest 11.** Costo a doce meses: Zod congelado
  en 3.x en todo el repo (rompe la necesidad de Standard Schema para
  validación de entorno y de PowerSync), sin la validación nativa de Nest 12,
  sin el SDK de observabilidad, `@nestjs/common@11.2.5` ya publicado con tag
  `legacy`, y overrides de pnpm acumulándose con cada paquete del ecosistema
  que mueva su peer range a 12. Todo eso para depender de algo sin releases
  desde marzo de 2025.
- **`nestjs-zod` + cliente tipado a mano.** Su peer topa en
  `@nestjs/common ^10 || ^11` (el PR que lo abre a Nest 12 sigue abierto y con
  el rango mal escrito). Siete releases en doce meses. Y comparte esquemas,
  no ruteo ni cliente: los paths de cada endpoint se hubieran vuelto a
  duplicar en `apps/`, justo lo que la sección 8 prohíbe. La validación
  Standard Schema nativa de Nest 12 lo deja sin propósito.
- **tRPC v11.** El proyecto más sano de los evaluados (27 releases en doce
  meses), pero es RPC sobre POST en `/trpc/{proc}`. Un invitado de nivel 4
  abriendo una URL firmada, un webhook de MercadoPago y una subida
  presignada son HTTP real. Se hubiera terminado corriendo tRPC y una
  superficie REST en paralelo — dos sistemas de contratos, peor que uno
  detenido. Tampoco tiene integración oficial con Nest.
- **Capa de contratos propia desde el día uno.** Con la validación nativa de
  Nest 12 haciendo el trabajo pesado, se estima en unas 400 líneas sin
  OpenAPI. El problema no es el tamaño: sin pegamento entre el contrato y el
  decorador de ruta, nada impide que el path del controller se desalinee del
  path del contrato, reintroduciendo la duplicación que la sección 8
  prohíbe. Queda como salida documentada si oRPC falla, no como punto de
  partida.
- **GraphQL.** Prohibido por la sección 3 y no resuelve nada de esto.
