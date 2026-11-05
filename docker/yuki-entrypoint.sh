#!/bin/sh
# Starts the Yuki service in its container. On the first start it makes the two keys the live
# mode needs and keeps them in the /keys volume, apart from the data: the key that seals saved
# secrets (TOKEN_ENCRYPTION_KEY) and the credential store's own key (CREDENTIAL_KEY_FILE).
# A key you set yourself in .env is left as it is.
set -eu
umask 077
if [ -z "${TOKEN_ENCRYPTION_KEY:-}" ]; then
  [ -s /keys/token.key ] || openssl rand -base64 32 > /keys/token.key
  TOKEN_ENCRYPTION_KEY="$(cat /keys/token.key)"
  export TOKEN_ENCRYPTION_KEY
fi
if [ -z "${CREDENTIAL_KEY_FILE:-}" ]; then
  [ -s /keys/credential.key ] || openssl rand -base64 32 > /keys/credential.key
  CREDENTIAL_KEY_FILE=/keys/credential.key
  export CREDENTIAL_KEY_FILE
fi
exec "$@"
