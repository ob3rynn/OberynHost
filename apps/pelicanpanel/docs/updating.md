# Updating Image Pins

This local dev stack uses manually pinned image versions. Do not casually switch to moving tags such as `main` or `latest`.

Current pins live in [`../.env.example`](../.env.example):

- `PELICAN_IMAGE`
- `MARIADB_IMAGE`
- `REDIS_IMAGE`

## Why Pins Are Manual

- version changes should be intentional
- local bring-up and init behavior should be tested before commit
- known-good pins are easier to reason about than whatever `main` or `latest` happens to mean on a given day

## Expected Update Flow

1. Edit [`../.env.example`](../.env.example).
2. Refresh your local `.env` from the new example values.
3. Test locally with `docker compose up -d`.
4. Confirm `panel-init` behavior, runtime startup, and local access still work.
5. Commit the known-good pins in `.env.example`.

## Notes

- This directory is still local dev only.
- Updating these pins does not add Wings, production deployment logic, or storefront integration.
- If you change [`../../../packages/pelican/oberynhost-theme`](../../../packages/pelican/oberynhost-theme), rerun `docker compose up -d --force-recreate panel-init panel` so the local runtime plugin copy is refreshed and rechecked.
