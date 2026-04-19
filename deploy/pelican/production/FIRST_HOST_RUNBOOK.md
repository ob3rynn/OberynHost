# First Host Runbook

Use this document for the first real Ubuntu 24.04 VM rollout.

This is the operator sequence for getting from a fresh VM to:

- the panel live behind host Caddy
- the first admin created
- the OberynHost plugin enabled
- the first Wings node installed and daemonized

This runbook is intentionally linear. Do not skip ahead. Do not enable Wings until the panel gates are green.

## Assumptions

- you are on the VM that will host both the panel and the first Wings node
- DNS already points `panel.<domain>` and `node1.<domain>` at this VM
- public firewall access for `80/tcp` and `443/tcp` is available now
- you have this repo checked out on the VM
- commands below start from the repo root unless stated otherwise

Set a repo path for this session:

```bash
export REPO_DIR="$(pwd)"
```

If you are not in the repo root, set `REPO_DIR` manually first.

## 1. Verify the VM

```bash
systemd-detect-virt
uname -r
```

Stop if:

- the VM is on an unsupported OpenVZ/LXC-style host
- Docker workloads are not expected to work reliably on this virtualization setup

## 2. Install Host Software

Install Docker CE:

```bash
curl -sSL https://get.docker.com/ | CHANNEL=stable sudo sh
sudo systemctl enable --now docker
docker --version
docker compose version
```

Install Caddy:

```bash
sudo apt-get update
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo apt-get update
sudo apt-get install -y caddy
sudo systemctl enable --now caddy
sudo systemctl status caddy --no-pager
```

Gate:

- `docker compose version` works
- `systemctl status caddy` shows Caddy running

## 3. Prepare Host Paths

```bash
sudo mkdir -p /etc/oberyn/pelican
sudo mkdir -p /srv/oberyn/pelican/runtime
sudo mkdir -p /srv/oberyn/pelican/logs/panel
sudo mkdir -p /srv/oberyn/pelican/mariadb
sudo mkdir -p /etc/pelican
sudo mkdir -p /var/run/wings
```

Install the panel env file:

```bash
sudo cp "$REPO_DIR/deploy/pelican/production/panel/panel.env.example" /etc/oberyn/pelican/panel.env
sudo chmod 0600 /etc/oberyn/pelican/panel.env
sudoedit /etc/oberyn/pelican/panel.env
```

At minimum, set real values for:

- `APP_URL`
- `DB_PASSWORD`
- `MARIADB_ROOT_PASSWORD`
- `MAIL_HOST`
- `MAIL_USERNAME`
- `MAIL_PASSWORD`
- `MAIL_FROM_ADDRESS`
- `TRUSTED_PROXIES`

Leave `BEHIND_PROXY=true`.

If you do not yet know `TRUSTED_PROXIES`, leave it blank for the moment and set it in step 7 before installer completion.

## 4. Apply Host Caddy

Single-site host:

```bash
cd "$REPO_DIR/deploy/pelican/production/panel"
./bin/render-caddy-site.sh /etc/oberyn/pelican/panel.env | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Multi-site host:

```bash
cd "$REPO_DIR/deploy/pelican/production/panel"
sudo mkdir -p /etc/caddy/sites
./bin/render-caddy-site.sh /etc/oberyn/pelican/panel.env | sudo tee /etc/caddy/sites/pelican-panel.caddy >/dev/null
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

If your main `/etc/caddy/Caddyfile` does not already import snippets, add:

```caddy
import /etc/caddy/sites/*.caddy
```

Gate:

- `sudo caddy validate --config /etc/caddy/Caddyfile` succeeds
- `sudo systemctl reload caddy` succeeds

## 5. Open Only the Required Firewall Ports

Open now:

- `80/tcp`
- `443/tcp`

Do not open publicly:

- the panel container bind port from `PANEL_HOST_PORT`
- MariaDB `3306/tcp`
- Redis `6379/tcp`

Do not open Wings API, SFTP, or allocation ports yet. Those come later from the live node config.

## 6. Build and Start the Panel Stack

```bash
cd "$REPO_DIR/deploy/pelican/production/panel"
docker compose --env-file /etc/oberyn/pelican/panel.env config
docker compose --env-file /etc/oberyn/pelican/panel.env build panel
docker compose --env-file /etc/oberyn/pelican/panel.env up -d
docker compose --env-file /etc/oberyn/pelican/panel.env ps
```

Gate:

- `mariadb`, `redis`, and `panel` all show healthy

## 7. Confirm Runtime Env and Trusted Proxy Input

Back up `APP_KEY` immediately:

```bash
sudo grep '^APP_KEY=' /srv/oberyn/pelican/runtime/.env
```

Save that key somewhere safe before continuing.

Check the installer endpoint:

```bash
PANEL_HOST_PORT="$(sudo awk -F= '/^PANEL_HOST_PORT=/{print $2}' /etc/oberyn/pelican/panel.env)"
curl -I "http://127.0.0.1:${PANEL_HOST_PORT}/installer"
docker compose --env-file /etc/oberyn/pelican/panel.env exec panel php artisan about --only=environment
```

