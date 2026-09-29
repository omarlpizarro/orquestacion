#!/usr/bin/env bash
# `docker compose` contra el despliegue del server, con todo lo necesario ya
# fijado: archivo, env-file y GIT_COMMIT (el commit checkouteado ahora).
#
#   scripts/compose.sh ps
#   scripts/compose.sh logs -f api
#   scripts/compose.sh exec postgres psql -U postgres -d orquestacion
#
# Los pasos del deploy los orquesta scripts/deploy.sh; usá este wrapper para
# inspeccionar y para correr scripts operativos (ver README).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$repo_root/infra/docker/.env"

if [ ! -f "$env_file" ]; then
  echo "Falta $env_file. Copiá infra/docker/server.env.example y completalo." >&2
  exit 1
fi

GIT_COMMIT="$(git -C "$repo_root" rev-parse HEAD)"
export GIT_COMMIT

exec docker compose \
  -f "$repo_root/infra/docker/compose.server.yml" \
  --env-file "$env_file" \
  "$@"
