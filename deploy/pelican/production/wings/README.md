# Wings Host Setup

This path prepares the real Wings installation the production VM will eventually need. Wings is intentionally not containerized here and does not belong in the local-dev panel folder.

## Expected Host Paths

- Wings binary: `/usr/local/bin/wings`
- Wings config: `/etc/pelican/config.yml`
- Wings runtime directory: `/var/run/wings`
- systemd unit: `/etc/systemd/system/wings.service`

## Ubuntu 24.04 Runbook

### 1. Verify the VM can run Docker workloads

Run these checks first:

```bash
systemd-detect-virt
uname -r
```

Avoid unsupported virtualization setups such as OpenVZ/LXC where nested Docker support is not available.

### 2. Install Docker CE

```bash
curl -sSL https://get.docker.com/ | CHANNEL=stable sudo sh
sudo systemctl enable --now docker
```

### 3. Prepare Wings directories and binary

```bash
sudo mkdir -p /etc/pelican /var/run/wings
sudo curl -L -o /usr/local/bin/wings "https://github.com/pelican-dev/wings/releases/latest/download/wings_linux_$([[ \"$(uname -m)\" == \"x86_64\" ]] && echo \"amd64\" || echo \"arm64\")"
sudo chmod u+x /usr/local/bin/wings
```

### 4. Create the node in the live panel

After the production panel is installed:

1. Log into the panel admin area.
2. Create the first node.
3. Open that node’s **Configuration** tab.
4. Copy the generated config into `/etc/pelican/config.yml`.

Do not invent a static config in git. The live panel is the source of truth for node config.

### 5. Handle SSL for Wings

If the panel uses HTTPS, Wings must also use SSL.

- create a real `node1.<domain>` DNS record from day one
- provision a certificate for that node hostname
- ensure the copied `/etc/pelican/config.yml` references valid certificate and key paths before enabling Wings

Use the Pelican SSL guide for the exact certificate path and renewal method that fits your environment.

### 6. Validate Wings interactively before daemonizing

```bash
sudo wings --debug
```

Only continue after Wings starts cleanly with the copied config.

### 7. Install the systemd unit

Copy [wings.service](/home/oberynn/OberynHost/deploy/pelican/production/wings/wings.service) into place, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wings
```

## Firewall and Network Notes

- Open the public node API and SFTP ports that the live panel-generated node config expects
- Keep Docker’s internal bridge traffic available for Wings
- Keep the panel’s local-only port, MariaDB, and Redis inaccessible from the public internet

## Storage Notes

Pelican recommends keeping server files on a separate partition when possible so the root partition cannot fill and destabilize the VM. Decide that storage layout before onboarding real customer servers.

## References

- Installing Wings: [https://pelican.dev/docs/wings/install](https://pelican.dev/docs/wings/install)
- Updating Wings: [https://pelican.dev/docs/wings/update/](https://pelican.dev/docs/wings/update/)
- SSL guidance: [https://pelican.dev/docs/guides/ssl/](https://pelican.dev/docs/guides/ssl/)
