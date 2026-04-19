# Resetting the Pelican Local Dev Stack

Use [`../scripts/reset-dev.sh`](../scripts/reset-dev.sh) when you need to return this local dev stack to a fresh first-boot state.

## What Reset Destroys

- the MariaDB named volume `pelicanpanel-mariadb-data`
- generated Pelican runtime state under [`../.data/storage`](../.data/storage)
- generated logs under [`../.data/logs/panel`](../.data/logs/panel)

That means the next `docker compose up -d` behaves like a fresh first boot and `panel-init` will run again.

## What Reset Leaves Alone

- [`../.env.example`](../.env.example)
- your local untracked `.env`
- [`../docker-compose.yml`](../docker-compose.yml)
- [`../README.md`](../README.md)
- [`./updating.md`](./updating.md)
- the scaffold directories and `.gitkeep` files

## How This Differs from `docker compose down`

`docker compose down` only stops and removes the containers and network for this stack. It does not destroy the MariaDB volume and it does not clear the writable runtime data under `.data/`.

The reset script is the authoritative destructive reset path.

The script intentionally uses the pinned Pelican image as the cleanup container. That keeps reset self-service for container-owned files under `.data/` without requiring host `sudo` or a second helper image.

## Confirmation Text

The script requires this exact confirmation string:

```text
RESET-PELICAN-DEV
```

## When to Use It

Use the reset script when you want to:

- re-run first boot from scratch
- throw away local test data
- validate that init still works on a clean instance
- recover from a bad local state that is easier to rebuild than debug
