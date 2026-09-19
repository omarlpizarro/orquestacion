# 002. Drizzle como ORM en lugar de Prisma

- **Estado:** aceptada
- **Fecha:** 2026-09-19

## Contexto

La arquitectura de datos depende de tres features específicas de PostgreSQL:

- **Row-Level Security** como segunda línea de defensa del aislamiento
  multi-tenant.
- **`tstzrange` con exclusion constraint GiST** para prevenir la sobre-reserva
  de recursos físicos (RF-B3).
- **`jsonb` con índice GIN** para los campos personalizables por tenant (RF-A5).

Ninguna de las tres es opcional ni reemplazable por lógica de aplicación.

## Decisión

Drizzle ORM, con `drizzle-kit` para migraciones. Las partes que Drizzle no
expresa de forma nativa (exclusion constraints, triggers de auditoría,
particionado del audit log) se escriben como SQL crudo dentro de las
migraciones generadas.

## Consecuencias

**A favor**

- Drizzle es SQL-first: lo que se escribe en el esquema es cercano al DDL, así
  que las features de Postgres no se pelean con la abstracción.
- Permite declarar policies de RLS junto al esquema, en el mismo lugar que la
  tabla que protegen.
- Sin motor externo ni capa de generación de clientes: el tipado sale del
  esquema TypeScript directamente.

**En contra, asumido**

- La ergonomía para CRUD simple es algo peor que la de Prisma.
- Parte del esquema vive como SQL crudo, que no queda tipado. Mitigación: esas
  garantías se verifican con tests de integración contra Postgres real, no con
  el compilador.

## Alternativas descartadas

- **Prisma.** Mejor experiencia de desarrollo para CRUD, pero históricamente
  incómodo con RLS, con tipos de rango y con constraints que no modela. El
  costo aparecería exactamente en las partes críticas del sistema.
- **SQL crudo sin ORM.** Máximo control, pero pierde el tipado compartido y
  multiplica el código repetitivo en cada slice.
