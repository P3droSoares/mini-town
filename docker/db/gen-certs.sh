#!/bin/sh
# Gera (uma vez) a CA e o certificado TLS do Postgres de desenvolvimento.
# Copiado para a imagem (docker/db/Dockerfile) e rodado pelo serviço certs.
#   /certs  -> server.crt + server.key (dono postgres, 0600)  [volume pg-certs]
#   /ca     -> ca.crt (público, lido pelo server: verify-full) [volume pg-ca]
# A chave da CA é descartada; perto de expirar, tudo é recriado.
set -eu

CERTS=/certs
CA=/ca

command -v openssl >/dev/null 2>&1 || { echo "[certs] ERRO: openssl ausente na imagem" >&2; exit 1; }

if [ -s "$CERTS/server.crt" ] && [ -s "$CERTS/server.key" ] && [ -s "$CA/ca.crt" ] \
  && openssl x509 -checkend 2592000 -noout -in "$CERTS/server.crt" >/dev/null \
  && openssl verify -CAfile "$CA/ca.crt" "$CERTS/server.crt" >/dev/null 2>&1; then
  echo "[certs] certificados do Postgres válidos — mantidos"
  exit 0
fi

umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

openssl req -x509 -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 -sha256 \
  -keyout "$tmp/ca.key" -out "$tmp/ca.crt" -days 3650 \
  -subj "/CN=Mini Town Dev Postgres CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

openssl req -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 -sha256 \
  -keyout "$tmp/server.key" -out "$tmp/server.csr" -subj "/CN=db" 2>/dev/null

# hostname "db" (rede do compose) precisa estar no SAN para verify-full
cat > "$tmp/ext" <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:db,DNS:localhost
EXT

openssl x509 -req -sha256 -days 825 -in "$tmp/server.csr" \
  -CA "$tmp/ca.crt" -CAkey "$tmp/ca.key" -CAcreateserial \
  -extfile "$tmp/ext" -out "$tmp/server.crt" 2>/dev/null

install -o postgres -g postgres -m 600 "$tmp/server.key" "$CERTS/server.key"
install -o postgres -g postgres -m 644 "$tmp/server.crt" "$CERTS/server.crt"
install -m 644 "$tmp/ca.crt" "$CA/ca.crt"
echo "[certs] CA e certificado do Postgres gerados (CN=db)"
