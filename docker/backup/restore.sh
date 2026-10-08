#!/usr/bin/env bash
# Restaura um dump do serviço backup (pg_dump -Fc) no banco do compose.
#   bash docker/backup/restore.sh backups/daily/minitown-<UTC>.dump [--yes]
# Passos: confere sha256 e legibilidade; para a API; faz um dump de segurança
# do banco atual em backups/pre-restore/; recria o banco a partir do arquivo
# (pg_restore --create como superusuário, pelo socket local do container db);
# sobe migrate + server de novo. Gatilhos do razão não disparam no restore:
# o pg_restore carrega os dados antes de criar triggers e constraints.
set -euo pipefail

cd "$(dirname "$0")/../.."
file="${1:-}"
assume_yes="${2:-}"
[ -n "$file" ] && [ -f "$file" ] || { echo "uso: $0 <arquivo.dump> [--yes]" >&2; exit 2; }

if [ -f "$file.sha256" ]; then
  want=$(cut -d' ' -f1 < "$file.sha256")
  have=$(sha256sum "$file" | cut -d' ' -f1)
  [ "$want" = "$have" ] || { echo "sha256 não confere: $file" >&2; exit 1; }
  echo "sha256 ok"
fi

# psql/pg_restore como postgres pelo socket local (único caminho do superusuário)
dbx() { docker compose exec -T db sh -c "PGPASSWORD=\"\$POSTGRES_PASSWORD\" $1"; }

db_name=$(docker compose exec -T db sh -c 'printf %s "$POSTGRES_DB"')
[[ "$db_name" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "nome de banco inesperado: $db_name" >&2; exit 1; }
dbx "pg_restore --list" < "$file" > /dev/null || { echo "arquivo ilegível pelo pg_restore" >&2; exit 1; }

if [ "$assume_yes" != "--yes" ]; then
  echo "Isto APAGA o banco '$db_name' atual e o substitui por $file."
  read -r -p "Digite o nome do banco para confirmar: " answer
  [ "$answer" = "$db_name" ] || { echo "cancelado"; exit 1; }
fi

docker compose stop server
mkdir -p backups/pre-restore
safety="backups/pre-restore/minitown-$(date -u +%Y%m%dT%H%M%SZ).dump"
dbx "pg_dump -U postgres --format=custom --dbname=$db_name" > "$safety"
echo "dump de segurança do banco atual: $safety"

dbx "psql -U postgres -d postgres -v ON_ERROR_STOP=1 --no-psqlrc -c 'DROP DATABASE IF EXISTS $db_name WITH (FORCE)'"
dbx "pg_restore -U postgres --dbname=postgres --create --exit-on-error" < "$file"
echo "banco restaurado; conferindo dono e permissões:"
dbx "psql -U postgres -d $db_name --no-psqlrc -c '\\l $db_name' -c '\\dn+ public'"

# migrate reaplica o que faltar (dump antigo) e o server volta só com o papel app
docker compose up -d migrate server
echo "restauração concluída"
