#!/usr/bin/env bash

set -euo pipefail

workspace_root="${STOREFRONT_WORKSPACE:-/workspace/apps/storefront}"
backend_dir="${workspace_root}/backend"
lockfile="${backend_dir}/package-lock.json"
node_modules_dir="${backend_dir}/node_modules"
seed_node_modules_dir="/opt/storefront/backend/node_modules"
hash_file="${node_modules_dir}/.package-lock.sha256"

if [[ ! -f "$lockfile" ]]; then
    echo "Could not find ${lockfile}. Mount the WSL storefront checkout into ${workspace_root}." >&2
    exit 1
fi

mkdir -p "$node_modules_dir"
current_hash="$(sha256sum "$lockfile" | awk '{print $1}')"
existing_hash=""

if [[ -f "$hash_file" ]]; then
    existing_hash="$(tr -d '[:space:]' < "$hash_file")"
fi

if [[ -z "$(find "$node_modules_dir" -mindepth 1 -print -quit 2>/dev/null)" ]]; then
    echo "Seeding Docker-managed backend/node_modules from the devtools image..."
    cp -a "${seed_node_modules_dir}/." "$node_modules_dir/"
    printf '%s\n' "$current_hash" > "$hash_file"
    existing_hash="$current_hash"
fi

if [[ ! -x "${node_modules_dir}/.bin/playwright" || "$existing_hash" != "$current_hash" ]]; then
    echo "Syncing backend/node_modules with package-lock.json inside Docker..."
    (
        cd "$backend_dir"
        npm ci --build-from-source
    )
    printf '%s\n' "$current_hash" > "$hash_file"
fi

cd "$backend_dir"
exec "$@"
