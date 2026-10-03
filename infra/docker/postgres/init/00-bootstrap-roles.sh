#!/bin/sh
# Corre una sola vez, la primera vez que se crea el volumen de datos
# (mecanismo estándar de docker-entrypoint-initdb.d de la imagen oficial de
# Postgres). Las contraseñas llegan por variable de entorno del propio
# contenedor y las lee ensure-roles.sql con \getenv de psql: nunca pasan por
# la línea de comando ni por una sustitución de texto, así que su contenido
# (barras, comillas, &) no importa.
set -eu

# Falla fuerte, no en silencio: un password vacío dejaría a un rol sin poder
# conectarse y nadie se enteraría hasta que arrancara algo. ensure-roles.sql
# también lo comprueba; esto da el mensaje antes y con el contexto del init.
: "${APP_OWNER_PASSWORD:?Falta APP_OWNER_PASSWORD}"
: "${APP_LOGIN_PASSWORD:?Falta APP_LOGIN_PASSWORD}"
: "${APP_WORKER_PASSWORD:?Falta APP_WORKER_PASSWORD (ADR-017: usuario de base de los workers)}"

# Orden: los roles primero, el dueño del esquema después (necesita app_owner).
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -f /bootstrap-sql/ensure-roles.sql \
  -f /bootstrap-sql/bootstrap-roles.sql
