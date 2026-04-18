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
- Wings public node API and SFTP ports opened only after the live node config defines them

## Private / Local-Only Ports

- panel container port bound to `127.0.0.1:${PANEL_HOST_PORT}`
- MariaDB not publicly exposed
- Redis not publicly exposed

## Host Software

- Docker CE installed and enabled
- Caddy installed and reloaded successfully
- Wings binary installed at `/usr/local/bin/wings`

## Host Paths

- `/etc/oberyn/pelican/panel.env` exists and is `0600`
- `/srv/oberyn/pelican/runtime` exists
- `/srv/oberyn/pelican/logs/panel` exists
- `/srv/oberyn/pelican/mariadb` exists
- `/srv/oberyn/pelican/backups` exists
- `/etc/pelican` exists
- `/var/run/wings` exists

## Panel Readiness

- production panel stack is running
- `APP_KEY` backed up from `/srv/oberyn/pelican/runtime/.env`
- web installer completed
- first admin created intentionally through the installer
- `oberynhosttheme` plugin installed and enabled

## Wings Readiness

- first node created in the live panel
- generated node config copied to `/etc/pelican/config.yml`
- SSL certificate for the node hostname provisioned if the panel uses HTTPS
- `sudo wings --debug` runs cleanly
- `sudo systemctl enable --now wings` succeeds
