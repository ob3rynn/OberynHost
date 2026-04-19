# Storefront Docker Workflow

## Supported workspace
The supported storefront workflow is:

- run from a WSL shell
- keep the repo on the Linux filesystem, for example `~/OberynHost`
- use Docker for runtime, dev, audits, tests, and Stripe drills

Unsupported storefront workflow:

- checking the repo out on a mounted Windows filesystem instead of the native Linux filesystem
- relying on Windows-side shells or language tooling
- installing or using host `backend/node_modules`

The storefront wrapper script enforces this by resolving POSIX paths and refusing to run from a Windows-mounted checkout.

## What runs in Docker
The storefront is still one Express app that serves both the API and the committed static frontend. The Docker workflow now exposes that app through three services:

- `storefront`
  The production-like runtime container. It uses the `runtime` image target and a dedicated SQLite volume.
- `storefront-dev`
  The plain backend development container. It uses the `devtools` image target, mounts the storefront source tree from the Linux checkout, and runs the backend watch server inside Docker.
- `storefront-stripe-dev`
  The listener-backed development container. It uses the same `devtools` image target and runs the Stripe helper plus backend inside the same container.

The `devtools` image includes:

- Node 20
- build tools for native modules
- devDependencies
- Playwright Chromium and its runtime dependencies
- Stripe CLI

The supported dependency model is:

- runtime image owns production dependencies
- devtools image seeds a Docker-managed `backend/node_modules` volume
- the host checkout does not own storefront dependencies

## Volumes and persistence
The workflow uses named Docker volumes for the parts that must live outside the containers:

- `storefront_data`
  Runtime SQLite data for the production-like `storefront` service.
- `storefront_dev_data`
  SQLite data for `storefront-dev` and `storefront-stripe-dev`.
- `storefront_backend_node_modules`
  Docker-managed backend dependencies for the mounted storefront source tree.
- `storefront_stripe_config`
  Stripe CLI authentication state used by Docker-only Stripe workflows.

Runtime persistence contract:

- `storefront` uses `DATABASE_PATH=/var/lib/oberynhost/storefront/storefront.sqlite3`
- dev services use `DATABASE_PATH=/workspace/state/storefront.sqlite3`
- logs stay on stdout/stderr
- admin sessions and in-memory rate limiting remain ephemeral across restart

## Environment contract
Required env values still live in [`backend/.env`](./backend/.env):

- `BASE_URL`
- `ADMIN_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_API_VERSION`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_2GB`
- `STRIPE_PRICE_4GB`

Optional runtime overrides:

- `PORT`
- `HOST`
- `ALLOWED_ORIGINS`
- `DATABASE_PATH`

Important Docker nuance:

- the production-like `storefront` service uses `backend/.env` as-is
- the dev services intentionally override `BASE_URL` and `ALLOWED_ORIGINS` to local Docker-safe values unless you set the `STOREFRONT_DEV_*` overrides in your shell

Create the env file once from WSL:

```bash
cd ~/OberynHost
cp apps/storefront/backend/.env.example apps/storefront/backend/.env
```

## Supported commands
Use the wrapper from the repo root:

```bash
cd ~/OberynHost
bash scripts/storefront-docker.sh help
```

Core runtime commands:

```bash
bash scripts/storefront-docker.sh up
bash scripts/storefront-docker.sh logs
bash scripts/storefront-docker.sh restart
bash scripts/storefront-docker.sh down
```

Development commands:

```bash
bash scripts/storefront-docker.sh dev
bash scripts/storefront-docker.sh dev:stripe
```

Unit tests and audits:

```bash
bash scripts/storefront-docker.sh test
bash scripts/storefront-docker.sh audit:config --json
bash scripts/storefront-docker.sh audit:runtime --json
bash scripts/storefront-docker.sh audit:read-only --json
bash scripts/storefront-docker.sh audit:updates --json
```

Stripe Docker workflow:

```bash
bash scripts/storefront-docker.sh stripe:login
bash scripts/storefront-docker.sh stripe:live
bash scripts/storefront-docker.sh stripe:abuse
bash scripts/storefront-docker.sh stripe:ops
```

How these behave:

- `dev` starts the plain backend dev container and publishes the app to `127.0.0.1:3000`
- `dev:stripe` starts the listener-backed dev container and publishes the app to `127.0.0.1:3000`
- `stripe:live` and `stripe:abuse` ensure `storefront-stripe-dev` is running, then execute the Playwright drill inside that container
- `stripe:ops` runs the full listener/backend lifecycle suite in a one-shot devtools container so it can manage its own internal processes cleanly

## Docker-only Stripe development
Local Stripe development is still intentionally separate from the production/container runtime contract:

- `storefront-stripe-dev` uses the development-only helper in [`backend/scripts/dev-with-stripe.js`](./backend/scripts/dev-with-stripe.js)
- the helper listens with Stripe CLI, captures a temporary webhook signing secret, and injects it into the backend process inside the container
- the production-like `storefront` service still requires a real injected `STRIPE_WEBHOOK_SECRET`

Run Docker-only Stripe auth first:

```bash
cd ~/OberynHost
bash scripts/storefront-docker.sh stripe:login
```

That auth state is stored in the `storefront_stripe_config` volume so the host does not need a Stripe CLI install.

## Manual validation path
Before CI is added, validate the storefront through Docker only:

- `bash scripts/storefront-docker.sh up`
- smoke-check `GET /`, `GET /pricing`, `GET /api/plans`
- verify bad webhook signatures return `400`
- restart the runtime container and verify SQLite persistence remains intact
- `bash scripts/storefront-docker.sh test`
- `bash scripts/storefront-docker.sh audit:config --json`
- `bash scripts/storefront-docker.sh audit:runtime --json`
- `bash scripts/storefront-docker.sh audit:read-only --json`
- `bash scripts/storefront-docker.sh audit:updates --json`
- `bash scripts/storefront-docker.sh stripe:live`
- `bash scripts/storefront-docker.sh stripe:abuse`
- `bash scripts/storefront-docker.sh stripe:ops`

Useful runtime smoke checks once `up` or `dev` is running:

```bash
curl -i http://127.0.0.1:3000/
curl -i http://127.0.0.1:3000/api/plans
curl -i http://127.0.0.1:3000/api/stripe/webhook \
  -H 'Content-Type: application/json' \
  -H 'Stripe-Signature: bad-signature' \
  -d '{}'
```

## Ready for CI
The storefront is ready for GitHub Actions image build/publish work when:

- the `runtime` and `devtools` Docker targets both build successfully
- all supported storefront commands work through `bash scripts/storefront-docker.sh ...`
- no supported storefront workflow requires host `node`, host `npm`, or Windows tooling
- the repo guidance consistently assumes a WSL/Linux checkout path
- runtime docs and Docker behavior agree on env rules, persistence, and Stripe handling
