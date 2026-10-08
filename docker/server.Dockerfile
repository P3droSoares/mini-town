# Back (Fastify via tsx watch) e one-shot migrate. Código em /app/server por
# bind mount; dados da cidade em /app/public/data (só-leitura); node_modules
# em volume nomeado.
# node:22-bookworm-slim fixada por digest (índice multi-arquitetura, 2026-10-07)
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

ENV NODE_ENV=development \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    CHOKIDAR_USEPOLLING=1

COPY --chmod=755 docker/node-entrypoint.sh /usr/local/bin/node-entrypoint.sh

WORKDIR /app/server
RUN chown -R node:node /app
USER node

COPY --chown=node:node server/package.json server/package-lock.json ./
# sem scripts de instalação (argon2/esbuild vêm em binários pré-compilados)
RUN npm ci --ignore-scripts --no-audit \
 && sha256sum package-lock.json | cut -d' ' -f1 > node_modules/.lock-sha256

EXPOSE 3000
ENTRYPOINT ["node-entrypoint.sh"]
CMD ["npm", "run", "dev"]
