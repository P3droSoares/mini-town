#!/usr/bin/env bash
# Cria os papéis minitown_owner/minitown_app no primeiro boot do Postgres.
# Montado em /docker-entrypoint-initdb.d; exige MINITOWN_OWNER_PASSWORD e
# MINITOWN_APP_PASSWORD no ambiente do serviço db.
set -euo pipefail

: "${MINITOWN_OWNER_PASSWORD:?defina MINITOWN_OWNER_PASSWORD}"
: "${MINITOWN_APP_PASSWORD:?defina MINITOWN_APP_PASSWORD}"
DB_NAME="${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname "$DB_NAME" \
  -v owner_pw="$MINITOWN_OWNER_PASSWORD" \
  -v app_pw="$MINITOWN_APP_PASSWORD" \
  -v db="$DB_NAME" \
  -f /docker-entrypoint-initdb.d/roles.psql
