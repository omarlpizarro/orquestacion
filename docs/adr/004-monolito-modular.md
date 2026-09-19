# 004. Monolito modular con vertical slices

- **Estado:** aceptada
- **Fecha:** 2026-09-19

## Contexto

La propuesta inicial era Clean Architecture en cuatro capas técnicas (Domain,
Application, Infrastructure, WebAPI) con CQRS mediante un mediador.

El código lo escribe un agente a lo largo de decenas de sesiones, sin memoria
entre ellas. El riesgo dominante no es la deuda técnica clásica sino la deriva:
que la estructura se degrade porque cada sesión interpreta las convenciones un
poco distinto.

Por otro lado, el sistema tiene cinco áreas de negocio con fronteras naturales
claras y no tiene, ni va a tener en años, una escala que justifique servicios
separados.

## Decisión

Un solo despliegue de API, dividido en cinco módulos de NestJS con fronteras
explícitas: `tenancy`, `projects`, `scheduling`, `collaboration`,
`notifications`.

Dentro de cada módulo, el código se organiza por caso de uso, no por capa:

```
modules/projects/
  features/
    create-task/
      create-task.command.ts
      create-task.handler.ts
      create-task.controller.ts
      create-task.spec.ts
  domain/
  infrastructure/
```

Un módulo no importa el esquema de otro ni hace join contra sus tablas. Se
comunican por servicios exportados y eventos in-process. `dependency-cruiser`
falla el build si una frontera se cruza.

## Consecuencias

**A favor**

- Un slice es la unidad de trabajo que se le puede pedir a un agente en un
  prompt y verificar de una sentada. Todo lo que el cambio toca está junto.
- Las fronteras entre módulos son verificables por herramienta, no por
  disciplina. Es lo único que aguanta cincuenta sesiones.
- Si alguna vez hace falta extraer un módulo a un servicio, la frontera ya
  existe.

**En contra, asumido**

- Sin capas rígidas, la lógica de dominio puede filtrarse a los handlers.
  Mitigación: reglas de negocio e invariantes viven en `domain/`, y si un cambio
  toca cuatro slices a la vez, es señal de que va en `domain/`.
- Un solo despliegue significa que un problema de memoria afecta a todo.
  Mitigación: los trabajos pesados (PDF con Playwright, workers de pg-boss)
  corren en contenedores separados.

## Alternativas descartadas

- **Clean Architecture en cuatro capas.** Agregar un campo obliga a tocar cinco
  archivos en cuatro proyectos. La indirección cuesta más de lo que aporta en un
  sistema de este tamaño.
- **MediatR o equivalente.** MediatR pasó a licencia comercial en 2025, con una
  edición gratuita para facturación menor a cinco millones de dólares que igual
  exige registrar una clave. No hace falta un mediador para separar comandos de
  consultas: alcanzan handlers registrados en el contenedor de NestJS.
- **Microservicios.** Costo operativo desproporcionado para un equipo de una
  persona y un sistema sin problemas de escala.
