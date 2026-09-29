# 014. Despliegue en el servidor de demo: Compose a mano, build en el servidor, HTTP en la LAN

- **Estado:** aceptada
- **Fecha:** 2026-09-29

## Contexto

`CLAUDE.md` §3 fijaba la infraestructura como "Docker Compose sobre Ubuntu LTS,
gestionado con Coolify"; esta decisión la cambió a "Docker Compose a mano en
Ubuntu, ver ADR-014". Antes de tener un ambiente real hacía falta
comprobar que el mecanismo de despliegue funciona de punta a punta:
construir la imagen, migrar, reiniciar, verificar qué commit corre y operar
scripts dentro del contenedor. La pasada del 2026-09-29 lo hizo sobre el
servidor Ubuntu de test (`192.168.0.105`), con API + Postgres y nada más
(sin `web`, `worker` ni MinIO: todavía no hay nada que hagan).

Ese servidor **es compartido**: al 2026-09-29 corren ahí otros cuatro
proyectos (`credit-agent`, `docagent`, `docvault`, `tango-agent` más un
SQL Server), todos con Compose plano en directorios de `~`, y ocupan los
puertos 22, 1433, 3000, 5432, 6333, 6334, 6379, 8000, 8080, 18000 y 18010.
No hay Coolify ni proxy inverso instalados, y los puertos 80 y 443 están
libres. Cada decisión de abajo se tomó respetando que nada de lo que
hagamos puede afectar a esos proyectos.

## Decisión

### 1. Compose a mano, no Coolify

El despliegue es `infra/docker/compose.server.yml` más `scripts/deploy.sh`,
con nombre de proyecto explícito (`orquestacion`), límites de memoria y
puertos verificados contra los ocupados.

**Por qué.** Coolify es una plataforma que se instala en el servidor, no un
paquete más: trae su propio proxy inverso y toma puertos (el 8000 ya lo usa
`tango-agent-api`; los 80/443 quedarían bajo su control). Instalarlo en una
máquina compartida para validar un mecanismo de despliegue es alterar el
entorno de otros proyectos por un objetivo que no lo necesita. Compose a mano
es lo mismo que ya usan sus vecinos, se puede leer entero en un archivo y se
borra con un comando.

**Efecto sobre `CLAUDE.md` §3.** La fila de infraestructura deja de decir
Coolify y pasa a "Docker Compose a mano en Ubuntu, ver ADR-014". Se decidió
así porque hoy no hay otro ambiente: si más adelante se adopta Coolify para un
ambiente propio, esa fila y este ADR se revisan juntos.

**Qué haría cambiarla.** Un servidor dedicado a este proyecto; necesitar más
de un ambiente (staging y producción) con despliegues desde la interfaz;
necesitar TLS automático con dominios propios (ver 4), que Coolify resuelve
y hoy hacemos a mano; o que mantener `deploy.sh` empiece a costar más que
adoptar la plataforma.

### 2. Build en el servidor, no imágenes construidas en CI

`deploy.sh` corre `docker compose build` en el servidor y etiqueta la imagen
con el SHA del commit. `/health` devuelve ese mismo SHA (`GIT_COMMIT`).

**Por qué.** No existe ningún registry ni CI que publique imágenes; agregarlos
es infraestructura y secretos nuevos (credenciales de push, de pull, retención)
para un único servidor. Construir donde se despliega mantiene un solo hecho
verificable: la imagen sale del commit checkouteado, y `deploy.sh` se niega a
correr con el árbol sucio para que esa afirmación sea cierta.

**Costos aceptados.** El build gasta CPU y memoria de un servidor compartido.
Depende de la red (registro de npm y Docker Hub) en cada deploy. Volver a un
commit anterior implica reconstruirlo, no bajar una imagen ya probada.

**Qué haría cambiarla.** Un segundo ambiente que deba correr *exactamente* la
imagen que pasó en el primero; que el build empiece a afectar a los otros
proyectos del servidor; necesitar rollback rápido sin reconstruir; o
exigencias de cadena de suministro (imágenes firmadas, escaneo). El destino
sería que CI construya y publique en un registry (por ejemplo GHCR) y el
servidor haga `pull` por digest.

