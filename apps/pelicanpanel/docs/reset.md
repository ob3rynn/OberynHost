# Resetting the Pelican Local Dev Stack

Use [scripts/reset-dev.sh](/home/oberynn/OberynHost/apps/pelicanpanel/scripts/reset-dev.sh) when you need to return this local dev stack to a fresh first-boot state.

## What Reset Destroys

- the MariaDB named volume `pelicanpanel-mariadb-data`
- generated Pelican runtime state under [apps/pelicanpanel/.data/storage](/home/oberynn/OberynHost/apps/pelicanpanel/.data/storage)
- generated logs under [apps/pelicanpanel/.data/logs/panel](/home/oberynn/OberynHost/apps/pelicanpanel/.data/logs/panel)

That means the next `docker compose up -d` behaves like a fresh first boot and `panel-init` will run again.

## What Reset Leaves Alone

- [apps/pelicanpanel/.env.example](/home/oberynn/OberynHost/apps/pelicanpanel/.env.example)
- your local untracked `.env`
- [apps/pelicanpanel/docker-compose.yml](/home/oberynn/OberynHost/apps/pelicanpanel/docker-compose.yml)
- [apps/pelicanpanel/README.md](/home/oberynn/OberynHost/apps/pelicanpanel/README.md)
- [apps/pelicanpanel/docs/updating.md](/home/oberynn/OberynHost/apps/pelicanpanel/docs/updating.md)
- the scaffold directories and `.gitkeep` files

## How This Differs from `docker compose down`

`docker compose down` only stops and removes the containers and network for this stack. It does not destroy the MariaDB volume and it does not clear the writable runtime data under `.data/`.

The reset script is the authoritative destructive reset path.

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
