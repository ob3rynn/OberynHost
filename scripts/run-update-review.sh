#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
required_major="$(tr -d '[:space:]' < "${repo_root}/.nvmrc")"
nvm_dir="${NVM_DIR:-$HOME/.nvm}"
nvm_script="${nvm_dir}/nvm.sh"

if [[ -s "${nvm_script}" ]]; then
    # shellcheck disable=SC1090
    source "${nvm_script}"
    nvm use "${required_major}" >/dev/null
fi

cd "${repo_root}/apps/storefront/backend"

echo "=== READ-ONLY AUDIT ==="
node scripts/audit-read-only.js || true
echo
echo "=== AVAILABLE UPDATES ==="
node scripts/audit-updates.js
echo
echo "=== CODEX NEXT STEP ==="
echo "Browse official changelogs/release notes for each available update, then answer using docs/CODEX_UPDATE_RECOMMENDATION_TEMPLATE.md"
