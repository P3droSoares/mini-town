#!/bin/sh
# Backup lógico do banco (pg_dump -Fc) pelo papel só-leitura minitown_backup,
# com TLS verify-full (PG* do ambiente). Retenção: 7 diários + 4 semanais.
#   pg-backup.sh          laço: confere a cada hora, faz backup se o último
#                         diário tiver mais que BACKUP_INTERVAL_HOURS (24)
#   pg-backup.sh once     um backup agora (smoke test / antes de mexer no banco)
# Saída: $BACKUP_DIR/{daily,weekly}/minitown-<UTC>.dump + .sha256
set -eu

OUT="${BACKUP_DIR:-/backups}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
INTERVAL_H="${BACKUP_INTERVAL_HOURS:-24}"
DB="${PGDATABASE:-minitown}"

log() { echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# remove os mais antigos além de $2 em $1 (nome tem timestamp: ordem = idade)
prune() {
  ls -1 "$1"/minitown-*.dump 2>/dev/null | sort -r | tail -n +"$(($2 + 1))" | while read -r old; do
    rm -f "$old" "$old.sha256"
    log "removido $(basename "$old") (retenção)"
  done
}

backup_once() {
  mkdir -p "$OUT/daily" "$OUT/weekly" || return 1
  name="minitown-$(date -u +%Y%m%dT%H%M%SZ).dump"
  part="$OUT/daily/.$name.part"
  log "iniciando pg_dump de $DB"
  if ! pg_dump --format=custom --no-password --dbname="$DB" --file="$part"; then
    rm -f "$part"
    log "ERRO: pg_dump falhou"
    return 1
  fi
  # arquivo íntegro e legível pelo pg_restore antes de entrar na rotação
  if ! pg_restore --list "$part" >/dev/null; then
    rm -f "$part"
    log "ERRO: dump ilegível pelo pg_restore"
    return 1
  fi
  mv "$part" "$OUT/daily/$name" || return 1
  (cd "$OUT/daily" && sha256sum "$name" > "$name.sha256") || return 1
  log "ok: daily/$name ($(wc -c < "$OUT/daily/$name") bytes)"

  # semanal: cópia do diário se o último semanal tiver 7 dias ou mais
  if [ -z "$(find "$OUT/weekly" -name 'minitown-*.dump' -mtime -7 2>/dev/null)" ]; then
    cp "$OUT/daily/$name" "$OUT/weekly/$name"
    (cd "$OUT/weekly" && sha256sum "$name" > "$name.sha256")
    log "ok: weekly/$name"
  fi
  prune "$OUT/daily" "$KEEP_DAILY"
  prune "$OUT/weekly" "$KEEP_WEEKLY"
}

if [ "${1:-loop}" = "once" ]; then
  backup_once
  exit $?
fi

log "agendado: a cada ${INTERVAL_H} h; retenção ${KEEP_DAILY} diários / ${KEEP_WEEKLY} semanais"
while :; do
  recent=$(find "$OUT/daily" -name 'minitown-*.dump' -mmin "-$((INTERVAL_H * 60))" 2>/dev/null || true)
  if [ -z "$recent" ]; then
    # falha não derruba o laço: tenta de novo na próxima hora
    backup_once || log "nova tentativa em 1 h"
  fi
  sleep 3600 &
  wait $!
done