### 3. Migraciones como contenedor efímero con `app_owner`

Las migraciones son el paso 4 de `deploy.sh`: `compose run --rm migrate`, un
contenedor de la misma imagen que la API, sin servicio permanente
(`profiles: [ops]`), que es el único que recibe las credenciales de
`app_owner`. La API arranca después y nunca migra.

**Por qué.**
- Regla dura 4: la aplicación no usa el rol dueño del esquema. Si la API
  migrara al arrancar necesitaría esas credenciales en su entorno.
- Regla dura 7 y convención `NOT VALID`/`VALIDATE` (`CLAUDE.md` §6): el
  migrador de Drizzle envuelve todas las migraciones pendientes en una sola
  transacción, así que qué migraciones corren juntas es una decisión de
  despliegue, no un efecto de arrancar el contenedor.
- Migrar antes de reiniciar y con `set -e` significa que una migración rota
  deja corriendo la versión anterior de la API en vez de dejar el servicio caído.
- Misma imagen que la API: las migraciones que corren son las del código que
  se va a arrancar.

**Costo.** Entre el paso 4 y el 5 la API vieja corre contra el esquema nuevo.
Por eso cada migración tiene que ser compatible hacia atrás con el código
anterior — que es exactamente lo que la regla dura 7 ya exige.

**Qué haría cambiarla.** Varias réplicas de la API o un requisito de cero
downtime (habría que orquestar el orden entre réplicas); o migraciones lo
bastante largas como para necesitar un pipeline propio, con ventana y
reintentos, en vez de un paso del deploy.

### 4. HTTP sin TLS solo mientras el servidor esté en la red local

`BETTER_AUTH_URL` es `http://192.168.0.105:18020`. Verificado en
`better-auth@1.7.5` (`dist/cookies/index.mjs:23`): con `baseURL` como string,
`Secure` depende únicamente de que empiece con `https://`; `NODE_ENV` no
interviene. Con `http://` las cookies salen sin `Secure` y la sesión persiste.
La prueba de humo lo comprueba.

**Por qué.** El servidor es de la LAN y los datos son de demo. TLS requiere un
dominio, un certificado y un proxy que termine TLS; nada de eso existe en el
servidor, y montarlo (puertos 80/443) es otra intervención sobre un entorno
compartido que esta pasada no necesita para validar el mecanismo.

**Riesgo aceptado.** Contraseñas y cookies de sesión viajan sin cifrar por la
LAN. Solo es aceptable con datos ficticios y sin exponer el puerto fuera de la
red local.

**Qué haría cambiarla.** Cualquiera de estas condiciones, que son bloqueantes
y están en `docs/phase-2-brief.md`: exponer el servidor a internet, cargar
datos de un piloto, o usar un cliente que rechace `http://` (la app móvil en
iOS). El cambio es `BETTER_AUTH_URL` en `https://` con TLS de punta a punta
(las cookies pasan a `Secure` solas), no un ajuste de la aplicación.

### 5. Solo se despliega lo que está en `main`

`deploy.sh` exige estar en `main`, sincronizado con `origin/main` y con el
árbol limpio, sin flag para saltearlo. La primera puesta en marcha del
mecanismo desplegó la rama del PR sin revisar, como excepción necesaria para
poder probarlo; de ahí en adelante el servidor corre únicamente lo mergeado.

## Consecuencias

- Coolify deja de ser el destino declarado en `CLAUDE.md` §3. Si un ambiente
  propio lo justifica (ver "Qué haría cambiarla" en 1), se revisa esa fila junto
  con este ADR.
- Ninguna variable de storage existe todavía; el slice de adjuntos las agrega
  junto con MinIO en el compose (ver el brief).
- Antes de exponer el servidor a internet o cargar datos de un piloto faltan
  dos cosas, registradas como bloqueantes en `docs/phase-2-brief.md`: TLS y
  backups de Postgres con una prueba de restore documentada.
