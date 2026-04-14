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

cd "${repo_root}/backend"
node scripts/audit-read-only.js "$@"
