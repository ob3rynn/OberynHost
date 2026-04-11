# Local Setup

This repo expects the Node version from `.nvmrc`.

## First-time setup

1. Load `nvm` in your shell.
2. Run the shared setup scripts.

```bash
source "$HOME/.nvm/nvm.sh"
bash scripts/setup-node.sh
bash scripts/setup-git.sh
```

## Starting the backend

From the repo root:

```bash
source "$HOME/.nvm/nvm.sh"
bash scripts/setup-node.sh
cd backend
npm install
npm run dev
```

## Why this exists

On this machine, `npm` may be visible before `node`, which can make the repo feel broken even though the correct Node version is already installed under `nvm`.

`scripts/setup-node.sh` makes that mismatch obvious and switches the shell to the repo's expected Node version when `nvm` is available.