If `TRUSTED_PROXIES` is still blank, discover the Docker bridge gateway now:

```bash
docker network inspect pelican-production_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

Write that address into `/etc/oberyn/pelican/panel.env`, then recreate only the panel service:

```bash
sudoedit /etc/oberyn/pelican/panel.env
docker compose --env-file /etc/oberyn/pelican/panel.env up -d --force-recreate panel
```

Gate:

- `/installer` returns a successful HTTP response
- `php artisan about --only=environment` shows `Environment: production`
- `APP_URL` matches the public panel URL
- `TRUSTED_PROXIES` is set to the real proxy hop the container sees

## 8. Complete the Web Installer

Open the public installer URL in a browser:

```text
https://panel.<domain>/installer
```

Complete the installer with the intentional first admin account.

Gate:

- the installer completes without error
- the first admin exists and can sign in if prompted

## 9. Restart the Panel Once After Installer Completion

The running panel process needs one restart after installer completion so it reloads the persisted runtime `.env` and stops serving `/installer`.

```bash
cd "$REPO_DIR/deploy/pelican/production/panel"
PANEL_HOST_PORT="$(sudo awk -F= '/^PANEL_HOST_PORT=/{print $2}' /etc/oberyn/pelican/panel.env)"
docker compose --env-file /etc/oberyn/pelican/panel.env restart panel
curl -I "http://127.0.0.1:${PANEL_HOST_PORT}/installer"
curl -I "http://127.0.0.1:${PANEL_HOST_PORT}/login"
```

Gate:

- `/installer` returns `404`
- `/login` returns `200`
- the first admin can sign in through the public panel URL

## 10. Install the OberynHost Plugin

```bash
cd "$REPO_DIR/deploy/pelican/production/panel"
docker compose --env-file /etc/oberyn/pelican/panel.env exec panel php artisan p:plugin:install oberynhosttheme
docker compose --env-file /etc/oberyn/pelican/panel.env exec panel php artisan p:plugin:list
```

Gate:

- `oberynhosttheme` shows as `enabled`
- the login page and panel shell render correctly through Caddy

## 11. Stop and Verify Before Touching Wings

Do not continue until all of the following are true:

- `docker compose --env-file /etc/oberyn/pelican/panel.env ps` shows all panel services healthy
- `APP_KEY` has been backed up
- `/installer` is closed
- `/login` works
- the first admin can sign in
- the OberynHost plugin is enabled

## 12. Install the Pinned Wings Binary

```bash
WINGS_VERSION=v1.0.0-beta24
ARCH=$([[ "$(uname -m)" == "x86_64" ]] && echo "amd64" || echo "arm64")
sudo curl -L -o /usr/local/bin/wings "https://github.com/pelican-dev/wings/releases/download/${WINGS_VERSION}/wings_linux_${ARCH}"
sudo chmod u+x /usr/local/bin/wings
/usr/local/bin/wings --version
```

Gate:

- `wings --version` works

## 13. Create the First Node in the Live Panel

From the live panel:

1. Log in as the first admin.
2. Create the first node.
3. Open the node’s **Configuration** tab.
4. Copy the generated config into `/etc/pelican/config.yml`.

Do not invent or commit a static node config in git. The live panel is the source of truth.

## 14. Review the Generated Node Config Before Start

Check these values in `/etc/pelican/config.yml`:

- `remote`
- `api.host`
- `api.port`
- `system.sftp.bind_port`
- certificate and key paths if SSL is enabled
- any server-data or backup paths the config expects

If the panel uses HTTPS, provision a real certificate for `node1.<domain>` and make sure the copied config references valid paths before continuing.

## 15. Open the Wings Ports Defined by the Live Config

Open publicly:

- the exact node API port from `api.port`
- the exact SFTP port from `system.sftp.bind_port`

Open later, not now:

- customer allocation ports, and only after those allocations exist in the live panel

## 16. Validate Wings Interactively

```bash
sudo wings --debug
```

Stop here until Wings starts cleanly with the copied config.

## 17. Install the Wings Systemd Unit

```bash
sudo cp "$REPO_DIR/deploy/pelican/production/wings/wings.service" /etc/systemd/system/wings.service
sudo systemctl daemon-reload
sudo systemctl enable --now wings
sudo systemctl status wings --no-pager
```

Gate:

- `systemctl status wings` shows the service running

## 18. Final First-Host Exit Checks

- panel is reachable on the public FQDN over HTTPS
- `/installer` is closed
- the first admin can sign in
- `oberynhosttheme` is enabled
- Wings is installed from the pinned version
- `sudo wings --debug` was clean before daemonizing
- `sudo systemctl status wings` is healthy
- only the intended public ports are exposed

## Follow-Up References

- Panel deployment details: [`./panel/README.md`](./panel/README.md)
- Wings host details: [`./wings/README.md`](./wings/README.md)
- Wings host checklist: [`./wings/HOST_CHECKLIST.md`](./wings/HOST_CHECKLIST.md)
