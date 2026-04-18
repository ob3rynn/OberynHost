# Pelican Production Prep

This path is the repo-owned production source of truth for the first real Pelican rollout. It is intentionally separate from [apps/pelicanpanel](/home/oberynn/OberynHost/apps/pelicanpanel), which remains local-dev-only.

## Architecture

- Ubuntu 24.04 single-VM first rollout
- Host Caddy terminates HTTPS and proxies the public panel FQDN to the internal panel container
- Docker Compose runs the panel, MariaDB, and Redis on the VM
- Wings is installed on the VM as a host binary with systemd, not in Docker
- A thin repo-owned wrapper image extends the pinned upstream Pelican image
- A small OberynHost branding plugin ships with that wrapper image

## Boundaries

- `panel/` owns the public panel deployment contract
- `wings/` owns the host install runbook and host-side service contract
- `apps/pelicanpanel/` is still local development only and is not reused for production
- Storefront integration is intentionally out of scope in this phase

## Layout

- [panel](/home/oberynn/OberynHost/deploy/pelican/production/panel): production compose stack, wrapper image, env contract, host Caddy config, and manual deploy guide
- [wings](/home/oberynn/OberynHost/deploy/pelican/production/wings): host Wings install runbook, systemd unit template, and host checklist

## Manual Rollout Order

1. Prepare the VM, DNS, firewall, and host directories.
2. Install Caddy on the host and apply the panel Caddy config.
3. Build and start the panel stack from [panel/docker-compose.yml](/home/oberynn/OberynHost/deploy/pelican/production/panel/docker-compose.yml).
4. Back up `APP_KEY` from the generated runtime `.env`.
5. Complete the Pelican web installer at `/installer`.
6. Install and enable the OberynHost plugin.
7. Create the first node in the live panel.
8. Install Wings on the host, copy the generated node config into `/etc/pelican/config.yml`, validate it with `wings --debug`, then daemonize it with systemd.

## Future CI Handoff

This path is ready for a later GHCR/CI phase, but does not implement it yet.

- The future publish target is `PANEL_IMAGE`.
- The wrapper `Dockerfile` is already repo-owned.
- The production env contract is already explicit.
- The manual deploy commands here are the same commands a future CI/CD flow would automate.
