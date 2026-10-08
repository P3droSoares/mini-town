#!/usr/bin/env bash
# Papel minitown_backup: só leitura (pg_read_all_data), usado pelo serviço
# backup para o pg_dump. Idempotente: roda no 1º boot do volume e pode ser
# reexecutado num volume antigo:
#   docker compose exec db bash /docker-entrypoint-initdb.d/20-backup-role.sh
set -euo pipefail

: "${MINITOWN_BACKUP_PASSWORD:?defina MINITOWN_BACKUP_PASSWORD}"
DB_NAME="${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"
export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"

psql -v ON_ERROR_STOP=1 --no-psqlrc --username "${POSTGRES_USER:-postgres}" --dbname "$DB_NAME" \
  -v backup_pw="$MINITOWN_BACKUP_PASSWORD" -v db="$DB_NAME" <<'SQL'
SET password_encryption = 'scram-sha-256';
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'minitown_backup') AS create_role \gset
\if :create_role
CREATE ROLE minitown_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
\endif
ALTER ROLE minitown_backup PASSWORD :'backup_pw';
-- leitura de todas as tabelas/sequências, nenhum privilégio de escrita
GRANT pg_read_all_data TO minitown_backup;
-- sessões do backup nunca escrevem nem seguram o banco
ALTER ROLE minitown_backup SET default_transaction_read_only = on;
ALTER ROLE minitown_backup SET idle_in_transaction_session_timeout = '10min';
GRANT CONNECT ON DATABASE :"db" TO minitown_backup;
SQL
echo "[init] papel minitown_backup pronto"
