# 001. TypeScript de punta a punta en lugar de .NET

- **Estado:** aceptada
- **Fecha:** 2026-09-19

## Contexto

La propuesta inicial era ASP.NET Core con Clean Architecture y CQRS para el
backend, React/Next.js para el dashboard y Flutter o React Native para móvil.

El dueño del proyecto tiene experiencia en .NET pero no va a escribir el código:
lo desarrolla un agente. Eso elimina el argumento principal a favor de .NET, que
era la familiaridad del equipo.

El sistema tiene tres superficies (API, web, móvil) que comparten las mismas
entidades: tarea, proyecto, recurso, reserva.

## Decisión

TypeScript en las tres superficies. NestJS con adaptador Fastify para la API,
Next.js para el dashboard, Expo para móvil, y un paquete `contracts` compartido
con esquemas Zod como única fuente de verdad de la forma de la API.

## Consecuencias

**A favor**

- Un cambio en la forma de una entidad rompe la compilación en las tres
  superficies a la vez, en vez de fallar en runtime.
- El agente mantiene un solo lenguaje, un solo gestor de paquetes y un solo
  toolchain en contexto.
- El ecosistema tiene SDK de primera para las piezas concretas que necesitamos:
  PowerSync, Expo, Better Auth.

**En contra, asumido**

- Node es más lento y consume más memoria que .NET. Mitigación: los reportes
  pesados corren en contenedores worker separados, no en el proceso de la API.
- El ecosistema TypeScript rota más rápido. Mitigación: versiones exactas, sin
  rangos `^` en producción.
- TypeScript no impone estructura. Mitigación: módulos de NestJS como fronteras
  y `dependency-cruiser` fallando el build si un módulo cruza.

## Alternativas descartadas

- **.NET 10 con vertical slices.** Mejor para lógica de dominio compleja y mejor
  runtime. Descartada por el costo de mantener dos lenguajes y por perder los
  tipos compartidos con web y móvil.
- **Stack mixto (.NET para API, TS para clientes).** Suma los costos de ambos
  sin resolver la duplicación de contratos.
