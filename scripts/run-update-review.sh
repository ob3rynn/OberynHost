#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== READ-ONLY AUDIT ==="
bash "${repo_root}/scripts/storefront-docker.sh" audit:read-only || true
echo
echo "=== AVAILABLE UPDATES ==="
bash "${repo_root}/scripts/storefront-docker.sh" audit:updates
echo
echo "=== CODEX NEXT STEP ==="
echo "Browse official changelogs/release notes for each available update, then answer using docs/CODEX_UPDATE_RECOMMENDATION_TEMPLATE.md"
