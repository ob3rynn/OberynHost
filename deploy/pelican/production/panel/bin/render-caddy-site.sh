#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-/etc/oberyn/pelican/panel.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Env file not found: ${ENV_FILE}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

if [[ -z "${APP_URL:-}" ]]; then
  echo "APP_URL must be set in ${ENV_FILE}" >&2
  exit 1
fi

if [[ -z "${PANEL_HOST_PORT:-}" ]]; then
  echo "PANEL_HOST_PORT must be set in ${ENV_FILE}" >&2
  exit 1
fi

if ! [[ "${PANEL_HOST_PORT}" =~ ^[0-9]+$ ]]; then
  echo "PANEL_HOST_PORT must be numeric: ${PANEL_HOST_PORT}" >&2
  exit 1
fi

panel_site="${APP_URL#*://}"
panel_site="${panel_site%%/*}"

if [[ -z "${panel_site}" ]]; then
  echo "Could not derive a panel host from APP_URL=${APP_URL}" >&2
  exit 1
fi

cat <<EOF
# Generated from ${ENV_FILE}.
# Re-render this file after changing APP_URL or PANEL_HOST_PORT.
${panel_site} {
    encode zstd gzip

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    reverse_proxy 127.0.0.1:${PANEL_HOST_PORT}
}
EOF
