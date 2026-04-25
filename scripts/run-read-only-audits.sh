#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "${repo_root}/scripts/check-phase1-operator-runbook.sh"

exec bash "${repo_root}/scripts/storefront-docker.sh" audit:read-only "$@"
