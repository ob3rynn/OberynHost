# Production Storefront Deployment

This directory is the first production contract for the OberynHost storefront on the same Ubuntu 24.04 VM as the first Pelican panel and Wings node.

The storefront remains a separate deployment boundary from Pelican:

- the storefront uses its own Docker image and Compose project
- Pelican panel, MariaDB, and Redis stay in the Pelican Compose project
- Wings stays installed on the host through systemd
- host Caddy terminates HTTPS and routes the public storefront hostname to the local storefront bind port

## First-Deploy Rule

Run exactly one storefront instance until the fulfillment worker is split into a dedicated process or service.

The current backend process serves the customer/admin API and starts the fulfillment worker in the same process. That is acceptable for the first single-VM rollout, but it is not a horizontal scaling contract.

## Files

- [`./docker-compose.yml`](./docker-compose.yml): production storefront service
- [`./storefront.env.example`](./storefront.env.example): host-managed env contract
- [`./Caddyfile`](./Caddyfile): sample host Caddy site block
- [`./bin/render-caddy-site.sh`](./bin/render-caddy-site.sh): renders the Caddy site from `storefront.env`

## Production Contract

- The public storefront is served through host Caddy over HTTPS.
- The storefront container only binds to `127.0.0.1:${STOREFRONT_HOST_PORT}` on the VM.
- Runtime SQLite data lives outside the repo checkout under `/srv/oberyn/storefront`.
- Secrets live in a root-owned host env file such as `/etc/oberyn/storefront/storefront.env`.
- Logs stay on container stdout/stderr.
- The launch product remains `2GB Paper Minecraft Server`: `paper-2gb`, `minecraft-paper-2gb`, `STRIPE_PRICE_PAPER_2GB`, `$11.97/month`, container memory `2424 MB`, JVM target `2024 MB`.

## Host Preparation

Create the host-owned directories:

```bash
sudo mkdir -p /etc/oberyn/storefront
sudo mkdir -p /srv/oberyn/storefront
```

Install the host env file:

```bash
sudo cp deploy/storefront/production/storefront.env.example /etc/oberyn/storefront/storefront.env
sudo chmod 0600 /etc/oberyn/storefront/storefront.env
sudoedit /etc/oberyn/storefront/storefront.env
```

At minimum, set real values for:

- `STOREFRONT_IMAGE`
- `BASE_URL`
- `OUTBOUND_EMAIL_FROM`
- `POSTMARK_SERVER_TOKEN`
- `ADMIN_KEY`
- `SETUP_SECRET_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_PAPER_2GB`
- `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`
- `PELICAN_PANEL_URL`
- `PELICAN_APPLICATION_API_KEY`
- `PELICAN_PROVISIONING_TARGETS_JSON`

Do not add legacy launch product variables such as `STRIPE_PRICE_2GB`, `STRIPE_PRICE_3GB`, or `STRIPE_PRICE_4GB`.

## Host Caddy

Prefer generating the Caddy site block from `/etc/oberyn/storefront/storefront.env`:

```bash
cd deploy/storefront/production
sudo mkdir -p /etc/caddy/sites
./bin/render-caddy-site.sh /etc/oberyn/storefront/storefront.env | sudo tee /etc/caddy/sites/storefront.caddy >/dev/null
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

If your main `/etc/caddy/Caddyfile` does not already import site snippets, add:

```caddy
import /etc/caddy/sites/*.caddy
```

Expected public firewall behavior:

- `80/tcp`: public, required for ACME HTTP challenge and redirect handling
- `443/tcp`: public, required for the storefront
- `${STOREFRONT_HOST_PORT}`: local-only on `127.0.0.1`

## Manual Deploy Flow

From this directory:

```bash
cd deploy/storefront/production
docker compose --env-file /etc/oberyn/storefront/storefront.env config
docker compose --env-file /etc/oberyn/storefront/storefront.env build storefront
docker compose --env-file /etc/oberyn/storefront/storefront.env up -d
docker compose --env-file /etc/oberyn/storefront/storefront.env ps
```

Gate:

- `storefront` shows healthy
- `curl -fsS http://127.0.0.1:${STOREFRONT_HOST_PORT}/api/plans` succeeds
- the public storefront URL loads through Caddy
- Stripe webhook delivery reaches `/api/stripe/webhook` without signature errors

## Fulfillment Readiness

Before accepting real purchases, confirm all of the following:

- Pelican panel is live, installed, and backed up
- Wings is healthy from the live panel node view
- `2GB Paper Minecraft Server` Stripe live-mode price is configured in `STRIPE_PRICE_PAPER_2GB`
- Stripe Customer Portal is configured and its configuration ID is set in `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`
- `PELICAN_PROVISIONING_TARGETS_JSON` was built from real Pelican/Wings values, not guessed
- the operator fulfillment harness has passed against the intended local/test infrastructure

The operator harness is manual-only. It validates the automation path, but it does not prove production Cloudflare behavior, public DNS, firewall rules, final HAProxy routing, or production network topology.

## Stripe Branding Checklist

Stripe account branding is managed in the Stripe Dashboard and applies to Checkout, Customer Portal, emails, invoices, and hosted invoice pages. The connector used by Codex cannot update account branding directly.

Use the prepared assets:

- Icon: `docs/assets/stripe-branding/stripe-icon-oberynhost.png`

Set these Dashboard branding values:

- Stripe **Icon**: upload the square icon asset.
- Stripe **Logo**: leave unset for now.
- Brand color: `#1B555B`.
- Accent color: `#2A8B8F`.
- Preview Checkout and Customer Portal to confirm the OberynHost icon and colors appear correctly.

## Backup Notes

Back up at least:

- `/etc/oberyn/storefront/storefront.env`
- `/srv/oberyn/storefront/storefront.sqlite3`
- SQLite WAL/SHM files if they exist during backup
- the deployed image tag recorded in `STOREFRONT_IMAGE`

Take the storefront backup separately from Pelican MariaDB and Pelican mounted storage backups.

## Future Split

Before running more than one storefront replica, split the backend into separate web and worker services or add a supported worker-disable mode for web-only containers. Until then, one storefront container is the production rule.
