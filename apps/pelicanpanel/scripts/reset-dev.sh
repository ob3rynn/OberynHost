#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

cd "${APP_DIR}"

cleanup_image="ghcr.io/pelican-dev/panel:v1.0.0-beta33"
if [[ -f .env ]]; then
  cleanup_image="$(grep '^PELICAN_IMAGE=' .env | cut -d= -f2- || true)"
fi
if [[ -z "${cleanup_image}" ]]; then
  cleanup_image="ghcr.io/pelican-dev/panel:v1.0.0-beta33"
fi

echo "Stopping Pelican local dev stack (non-destructive stop first)..."
docker compose down --remove-orphans

echo
echo "This will permanently destroy:"
echo "- the MariaDB named volume"
echo "- generated runtime state under .data/storage"
echo "- generated runtime logs under .data/logs/panel"
echo
echo "This will keep:"
echo "- .env"
echo "- docker-compose.yml"
echo "- .env.example"
echo "- README.md"
echo "- docs/"
echo "- the scaffold directories and .gitkeep files"
echo
read -r -p "Type RESET-PELICAN-DEV to continue: " confirmation

if [[ "${confirmation}" != "RESET-PELICAN-DEV" ]]; then
  echo "Reset cancelled."
  exit 1
fi

echo "Removing containers and volumes..."
docker compose down --volumes --remove-orphans

echo "Clearing generated runtime state..."
docker run --rm --user 0:0 --entrypoint sh -v "${APP_DIR}/.data/storage:/target" "${cleanup_image}" \
  -ec 'find /target -mindepth 1 -delete'
docker run --rm --user 0:0 --entrypoint sh -v "${APP_DIR}/.data/logs/panel:/target" "${cleanup_image}" \
  -ec 'find /target -mindepth 1 -delete'

echo "Recreating scaffold..."
mkdir -p .data/logs/panel .data/storage
touch .data/.gitkeep .data/logs/.gitkeep .data/logs/panel/.gitkeep .data/storage/.gitkeep

echo "Pelican local dev stack reset complete."
