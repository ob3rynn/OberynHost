# Production Panel Deployment

This directory prepares the public Pelican panel deployment for a real Ubuntu 24.04 VM while stopping short of any GitHub Actions or GHCR automation.

## Files

- [Dockerfile](/home/oberynn/OberynHost/deploy/pelican/production/panel/Dockerfile): thin wrapper image over the pinned upstream Pelican image
- [docker-compose.yml](/home/oberynn/OberynHost/deploy/pelican/production/panel/docker-compose.yml): production panel, MariaDB, and Redis stack
- [panel.env.example](/home/oberynn/OberynHost/deploy/pelican/production/panel/panel.env.example): host-managed env contract
- [Caddyfile](/home/oberynn/OberynHost/deploy/pelican/production/panel/Caddyfile): host Caddy config template for the public panel FQDN
- [bin/entrypoint-wrapper.sh](/home/oberynn/OberynHost/deploy/pelican/production/panel/bin/entrypoint-wrapper.sh): wrapper entrypoint that seeds the OberynHost plugin into persistent runtime storage

## Production Contract

- The public panel is served through host Caddy over HTTPS.
- The panel container itself only binds to `127.0.0.1:${PANEL_HOST_PORT}` on the VM.
- MariaDB and Redis stay internal-only and are not published publicly.
- Persistent runtime paths live outside the repo checkout under `/srv/oberyn/pelican/...`.
- Secrets live in a root-owned host env file such as `/etc/oberyn/pelican/panel.env`.

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
sudo mkdir -p /srv/oberyn/pelican/backups
```

Install the host env file:

```bash
sudo cp /home/oberynn/OberynHost/deploy/pelican/production/panel/panel.env.example /etc/oberyn/pelican/panel.env
sudo chmod 0600 /etc/oberyn/pelican/panel.env
```

Edit `/etc/oberyn/pelican/panel.env` with your real values before first startup.

## Host Caddy

Copy the repo-owned Caddy config into place and replace the example domain before reloading Caddy:

```bash
sudo cp /home/oberynn/OberynHost/deploy/pelican/production/panel/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Expected public firewall behavior:

- `80/tcp`: public, required for ACME HTTP challenge and redirect handling
- `443/tcp`: public, required for the panel
- `${PANEL_HOST_PORT}`: local-only on `127.0.0.1`
- `3306/tcp` and `6379/tcp`: not published publicly

## Manual Deploy Flow

From this directory:

```bash
cd /home/oberynn/OberynHost/deploy/pelican/production/panel
docker compose --env-file /etc/oberyn/pelican/panel.env config
docker compose --env-file /etc/oberyn/pelican/panel.env build panel
docker compose --env-file /etc/oberyn/pelican/panel.env up -d
```

Before you open the installer, back up `APP_KEY` from the generated runtime env:

```bash
sudo grep '^APP_KEY=' /srv/oberyn/pelican/runtime/.env
```

Do not proceed without saving that key somewhere safe.

Then complete the Pelican web installer at:

```text
https://panel.example.com/installer
```

The web installer handles the first intentional admin creation. This production path does not reuse the local-dev `panel-init` behavior.

## Install the OberynHost Plugin

Once the panel is installed and reachable, install the bundled OberynHost plugin:

```bash
cd /home/oberynn/OberynHost/deploy/pelican/production/panel
docker compose --env-file /etc/oberyn/pelican/panel.env exec panel php artisan p:plugin:install oberynhosttheme
```

The wrapper image seeds the plugin files into the persistent plugin directory on first boot. The command above installs and enables it inside Pelican.

## Local Validation Without CI

To validate this stack on a non-production machine before CI exists:

1. Copy [panel.env.example](/home/oberynn/OberynHost/deploy/pelican/production/panel/panel.env.example) to a temporary env file.
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
