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

## Live Stripe testing

Once `npm run dev` is running, the repo now includes two local Stripe sandbox scripts:

```bash
cd backend
npm run test:stripe:install
npm run test:stripe:live
npm run test:stripe:abuse
```

What they do:

- `npm run test:stripe:install`
  Installs the Chromium browser that Playwright uses for the local Stripe flow.
- `npm run test:stripe:live`
  Runs a real sandbox subscription checkout, returns to `/success`, submits server details, and prints the resulting purchase/subscription state.
- `npm run test:stripe:abuse`
  Tries confusing customer behavior against the live sandbox flow, including abandoned checkout setup attempts, resume conflicts, parallel tabs, double-submit setup, and success-page access without the original browser cookie.

The Stripe form is filled with the current sandbox card data baked into the test harness:

- Email: `stripe@test.com`
- Card: `4242 4242 4242 4242`
- Expiry: `09 / 29`
- CVC: `000`
- Name: `autotest`
- Country: `United States`
- ZIP: `99999`

## Why this exists

On this machine, `npm` may be visible before `node`, which can make the repo feel broken even though the correct Node version is already installed under `nvm`.

`scripts/setup-node.sh` makes that mismatch obvious and switches the shell to the repo's expected Node version when `nvm` is available.
