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
    echo "Using Node $(node -v) via nvm"
    echo "npm: $(command -v npm)"
    exit 0
fi

if [[ -x "/mnt/c/Program Files/nodejs/node.exe" ]]; then
    echo "nvm is not loaded in this shell."
    echo "Windows Node exists at /mnt/c/Program Files/nodejs/node.exe, but this repo is set up for the Linux nvm runtime."
    echo "Load nvm first or install the Node ${required_major} runtime in your Linux shell."
    exit 1
fi

echo "Could not find a usable Node runtime."
echo "Expected Node ${required_major} from .nvmrc."
echo "Install it with nvm, then rerun: source \"${nvm_script}\" && nvm install ${required_major}"
exit 1
