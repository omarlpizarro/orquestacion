# 020. Stack de la web: Tailwind sobre los tokens de diseño, y un proxy del mismo origen hacia la API

- **Estado:** aceptada
- **Fecha:** 2026-10-26

## Contexto

El bloque C empieza los clientes. `apps/web` hoy es un esqueleto (una página de estado) y hay tres
cosas que el stack de `CLAUDE.md` §3 no decide:

- **Estilos, íconos y tipografía.** `docs/design-guidelines.md` (§11.1) exige Tailwind, Lucide (§7.7) y
  Manrope empaquetada (§4), y ninguno está en la tabla de §3, que prohíbe sumar frameworks sin
  discusión previa.
- **Cómo habla el navegador con la API.** La API no tiene CORS ni `trustedOrigins`: un navegador en
  otro origen no puede llamarla. Better Auth, además, valida el `Origin` de los pedidos con cookies
  contra `BETTER_AUTH_URL` y decide el atributo `Secure` de las cookies por su esquema (README,
  "Cookies y TLS").
- **Qué se despliega.** `web` no está en `compose.server.yml`; la primera pasada del servidor de demo
  fue solo API y Postgres (ADR-014), después se sumó el worker (ADR-018).

## Decisión

### 1. Dependencias nuevas de `apps/web`

Versiones exactas, verificadas en el registro de npm el 2026-10-17 (se anotan también en `CLAUDE.md` §3):

| Paquete | Versión | Para qué |
| --- | --- | --- |
| `tailwindcss`, `@tailwindcss/postcss` | 4.3.3 | Estilos. Las utilidades salen de los tokens, no de la paleta por defecto de Tailwind |
| `lucide-react` | 1.59.0 | Íconos (acepta React 19; licencia ISC) |
| `@fontsource/manrope` | 5.3.0 | Manrope empaquetada con la web: cuatro pesos estáticos (400, 500, 600, 700), nunca desde Google Fonts en ejecución (licencia OFL-1.1) |
| `better-auth` | 1.7.5 | El cliente de Better Auth, del **mismo paquete** que usa la API (mismo número, sin versión aparte que mantener) |

Verificado, no supuesto:

- `@tailwindcss/postcss` trae `postcss` como **dependencia propia**, así que `postcss` no se agrega
  aparte. `tailwindcss` 4.3.3 no corre scripts de instalación (los binarios nativos de `@tailwindcss/oxide`
  son dependencias opcionales por plataforma), así que no hace falta tocar `allowBuilds` en
  `pnpm-workspace.yaml`. Si el build de C3 muestra otra cosa, se corrige y se avisa en ese PR.
- Next 16.3.5 acepta React 19 (`^19.0.0`) y es el que ya fija §3.
- **`@fontsource/manrope` trae solo `woff` y `woff2`, ningún `ttf`:** sirve para la web y no para React
  Native. La fuente del móvil se resuelve en el primer PR móvil, empaquetada con la app y nunca desde
  Google. Este ADR no decide el paquete.

### 2. Los valores salen de `packages/ui-tokens`

Un componente nunca lleva un color, un tamaño ni un espaciado escrito a mano (CLAUDE.md §11). El
paquete genera `tokens.css` con variables CSS (el modo oscuro bajo `prefers-color-scheme` y bajo
`data-theme` en `<html>`, para el ajuste manual); la web lo importa y Tailwind lo lee con `@theme`.
Se **anula el tema por defecto de Tailwind** (colores, espaciado, radios, tamaños de texto) para que solo
existan las clases de la escala permitida: sin esto `p-7` o `bg-blue-500` compilarían igual y se
saltearían la guía. `pnpm check` lo hace cumplir (`check:raw-values`).

### 3. Proxy del mismo origen, no CORS

El navegador solo habla con el origen de la web. Next reescribe (`rewrites`) dos prefijos hacia la API:

| En el navegador | Va a |
| --- | --- |
| `/api/auth/*` | `${API_URL}/api/auth/*` (Better Auth) |
| `/backend/*` | `${API_URL}/*` (los endpoints de negocio) |

Los componentes de servidor de Next llaman a la API directo (`API_URL`, red interna de Compose) y
**reenvían la cookie de la sesión** del pedido que los originó.

Por qué no CORS: habría que abrir la API a un origen (`trustedOrigins`, `credentials`, preflight en cada
pedido con cookies) y tocar su configuración de auth, para un navegador que se puede servir sin eso. Con el
proxy las cookies son de primera mano, la API no cambia, y el esquema del origen público de la web es el que
decide si salen `Secure`. El costo es un salto más en los pedidos del navegador y que la API no se alcanza
desde el navegador si la web está caída; para el dashboard es aceptable.

### 4. Qué cambia en el servidor

- **`BETTER_AUTH_URL` pasa a ser el origen público de la web**, no el de la API. Hoy vale
  `http://192.168.0.105:18020` (el puerto de la API); con el proxy, el navegador manda su `Origin` desde la
  web, y la API tiene que reconocerlo como propio. Pasa a `http://192.168.0.105:18030` (`WEB_HOST_PORT`).
  Lo cambia Omar en `infra/docker/.env` **antes** del despliegue de C3; `deploy.sh` no lo puede inferir.
  El esquema sigue mandando: con `http://` las cookies salen sin `Secure`, y con `https://`, con `Secure`
  (ver "Condición antes de cualquier piloto", ADR-014: TLS sigue pendiente).
