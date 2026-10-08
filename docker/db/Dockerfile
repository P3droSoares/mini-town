# Imagem do Postgres de desenvolvimento (serviços certs, db e backup).
# Base fixada por digest (postgres:17, índice multi-arquitetura, 2026-10-07):
# atualizar = trocar o digest de propósito, nunca seguir a tag móvel.
FROM postgres:17@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3

# gen-certs.sh precisa do binário openssl (vem com postgresql-common/ssl-cert;
# a checagem garante caso a imagem base deixe de trazê-lo)
RUN set -eux; \
    if ! command -v openssl >/dev/null 2>&1; then \
      apt-get update; \
      apt-get install -y --no-install-recommends openssl; \
      rm -rf /var/lib/apt/lists/*; \
    fi; \
    openssl version

COPY --chmod=755 docker/db/gen-certs.sh /usr/local/bin/gen-certs.sh
COPY --chmod=755 docker/backup/pg-backup.sh /usr/local/bin/pg-backup.sh
