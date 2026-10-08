#!/bin/sh
# Entrypoint dos containers Node (web, server-deps, migrate, server).
# node_modules vive num volume nomeado; o SHA-256 do package-lock.json do bind
# mount é comparado com o do último install.
#   NODE_DEPS_INSTALL=1  reinstala se mudou (só em container SEM segredos:
#                        web e o one-shot server-deps);
#   ausente              só confere: desatualizado = não sobe (migrate e
#                        server têm credenciais e não instalam nada).
# O install usa --ignore-scripts: nenhum postinstall de dependência roda
# (o @node-rs/argon2 e o esbuild vêm em pacotes binários pré-compilados).
set -eu

lock=package-lock.json
mark=node_modules/.lock-sha256

if [ -f "$lock" ]; then
  want=$(sha256sum "$lock" | cut -d' ' -f1)
  have=$(cat "$mark" 2>/dev/null || true)
  if [ "$want" != "$have" ]; then
    if [ "${NODE_DEPS_INSTALL:-}" != "1" ]; then
      echo "[entrypoint] node_modules desatualizado em relação ao package-lock.json;" >&2
      echo "[entrypoint] rode 'docker compose up -d' (o server-deps reinstala antes)." >&2
      exit 1
    fi
    echo "[entrypoint] package-lock.json mudou: npm ci --ignore-scripts"
    # esvazia o volume (o ponto de montagem em si não pode ser removido)
    find node_modules -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    npm ci --ignore-scripts --no-audit --no-fund
    echo "$want" > "$mark"
  fi
fi

exec "$@"
