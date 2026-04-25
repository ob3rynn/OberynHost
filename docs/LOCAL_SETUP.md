# Local Setup

## Supported local environment
The supported storefront development environment is:

- WSL shell
- repo checked out on the Linux filesystem, for example `~/OberynHost`
- Docker Engine with `docker compose`

Unsupported storefront local setup:

- repo on a mounted Windows filesystem instead of the native Linux filesystem
- host `node`, host `npm`, or any Windows-side Node/npm fallback

## First-time setup

From WSL:

```bash
cd ~/OberynHost
bash scripts/setup-git.sh
cp apps/storefront/backend/.env.example apps/storefront/backend/.env
```

Then edit `apps/storefront/backend/.env` for the environment you are testing.

## Storefront commands

The supported storefront command surface is:

```bash
cd ~/OberynHost
bash scripts/storefront-docker.sh help
```

Common commands:

```bash
bash scripts/storefront-docker.sh up
bash scripts/storefront-docker.sh dev
bash scripts/storefront-docker.sh dev:stripe
bash scripts/storefront-docker.sh test
bash scripts/storefront-docker.sh down
```

What they do:

- `up` starts the production-like runtime container
- `dev` starts the plain backend dev container
- `dev:stripe` starts the listener-backed dev container
- `test` runs storefront unit tests inside Docker
- `down` stops the storefront Docker stack without deleting named volumes

See [apps/storefront/README.md](../apps/storefront/README.md) for the full service and volume model.

## Docker-only Stripe workflow

Authenticate Stripe CLI inside Docker once:

```bash
cd ~/OberynHost
bash scripts/storefront-docker.sh stripe:login
```

Run the live Stripe drills from Docker:

```bash
bash scripts/storefront-docker.sh stripe:live
bash scripts/storefront-docker.sh stripe:abuse
bash scripts/storefront-docker.sh stripe:ops
```

These commands keep Stripe CLI, Playwright, and the backend inside Docker. No host Node/npm or host Stripe CLI install is part of the supported path.

## Read-only audits

For production-adjacent diagnostics that must not change app state, run:

```bash
bash scripts/run-read-only-audits.sh
bash scripts/run-update-review.sh
```

Those wrappers now call the storefront Docker workflow directly. For guardrails and reporting rules, see [docs/CODEX_READ_ONLY_AUDITS.md](./CODEX_READ_ONLY_AUDITS.md).

## Phase-1 operator checklist

Before launch or production-adjacent smoke testing, use [docs/PHASE1_OPERATOR_RUNBOOK.md](./PHASE1_OPERATOR_RUNBOOK.md). It covers required Stripe, Postmark, and Pelican inputs; the native-Linux workflow for WSL dev or the Ubuntu production VM; routing verification; admin release; and the current no-destructive-purge boundary.
