LOCAL DEV ONLY. This folder is not the real production deployment path and not the Wings deployment path.

# Pelican Panel Local Dev Stack

This directory contains a standalone local development stack for the Pelican panel inside the `ob3rynn/OberynHost` repo. It is intentionally separate from `apps/storefront`, and it does not include Wings, host deployment files, reverse proxy setup, or any production host scaffolding.

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
- the bundled OberynHost plugin is seeded into `.data/storage/plugins/oberynhosttheme`
- database migrations and default seeds run
- one dev admin user is created from the `DEV_ADMIN_*` values in `.env`
- the OberynHost plugin is installed automatically if it is not already enabled
- the long-running `panel` service starts only after init completes successfully

## Normal Startup

If the stack has already been initialized, start it the same way:

```bash
cd apps/pelicanpanel
docker compose up -d
```

`panel-init` is idempotent. It checks for the configured admin email and exits cleanly once the local dev instance has already been initialized.

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

## What Persists

- MariaDB data persists in the named Docker volume `pelicanpanel-mariadb-data`
- Pelican writable runtime data persists in [apps/pelicanpanel/.data/storage](/home/oberynn/OberynHost/apps/pelicanpanel/.data/storage)
- Pelican runtime logs are written to [apps/pelicanpanel/.data/logs/panel](/home/oberynn/OberynHost/apps/pelicanpanel/.data/logs/panel)

The shared runtime tree under `.data/storage/` is expected to contain Pelican-managed state such as the runtime `.env`, storage files, plugins, and related writable data.

## Local Branding

This local dev stack now mirrors the production branding layer closely enough to validate the bundled OberynHost plugin:

- the plugin source comes from [packages/pelican/oberynhost-theme](/home/oberynn/OberynHost/packages/pelican/oberynhost-theme)
- `panel-init` seeds it into the runtime plugin directory on first boot
- `panel-init` installs it automatically when the plugin is not already enabled

If you perform a full destructive reset, the plugin is reseeded and reinstalled on the next `docker compose up -d`.

## Local Config Surface

- Copy [apps/pelicanpanel/.env.example](/home/oberynn/OberynHost/apps/pelicanpanel/.env.example) to `.env` for local Compose settings
- Pelican maintains its own runtime `.env` inside `.data/storage/` at `/pelican-data/.env`
- Do not commit `apps/pelicanpanel/.env`

## More Docs

- Reset instructions: [apps/pelicanpanel/docs/reset.md](/home/oberynn/OberynHost/apps/pelicanpanel/docs/reset.md)
- Image pin update flow: [apps/pelicanpanel/docs/updating.md](/home/oberynn/OberynHost/apps/pelicanpanel/docs/updating.md)
