#!/bin/sh
# Corre una sola vez, la primera vez que se crea el volumen de datos
# (mecanismo estándar de docker-entrypoint-initdb.d de la imagen oficial de
# Postgres). Sustituye los placeholders de bootstrap-roles.sql con los
# passwords que vienen por variable de entorno del propio contenedor: el
# password nunca queda escrito en el repo.
set -eu

sed \
  -e "s/__APP_OWNER_PASSWORD__/${APP_OWNER_PASSWORD}/g" \
  -e "s/__APP_LOGIN_PASSWORD__/${APP_LOGIN_PASSWORD}/g" \
  /bootstrap-sql/bootstrap-roles.sql \
  | psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"
