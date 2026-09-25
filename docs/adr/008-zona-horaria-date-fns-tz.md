# 008. Conversión de zona horaria: `date-fns` + `date-fns-tz`

- **Estado:** aceptada
- **Fecha:** 2026-09-20

## Contexto

El brief de fase 2 pide resolver explícitamente, con test, la conversión de
"el usuario elige una fecha/hora en la hora local del sitio" a UTC (que es
como se guarda todo timestamp, `docs/data-model.md` sección "Alcance y
convenciones transversales"). Ningún ítem de la tabla de stack de `CLAUDE.md`
§3 cubre esto.

Hecho verificable que bloquea resolverlo sin una librería: Node **24.16.0**
(el que fija `.nvmrc`) no expone `Temporal` como global —
`node -e "console.log(typeof Temporal)"` imprime `undefined`. `Temporal`
habría resuelto esto sin agregar nada al `package.json`; no está disponible
en esta versión de Node.

Convertir "8:00 hora de un sitio en `America/Argentina/Jujuy`" a un instante
UTC de forma correcta y estable ante cambios de huso horario del país
(Argentina cambió DST varias veces en su historia, y otros países del sector
objetivo — minería, agro — pueden tenerlo activo) no es seguro de resolver a
mano con `Intl.DateTimeFormat` para la dirección local→UTC: la API nativa
resuelve bien UTC→local, pero la inversa requiere resolver la ambigüedad de
un offset a mano.

## Decisión

Se agregan `date-fns@4.4.0` y `date-fns-tz@3.2.0` (versión exacta, sin rango
`^`, como pide la tabla de stack) a `packages/db` o al paquete de dominio que
haga la conversión — no a `packages/contracts`, que no debe depender de una
librería de runtime más allá de Zod.

- La zona horaria de origen es `site.timezone` si el proyecto de la tarea
  tiene sitio; si no, `organization_profile.timezone` (ver ADR sobre el
  fallback en la sección de `project` de `docs/data-model.md` — `site_id`
  sigue nulable, decisión abierta #5).
- La conversión usa `fromZonedTime(fechaLocal, zonaIana)` de `date-fns-tz`
  para ir de "hora de pared en esa zona" a instante UTC, y se cubre con un
  test que fija una zona con DST histórico para no depender de que la
  máquina de CI tenga el mismo huso que la de desarrollo.

## Consecuencias

**A favor**

- `date-fns-tz@3.2.0` declara peer `date-fns ^3.0.0 || ^4.0.0`, así que
  `date-fns@4.4.0` no pide overrides de pnpm.
- Ambas son librerías chicas, funcionales (no mutan `Date`, a diferencia de
  Moment/dayjs con plugins), y tree-shakeables — no traen un runtime propio
  como un polyfill de `Temporal`.
- El día que Node exponga `Temporal` global de forma estable, la migración es
  local a la función de conversión, no a los call sites: nada fuera de esa
  función conoce la librería.

**En contra, asumido**

- Es una dependencia nueva que no estaba en la tabla de stack original. Se
  documenta acá y en `CLAUDE.md` §3, en vez de agregarla en silencio.
- Cuando `Temporal` esté disponible sin flags en el Node que fije `.nvmrc`,
  esta decisión debería revisarse — no hay urgencia mientras funcione.

## Alternativas descartadas

- **`@js-temporal/polyfill`.** Tiene la forma exacta de la API que
  eventualmente será nativa, pero es la opción más pesada de las tres
  evaluadas y no resuelve nada que `date-fns-tz` no resuelva ya para el caso
  de uso concreto (una conversión local↔UTC, no aritmética de calendario
  compleja).
- **Hand-roll con `Intl.DateTimeFormat`.** Sin dependencia nueva, pero la
  conversión local→UTC exige resolver a mano la ambigüedad del offset
  alrededor de transiciones DST — exactamente el tipo de código que una
  librería con tests propios contra la base de datos IANA hace mejor que una
  implementación ad hoc de una función.
- **Luxon / dayjs + plugin de zona horaria.** Evaluadas y descartadas por
  tamaño de superficie (Luxon reemplaza `Date` con su propio tipo en todo el
  código que lo toca) o por ser una librería con plugins que hay que recordar
  importar (dayjs) para el caso que más importa acá.