- **Variables nuevas del `.env`:** `WEB_HOST_PORT` (por defecto `18030`; el servidor es compartido y ya
  ocupa 18000, 18010 y 18020, y `deploy.sh` rechaza el despliegue si el puerto es de otro proceso, igual que
  hoy con la API). La web recibe `API_URL=http://api:3000`, la red interna.
- **`scripts/smoke-test.sh`:** sigue llamando a la API directo (`127.0.0.1:API_HOST_PORT`) con
  `Origin: $BETTER_AUTH_URL`, que ahora es el origen de la web, y por eso sigue siendo un origen que la API
  acepta. Se suman pasos de solo lectura o idempotentes: la web responde en `WEB_HOST_PORT`; el login hecho
  **por el proxy** (`/api/auth/sign-in/email` en el puerto de la web) devuelve la cookie con el atributo
  `Secure` que corresponde; `/backend/health` por el proxy devuelve el commit desplegado; y una página con
  sesión se renderiza en el servidor sin redirigir a `/login`.
- **`scripts/deploy.sh`:** un paso más, después del worker: construir y levantar `web`
  (`up -d --wait web`, con healthcheck HTTP, a diferencia del worker).
- **`compose.server.yml`:** servicio `web` con la misma forma que `api` (`restart: unless-stopped`, logs
  acotados, `cap_drop`, sin puertos más que `WEB_HOST_PORT`) y **límites de memoria medidos en C3 en la imagen
  real**, como se hizo con el worker (ADR-019, punto 7), no supuestos. Imagen propia (`web.Dockerfile`, Next
  en modo `standalone`).
- **El cliente móvil no usa este proxy.** Habla con la API directo, así que la API tiene que ser alcanzable
  desde el teléfono (en la LAN del demo, `API_HOST_PORT`), y Better Auth tiene que aceptar su origen. Eso se
  decide y se verifica en el primer PR móvil (hoy `trustedOrigins` no existe); este ADR solo fija que **la web
  y el móvil entran por puertas distintas**: la web, por su proxy; el móvil, por la API.

### 5. Solo login

La web tiene inicio de sesión y selección de organización; **no tiene alta de cuentas ni de
organizaciones** (eso es el onboarding, fase 7). Las cuentas del demo las crea `scripts/seed-demo.sh`: un
script de **solo demo**, idempotente, que corre Omar. Crea una organización de demo con un `owner`, un
`manager` y un `operator`, y un proyecto con algunas tareas, para poder mostrar el producto. Escribe en la
base, así que no lo corre la prueba de humo ni nadie más (CLAUDE.md §12).

### 6. Estructura

- App Router; los datos se leen en componentes de servidor y los componentes de cliente quedan para la
  interacción.
- Dos puntos únicos de contacto con librerías de terceros, ambos en `apps/web/src/lib/`: `api.ts` (oRPC,
  ya existe, ADR-005) y `auth.ts` (el cliente de Better Auth). Lo hace cumplir `dependency-cruiser`, igual
  que `@orpc/*`.
- **Inicio** es "qué está bloqueado o vencido hoy" entre todos los proyectos visibles (con la visibilidad de
  ADR-017). Necesita un endpoint que hoy no existe y va como slice aparte antes de las pantallas de avisos
  (C7). Hasta que exista, Inicio lleva a Proyectos.

## Consecuencias

- Tres dependencias de estilos y de íconos entran al stack, y `CLAUDE.md` §3 las nombra con su versión.
- `BETTER_AUTH_URL` cambia de significado operativo (de "la URL de la API" a "el origen de la web"), y es un
  cambio manual del `.env` del servidor que hay que hacer antes de desplegar C3. Es la parte que se puede
  olvidar; por eso está en este ADR, en el PR de C3 y en el README.
- La web y el móvil tienen caminos de autenticación distintos. Cada uno se prueba por separado.
- Tailwind sin tema por defecto es más estricto que el uso habitual: cada clase que se usa tiene que existir
  en los tokens. Es lo que se busca.

## Alternativas descartadas

- **CORS en la API:** ver el punto 3.
- **Tailwind 3 o CSS Modules:** la guía (§11.1) nombra Tailwind, y 4.x es la línea vigente.
- **Manrope por `next/font/google`:** la guía lo prohíbe (la fuente se empaqueta, nunca se descarga en
  ejecución), y `next/font/google` hace justo eso en desarrollo y la descarga en el build.
- **`@fontsource-variable/manrope`:** una sola fuente variable; la guía fija cuatro pesos, y las estáticas
  se pueden cargar solo las que se usan.
- **Un solo paquete de fuente para web y móvil:** no existe con estos formatos (punto 1); el móvil decide el
  suyo.

## Pendiente

- Fuente del móvil (primer PR móvil).
- `trustedOrigins` y alcance de la API desde el teléfono (primer PR móvil).
- TLS, antes de cualquier piloto (ADR-014).
- El endpoint de Inicio (bloqueado o vencido entre proyectos).
