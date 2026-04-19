# First Wings Host Checklist

Use this checklist before enabling the first production node.

## VM and OS

- Ubuntu 24.04 installed
- virtualization confirmed compatible with Docker
- kernel does not come from an unsupported OpenVZ/LXC-style host setup

## DNS

- `panel.<domain>` points to the VM
- `node1.<domain>` points to the VM

## Public Firewall

- `80/tcp` open for panel HTTPS bootstrap/ACME
- `443/tcp` open for the public panel
- Wings node API port from `/etc/pelican/config.yml` opened only after the live node config defines it
- Wings SFTP port from `/etc/pelican/config.yml` opened only after the live node config defines it
- customer server allocation ports opened only after those allocations exist in the live panel

## Private / Local-Only Ports

- panel container port bound to `127.0.0.1:${PANEL_HOST_PORT}`
- MariaDB not publicly exposed
- Redis not publicly exposed

## Host Software

- Docker CE installed and enabled
- Caddy installed and reloaded successfully
- Wings binary installed at `/usr/local/bin/wings`
- Wings binary downloaded from the pinned repo version, not `latest`

## Host Paths

- `/etc/oberyn/pelican/panel.env` exists and is `0600`
- `/srv/oberyn/pelican/runtime` exists
- `/srv/oberyn/pelican/logs/panel` exists
- `/srv/oberyn/pelican/mariadb` exists
- `/etc/pelican` exists
- `/var/run/wings` exists
- any server-data and backup directories referenced by the live node config exist or will be created by the chosen Wings storage layout

## Panel Readiness

- production panel stack is running
- `APP_KEY` backed up from `/srv/oberyn/pelican/runtime/.env`
- web installer completed
- panel service restarted once after installer completion so `/installer` is closed
- first admin created intentionally through the installer
- `oberynhosttheme` plugin installed and enabled
- panel reachable through Caddy on the public FQDN

## Wings Readiness

- first node created in the live panel
- generated node config copied to `/etc/pelican/config.yml`
- `/etc/pelican/config.yml` reviewed for `remote`, `api.port`, `system.sftp.bind_port`, and SSL paths
- SSL certificate for the node hostname provisioned if the panel uses HTTPS
- `sudo wings --debug` runs cleanly
- `sudo systemctl enable --now wings` succeeds
