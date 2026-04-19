# Production Panel Deployment

This directory prepares the public Pelican panel deployment for a real Ubuntu 24.04 VM while stopping short of any GitHub Actions or GHCR automation.

For the first real VM deployment, start with [`../FIRST_HOST_RUNBOOK.md`](../FIRST_HOST_RUNBOOK.md). Use this file as the panel-specific reference behind that linear runbook.

## Files

- [`./Dockerfile`](./Dockerfile): thin wrapper image over the pinned upstream Pelican image
- [`./docker-compose.yml`](./docker-compose.yml): production panel, MariaDB, and Redis stack
- [`./panel.env.example`](./panel.env.example): host-managed env contract
- [`./Caddyfile`](./Caddyfile): sample host Caddy site block
- [`./bin/entrypoint-wrapper.sh`](./bin/entrypoint-wrapper.sh): wrapper entrypoint that owns runtime bootstrap and bundled-plugin sync behavior
- [`./bin/render-caddy-site.sh`](./bin/render-caddy-site.sh): renders a host Caddy site block directly from `panel.env`

## Production Contract

- The public panel is served through host Caddy over HTTPS.
- The panel container itself only binds to `127.0.0.1:${PANEL_HOST_PORT}` on the VM.
- MariaDB and Redis stay internal-only and are not published publicly.
- Persistent runtime paths live outside the repo checkout under `/srv/oberyn/pelican/...`.
- Secrets live in a root-owned host env file such as `/etc/oberyn/pelican/panel.env`.

## Image Contract

- `PANEL_BASE_IMAGE` is the pinned upstream Pelican image that this repo extends.
- `PANEL_IMAGE` is the wrapper image reference the host is expected to run.
- Today, before CI exists, `docker compose build panel` builds that wrapper locally and tags it as `PANEL_IMAGE`.
- Later, CI should publish the same `PANEL_IMAGE` reference to GHCR so the host can switch from `build` to `pull` without changing the runtime contract.

## Prerequisites

- Ubuntu 24.04 VM
- DNS A/AAAA records pointed at the VM for the panel FQDN
- Public firewall access for `80/tcp` and `443/tcp`
- Docker Engine with `docker compose`
- Host Caddy installed and allowed to bind `80` and `443`

## Host Preparation

Create the host-owned directories:

```bash
sudo mkdir -p /etc/oberyn/pelican
sudo mkdir -p /srv/oberyn/pelican/runtime
sudo mkdir -p /srv/oberyn/pelican/logs/panel
sudo mkdir -p /srv/oberyn/pelican/mariadb
```

Install the host env file:

```bash
sudo cp deploy/pelican/production/panel/panel.env.example /etc/oberyn/pelican/panel.env
sudo chmod 0600 /etc/oberyn/pelican/panel.env
```

Edit `/etc/oberyn/pelican/panel.env` with your real values before first startup.

Important proxy note:

- keep `BEHIND_PROXY=true`
- set `TRUSTED_PROXIES` to the real source IP address or comma-separated list of addresses your panel container will see from host Caddy
- when Caddy runs on the host outside Docker, Pelican's Docker docs note this is commonly a Docker bridge or `docker0` address rather than `127.0.0.1`

If you need to discover that bridge address after the compose network exists, a practical check is:

```bash
docker network inspect pelican-production_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

Update `/etc/oberyn/pelican/panel.env` with that value, then recreate the `panel` service so the trusted-proxy setting takes effect.

## Host Caddy

Prefer generating the repo-owned Caddy site block from `/etc/oberyn/pelican/panel.env` so the panel hostname and local upstream port stay aligned with the compose contract.

Single-site host:

```bash
cd deploy/pelican/production/panel
./bin/render-caddy-site.sh /etc/oberyn/pelican/panel.env | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Multi-site host:

