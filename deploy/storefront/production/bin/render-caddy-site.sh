#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-/etc/oberyn/storefront/storefront.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Env file not found: ${ENV_FILE}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

if [[ -z "${BASE_URL:-}" ]]; then
  echo "BASE_URL must be set in ${ENV_FILE}" >&2
  exit 1
fi

if [[ -z "${STOREFRONT_HOST_PORT:-}" ]]; then
  echo "STOREFRONT_HOST_PORT must be set in ${ENV_FILE}" >&2
  exit 1
fi

if ! [[ "${STOREFRONT_HOST_PORT}" =~ ^[0-9]+$ ]]; then
  echo "STOREFRONT_HOST_PORT must be numeric: ${STOREFRONT_HOST_PORT}" >&2
  exit 1
fi

storefront_site="${BASE_URL#*://}"
storefront_site="${storefront_site%%/*}"

if [[ -z "${storefront_site}" ]]; then
  echo "Could not derive a storefront host from BASE_URL=${BASE_URL}" >&2
  exit 1
fi

cat <<EOF
# Generated from ${ENV_FILE}.
# Re-render this file after changing BASE_URL or STOREFRONT_HOST_PORT.
${storefront_site} {
    encode zstd gzip

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    reverse_proxy 127.0.0.1:${STOREFRONT_HOST_PORT}
}
EOF
