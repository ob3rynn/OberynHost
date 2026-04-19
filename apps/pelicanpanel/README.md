LOCAL DEV ONLY. This folder is not the real production deployment path and not the Wings deployment path.

# Pelican Panel Local Dev Stack

This directory contains a locally bound, production-adjacent Pelican panel stack inside the `ob3rynn/OberynHost` repo. It is intentionally separate from `apps/storefront`, and it does not include Wings, host deployment files, or public DNS/proxy exposure. The goal is to mirror the real panel runtime shape as closely as practical while keeping it local-only.

## Prerequisites

- Docker Engine with Docker Compose available as `docker compose`
- Access to the pinned container images from GHCR and Docker Hub

## First-Time Setup

```bash
cd apps/pelicanpanel
cp .env.example .env
docker compose up -d
```

That is the intended bring-up flow. No extra bootstrap command is required.

On first boot:

- `panel-init` waits for MariaDB and Redis
- Pelican runtime state is created under `.data/storage/`
- `panel-init` syncs the bundled OberynHost plugin into `.data/storage/plugins/oberynhosttheme`
- database migrations and default seeds run
- one dev admin user is created from the `DEV_ADMIN_*` values in `.env`
- `APP_INSTALLED=true` is written into the runtime `.env` because this local path intentionally bypasses the web installer
- the OberynHost plugin is installed automatically if it is not already enabled
- a local init marker is written after the admin, plugin, and runtime flags are reconciled
- the long-running `panel` service starts only after init completes successfully

## Normal Startup

If the stack has already been initialized, start it the same way:

```bash
cd apps/pelicanpanel
docker compose up -d
```

`panel-init` is idempotent. It uses the database-backed admin account as the canonical signal that the local bootstrap data exists, and also keeps a local init marker under `.data/storage` so plugin sync and runtime-flag reconciliation are easier to reason about on later starts.

The `DEV_ADMIN_*` values are first-boot inputs, not an ongoing reconciliation API. After the admin account exists, changing those values in `.env` does not rewrite the account; use the panel itself for normal credential changes or run the destructive reset flow if you intentionally want a fresh install.

## Stop Behavior

Stop the stack without deleting data:

```bash
cd apps/pelicanpanel
docker compose down
```

`docker compose down` is intentionally non-destructive here. It preserves the MariaDB named volume and the writable runtime state under `.data/`.

## Local Access

- Panel URL: [http://localhost:8081](http://localhost:8081)
- MariaDB host access: `127.0.0.1:3307`
- Redis: internal only, no host port published
- Mail: intentionally uses Laravel's `log` mailer so mail-triggered flows stay local and observable without requiring a separate sink service

## What Persists

- MariaDB data persists in the named Docker volume `pelicanpanel-mariadb-data`
- Pelican writable runtime data persists in [`./.data/storage`](./.data/storage)
- Pelican runtime logs are written to [`./.data/logs/panel`](./.data/logs/panel)

The shared runtime tree under `.data/storage/` is expected to contain Pelican-managed state such as the runtime `.env`, storage files, plugins, and related writable data.

## Local Branding

This local dev stack now mirrors the production branding layer closely enough to validate the bundled OberynHost plugin:

- the plugin source comes from [`../../packages/pelican/oberynhost-theme`](../../packages/pelican/oberynhost-theme)
- `panel-init` syncs it into the runtime plugin directory when the bundled source changes
- `panel-init` installs it automatically when the plugin is not already enabled

If you perform a full destructive reset, the plugin is reseeded and reinstalled on the next `docker compose up -d`.
If you change the repo plugin source while this stack already exists, rerun `docker compose up -d --force-recreate panel-init panel` so the runtime copy and panel container are refreshed together.

## Local Config Surface

- Copy [`./.env.example`](./.env.example) to `.env` for local Compose settings
- Pelican maintains its own runtime `.env` inside `.data/storage/` at `/pelican-data/.env`
- Do not commit `apps/pelicanpanel/.env`
- `APP_ENV=production` and `APP_DEBUG=false` are intentional here: this local stack is meant to behave like a locally bound host deployment, not a loosened dev-mode variant
- `BEHIND_PROXY=true` is also intentional even locally because the upstream container uses that flag to keep its internal Caddy listener on port `80` while `APP_URL` still points at the externally bound host URL

## More Docs

- Reset instructions: [`./docs/reset.md`](./docs/reset.md)
- Image pin update flow: [`./docs/updating.md`](./docs/updating.md)