```bash
cd deploy/pelican/production/panel
sudo mkdir -p /etc/caddy/sites
./bin/render-caddy-site.sh /etc/oberyn/pelican/panel.env | sudo tee /etc/caddy/sites/pelican-panel.caddy >/dev/null
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

If your main `/etc/caddy/Caddyfile` does not already import site snippets, add an import such as:

```caddy
import /etc/caddy/sites/*.caddy
```

Expected public firewall behavior:

- `80/tcp`: public, required for ACME HTTP challenge and redirect handling
- `443/tcp`: public, required for the panel
- `${PANEL_HOST_PORT}`: local-only on `127.0.0.1`
- `3306/tcp` and `6379/tcp`: not published publicly

Expected proxy behavior:

- host Caddy terminates HTTPS and forwards to `127.0.0.1:${PANEL_HOST_PORT}`
- `TRUSTED_PROXIES` must match the address the panel container actually sees for that proxy hop
- if trusted proxies are unset or wrong, Pelican's Docker docs warn file uploads can fail behind the reverse proxy

## Manual Deploy Flow

From this directory:

```bash
cd deploy/pelican/production/panel
docker compose --env-file /etc/oberyn/pelican/panel.env config
docker compose --env-file /etc/oberyn/pelican/panel.env build panel
docker compose --env-file /etc/oberyn/pelican/panel.env up -d
```

Before you open the installer, back up `APP_KEY` from the generated runtime env:

```bash
sudo grep '^APP_KEY=' /srv/oberyn/pelican/runtime/.env
```

Do not proceed without saving that key somewhere safe.

## Readiness Checks Before Installer

Run these checks before touching `/installer`:

```bash
cd deploy/pelican/production/panel
docker compose --env-file /etc/oberyn/pelican/panel.env ps
curl -I http://127.0.0.1:${PANEL_HOST_PORT}/installer
docker compose --env-file /etc/oberyn/pelican/panel.env exec panel php artisan about --only=environment
```

Expected results:

- `mariadb`, `redis`, and `panel` show healthy
- `/installer` responds from the local bind
- `APP_ENV=production` and the expected `APP_URL` are visible inside the container

Then complete the Pelican web installer at:

```text
https://panel.example.com/installer
```

The web installer handles the first intentional admin creation. This production path does not reuse the local-dev `panel-init` behavior.

After the installer completes, restart the `panel` service once so the long-running panel process reloads the persisted runtime `.env` and stops serving `/installer`:

```bash
cd deploy/pelican/production/panel
docker compose --env-file /etc/oberyn/pelican/panel.env restart panel
curl -I http://127.0.0.1:${PANEL_HOST_PORT}/installer
```

Expected result:

- `/installer` now returns `404`
- `/login` loads normally
- the new admin can sign in

## Install the OberynHost Plugin

Treat plugin installation as the first post-installer deployment phase. Once the panel is installed, the first admin can log in, and the panel shell is reachable through Caddy, install the bundled OberynHost plugin:

```bash
cd deploy/pelican/production/panel
docker compose --env-file /etc/oberyn/pelican/panel.env exec panel php artisan p:plugin:install oberynhosttheme
```

The wrapper image syncs the bundled plugin files into the persistent runtime plugin directory on boot. The command above installs and enables it inside Pelican, which stays the right boundary because Pelican's own installer and plugin lifecycle are still separate phases.

If the plugin was already enabled before a wrapper-image rebuild, the file sync happens automatically on container restart. Re-run `p:plugin:install` only if `p:plugin:list` no longer shows `oberynhosttheme` as enabled.

## Panel-Ready Checklist

Before you touch Wings, confirm all of the following:

- `docker compose ps` shows all three services healthy
- `APP_KEY` has been backed up from `/srv/oberyn/pelican/runtime/.env`
- `https://panel.example.com/installer` completed successfully
- the `panel` service has been restarted once after installer completion
- `http://127.0.0.1:${PANEL_HOST_PORT}/installer` returns `404`
- the intentional first admin can log into the panel
- `docker compose exec panel php artisan p:plugin:list` shows `oberynhosttheme` as enabled
- the panel login and shell render correctly through Caddy

## Local Validation Without CI

To validate this stack on a non-production machine before CI exists:

1. Copy [`./panel.env.example`](./panel.env.example) to a temporary env file.
2. Override host paths to writable test directories under `/tmp`.
3. Set a test-only `PANEL_HOST_PORT`, such as `18080`.
4. Run `docker compose --env-file /path/to/test.env up -d --build`.
5. Verify `/installer` is reachable on the local bind and the bundled plugin appears in `p:plugin:list`.

## Future CI Handoff

Later, when CI exists, the contract should stay the same:

- CI builds and publishes `PANEL_IMAGE`
- the host pulls that immutable image reference
- the host still uses `/etc/oberyn/pelican/panel.env`
- the host still uses this compose file and Caddy config

## Operational Notes

- `user: "0:0"` is intentional in the compose file because the wrapper has to normalize ownership on bind-mounted host paths before the panel services run as `www-data`.
- The panel service already ships a working upstream healthcheck; it is restated in compose so the runtime contract stays explicit even if the image metadata changes later.
