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

`npm run dev` now starts both the local Stripe listener and the backend server for checkout testing.
It reads `BASE_URL` from `backend/.env`, forwards Stripe webhooks to `/api/stripe/webhook`, captures the temporary `whsec_...` secret from the Stripe CLI, and injects it into the backend process automatically.

Requirements:

- Stripe CLI must be installed and logged in
- `BASE_URL` in `backend/.env` must match the URL you are testing, such as `http://localhost:3000`

If you want the backend without Stripe forwarding, use:

```bash
cd backend
npm run dev:server
```

## Why this exists

On this machine, `npm` may be visible before `node`, which can make the repo feel broken even though the correct Node version is already installed under `nvm`.

`scripts/setup-node.sh` makes that mismatch obvious and switches the shell to the repo's expected Node version when `nvm` is available.
