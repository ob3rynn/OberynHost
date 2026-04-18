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

## Starting the storefront backend

From the repo root:

```bash
source "$HOME/.nvm/nvm.sh"
bash scripts/setup-node.sh
cd apps/storefront/backend
npm install
npm run dev
```

`npm run dev` now starts both the local Stripe listener and the storefront backend server for checkout testing.
It reads `BASE_URL` from `apps/storefront/backend/.env`, forwards Stripe webhooks to `/api/stripe/webhook`, captures the temporary `whsec_...` secret from the Stripe CLI, and injects it into the backend process automatically.

Requirements:

- Stripe CLI must be installed and logged in
- `BASE_URL` in `apps/storefront/backend/.env` must match the URL you are testing, such as `http://localhost:3000`

If you want the backend without Stripe forwarding, use:

```bash
cd apps/storefront/backend
npm run dev:server
```

## Live Stripe testing

Once `npm run dev` is running, the repo includes local Stripe sandbox scripts:

```bash
cd apps/storefront/backend
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

The repo also includes a repeatable live ops suite that runs the most important post-checkout drills in the right environment order:

```bash
cd apps/storefront/backend
npm run test:stripe:ops:all
```

What it covers:

- webhook outage followed by admin reconcile
- real mobile checkout and setup flow
- failed renewal / grace / suspension / purge policy evaluation
- checkout session expiry releasing inventory
- cancellation at period end syncing to the admin/runtime view

This suite intentionally restarts the backend between backend-only mode and listener-backed dev mode so you do not have to run those scenarios by hand.

## Read-only audits

For production-adjacent diagnostics that must not change app state, run:

```bash
bash scripts/run-read-only-audits.sh
```

That wrapper loads the repo's Node runtime and executes the storefront backend read-only audit suite. For guardrails and reporting rules, see [docs/CODEX_READ_ONLY_AUDITS.md](./CODEX_READ_ONLY_AUDITS.md).

## Why this exists

On this machine, `npm` may be visible before `node`, which can make the repo feel broken even though the correct Node version is already installed under `nvm`.

`scripts/setup-node.sh` makes that mismatch obvious and switches the shell to the repo's expected Node version when `nvm` is available.
