# Front (Vite dev + HMR). src/, public/ e os arquivos de config entram por
# bind mount só-leitura em /app (nunca a raiz: .env e server/ ficam de fora);
# a imagem só pré-instala node_modules (Linux) que o volume nomeado herda.
# node:22-bookworm-slim fixada por digest (índice multi-arquitetura, 2026-10-07)
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

ENV NODE_ENV=development \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    DOCKER=1

COPY --chmod=755 docker/node-entrypoint.sh /usr/local/bin/node-entrypoint.sh

WORKDIR /app
RUN chown node:node /app
USER node

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit \
 && sha256sum package-lock.json | cut -d' ' -f1 > node_modules/.lock-sha256

EXPOSE 5173
ENTRYPOINT ["node-entrypoint.sh"]
CMD ["npm", "run", "dev"]
