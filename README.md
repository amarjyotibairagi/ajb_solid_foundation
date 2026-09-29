# Platform Foundation

A self-installing multi-tenant platform. Unzip this folder anywhere on an
Ubuntu or Debian server, fill in `.env/`, and run `setup.sh`. The script
builds a complete installation **inside this folder** and controls it from
then on (status, backups, upgrades, uninstall). The admin panel then controls
the platform itself.

| Component | What it is |
|---|---|
| **Landing site** | A generic public home page on `ROOT_DOMAIN` |
| **Platform console** | The operator admin panel on `platform.ROOT_DOMAIN`, for tenants, plans, configuration, operators, DNS, integrations and schema upgrades |
| **Individual-user app** | The B2C app on `user.ROOT_DOMAIN` |
| **Tenant workspaces** | One per organization, on `<name>.ROOT_DOMAIN`. Each has its own PostgreSQL schema with forced row-level security, its own database login (or a shared pool) and its own file storage. A tenant may optionally bring its own S3-compatible storage or PostgreSQL database |
| **Provisioning worker** | Creates, migrates, relocates and removes tenants |
| **PostgreSQL** | A dedicated cluster, plus three PgBouncer pools |
| **Operations** | Encrypted daily backups, a health check every few minutes and an optional Cloudflare Tunnel |

As shipped, the folder contains no secrets and no database. Every password and
key is generated on the server during installation, and the database is
created empty and then migrated.

---

## 1. Requirements

- A server running **Ubuntu 22.04/24.04 or Debian 12** with systemd, root access, 2 or more vCPUs, 4 GB or more RAM and 20 GB or more of disk.
- A domain name. With the recommended Cloudflare mode, its DNS must be on Cloudflare.
- Outbound internet access during installation (packages, npm, Cloudflare API).

The installer can fetch PostgreSQL 16+, PgBouncer, Node.js 22+ and cloudflared
itself (`--install-packages`), or you can install them beforehand.

## 2. Folder layout

The installation lives entirely in the folder that holds `setup.sh`:

| Path | Created by install | Contents |
|---|---|---|
| `./` | no | Code, run in place. Install adds `node_modules/` and `dist/` builds |
| `./runtime/config/` | yes | `install.env`, `secrets/` and `env/` (root only), `pgbouncer/` |
| `./runtime/data/` | yes | PostgreSQL cluster, tenant credentials, tenant files |
| `./runtime/logs/` | yes | One log per setup run (services log to the journal) |
| `./runtime/node/` | yes | Node.js, when `--install-packages` downloaded it |
| `./backups/` | yes | Encrypted backups (`BACKUP_DIR` can point elsewhere) |

Outside the folder, install adds only what a service needs:

- systemd units `/etc/systemd/system/<slug>-*`
- system users `<slug>-*`
- the PostgreSQL, PgBouncer and cloudflared packages, from the OS repositories

`sudo ./setup.sh uninstall --purge` removes all of that and returns the folder
to exactly its unzipped state, keeping `./backups/`.

Put the folder somewhere the service accounts can reach, such as
`/opt/<name>` or `/srv/<name>`. Every directory above it must be traversable
by other users, so `/root` does not work. `check` says so if a location
cannot be used. To run two installations on one server, use two folders with
different `APP_SLUG`s and ports.

What ships in the folder:

```
foundation/
├── setup.sh              ← the installer (run this)
├── .env/
│   ├── setup.env         ← every decision about the installation (no secrets)
│   └── secrets.env       ← credentials you supply (blank by default)
├── backend/              platform, public, tenant services and the provisioning worker
├── frontend/             landing, platform console, individual app, tenant app
├── dependency/           shared server kit, UI kit, Cloudflare and Drizzle packages
├── database/
│   ├── migrations/       platform migrations (ordered by manifest.json) and tenant schema versions
│   └── seeds/            optional demo individuals
├── deploy/templates/     systemd units, PgBouncer and PostgreSQL configuration templates
├── scripts/              migration, operator, backup, health and foundation helper scripts
├── tests/                unit and integration tests (run against a throwaway database)
└── docs/                 architecture, security and operations notes
```

## 3. Quick start

```bash
# 1. Unpack into the folder that will become the installation
sudo mkdir -p /opt/myplatform && cd /opt/myplatform
sudo unzip /path/to/foundation-<date>.zip

# 2. Make your decisions
sudo nano .env/setup.env        # product name, domain, edge mode, ports...
sudo nano .env/secrets.env      # Cloudflare token / Turnstile keys, as your choices require

# 3. Validate. This changes nothing.
sudo ./setup.sh check

# 4. Install
sudo ./setup.sh install --install-packages            # add --with-demo for sample data

# 5. First sign-in
sudo cat runtime/config/secrets/initial-owner.txt
```

Open `https://platform.<your domain>`, sign in as the owner and enrol a
security key when asked. After that, delete `initial-owner.txt`.

## 4. The `.env` folder

### `.env/setup.env` (decisions, no secrets)

| Section | Keys | Notes |
|---|---|---|
| Identity | `PRODUCT_NAME`, `APP_SLUG`, `ROOT_DOMAIN`, `PLATFORM_SUBDOMAIN`, `PUBLIC_SUBDOMAIN`, `CONTACT_EMAIL`, `BRAND_TAGLINE`, `BRAND_DESCRIPTION` | `APP_SLUG` names the system users, units and directories. Both subdomains are reserved so no tenant can claim them. |
| Owner | `OWNER_USERNAME`, `OWNER_DISPLAY_NAME` | Created on the first install only, with a generated password. |
| Edge | `EDGE_MODE`, `CLOUDFLARE_TUNNEL_NAME`, `LOGIN_CHALLENGE` | See section 5. |
| Defaults | `DEFAULT_CONNECTION_TIER`, `SHARED_STATE_BACKEND`, `ENABLE_INTEGRATIONS`, `TENANT_EDGE_VERIFY` | All of these can be changed later in the admin panel, except the state backend. |
| Locations | `BACKUP_DIR` | Optional. Leave it empty to use `./backups`. Everything else is fixed inside the folder. |
| Software | `PG_VERSION`, `NODE_MAJOR`, `NODE_BIN` | Node.js comes from `./runtime/node`, or from `node` on the PATH. |
| Ports | `POSTGRES_PORT`, `PGBOUNCER_*_PORT`, `LANDING_PORT`, `PLATFORM_PORT`, `PUBLIC_PORT`, `TENANT_PORT` | All ports bind to 127.0.0.1 only. |
| Operations | `BACKUP_SCHEDULE`, `BACKUP_RETENTION_DAYS`, `BACKUP_INCLUDE_STORAGE`, `HEALTHCHECK_INTERVAL` | |

### `.env/secrets.env` (credentials you already have)

The file ships blank. If you keep this folder in git, never commit it after
filling it in: keep your copy as `.env/secrets.env.local` (ignored) and copy it
into place on the server.

| Key | Needed when |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_TOKEN` | `EDGE_MODE=cloudflare-api`. The token needs these permissions: *Account › Cloudflare Tunnel › Edit*, *Account › Turnstile › Edit* and *Zone › DNS › Edit*. |
| `CLOUDFLARE_TUNNEL_TOKEN` | `EDGE_MODE=cloudflare-token` |
| `TURNSTILE_{PLATFORM,PUBLIC,TENANT}_{SITE,SECRET}_KEY` | `LOGIN_CHALLENGE=turnstile` with an edge mode other than `cloudflare-api`. The tenant widget must allow `ROOT_DOMAIN`. |
| `NOTIFICATION_WEBHOOK_URL`, `NOTIFICATION_WEBHOOK_SECRET` | Optional. Invitation links are POSTed to this relay as signed JSON. |

### What the installer generates

Nothing generated is ever written into `.env/`. Install also restricts `.env/`
to root, so the service accounts cannot read your credentials.
`runtime/config/secrets/` is readable by root only. It holds:

- `generated.env`: database role passwords, PgBouncer admin/stats passwords, the tenant session secret and the integration sealing key
- `backup.key`: the backup encryption key
- `cloudflare.json` and `tunnel.token`: in the Cloudflare modes
- `initial-owner.txt` and `demo-tenant.txt`

Service environment files are in `runtime/config/env/*.env`, also root only.
systemd reads them when it starts each service.

**Copy `backup.key` and `generated.env` off the server.** Without
`backup.key`, backups cannot be decrypted. Without `INTEGRATION_SECRET_KEY`,
stored tenant integration credentials cannot be unsealed.

## 5. Public edge modes

**`cloudflare-api` (recommended, fully automatic).** The installer creates or
updates the following:

- a remotely-managed tunnel `<CLOUDFLARE_TUNNEL_NAME>`
- proxied DNS records for the apex, `www`, the platform and public hosts, and `*`
- three Turnstile widgets

Existing DNS records for those names that are not tunnel CNAMEs stop the
install. Remove them, or set `CLOUDFLARE_REPLACE_DNS=true` in `setup.env` to
have them replaced. The admin panel's DNS page uses the same API token.

**`cloudflare-token`.** Runs an existing tunnel. Add these public hostnames to
it in the Cloudflare dashboard:

| Hostname | Service |
|---|---|
| `ROOT_DOMAIN`, `www.ROOT_DOMAIN` | `http://127.0.0.1:LANDING_PORT` |
| `PLATFORM_SUBDOMAIN.ROOT_DOMAIN` | `http://127.0.0.1:PLATFORM_PORT` |
| `PUBLIC_SUBDOMAIN.ROOT_DOMAIN` | `http://127.0.0.1:PUBLIC_PORT` |
| `*.ROOT_DOMAIN` | `http://127.0.0.1:TENANT_PORT` |

**`none`.** No tunnel. Use your own TLS reverse proxy with the same mapping,
with a wildcard certificate for `*.ROOT_DOMAIN`. Forward the `Host` header
unchanged. HTTPS is mandatory, because security keys (WebAuthn) and secure
cookies do not work over plain HTTP. Here is an example for Caddy:

```
example.com, www.example.com { reverse_proxy 127.0.0.1:3651 }
platform.example.com         { reverse_proxy 127.0.0.1:3656 }
user.example.com             { reverse_proxy 127.0.0.1:3657 }
*.example.com                { tls { dns <provider> } reverse_proxy 127.0.0.1:6355 }
```

**`LOGIN_CHALLENGE=none`** removes the Turnstile widget from all sign-in pages.
Throttling and rate limits still apply. Use it only for private sandboxes.

## 6. Commands

```
sudo ./setup.sh check                 validate .env/ and the host, show the plan
sudo ./setup.sh install [options]     install, or upgrade in place
sudo ./setup.sh status                services, database, tenants, backups, health
sudo ./setup.sh demo                  add demo individuals and a demo tenant
sudo ./setup.sh owner-password        new password for OWNER_USERNAME (ends its sessions)
sudo ./setup.sh backup                encrypted backup now
sudo ./setup.sh logs [service]        follow logs (platform, tenant, provisioner, postgresql, ...)
./setup.sh test                       test suite against a throwaway database
sudo ./setup.sh uninstall             remove services and system users; keep ./runtime
sudo ./setup.sh uninstall --purge     also delete ./runtime, dependencies and builds, so the
                                      folder is back to its unzipped state (./backups kept)
./setup.sh package                    write a clean zip of this folder next to it

Options: --install-packages  --with-demo  --debug  --yes
```

### Progress and debug output

Every run prints numbered steps (`[5/15] Dependencies`), a timestamped line for
each action, and a ✓ with the duration when each step finishes. The full
record goes to `runtime/logs/setup-<timestamp>.log`, or to
`/tmp/platform-setup-*.log` before that directory exists. The log never
contains passwords.

- `--debug` streams every command's output live.
- On failure, the script shows the step, the failing action, the last lines of
  output and the log path.
- After a fix, re-run the same command. Completed work is detected and skipped.

### What `install` does

| Step | What happens |
|---|---|
| 1. Validate | Checks `.env/`, the OS, systemd, the folder's location and port conflicts, and shows the plan. |
| 2. Packages | Installs PostgreSQL, PgBouncer and cloudflared from the OS repositories if they are missing, and downloads Node.js into `./runtime/node` after checking its checksum (only with `--install-packages`). |
| 3. Users and directories | Creates the system users `<slug>-{landing,platform,public,tenant,provisioner,pgbouncer,cloudflared}` and `./runtime/` with least-privilege modes. |
| 4. Secrets | Generates any missing secrets. Existing secrets are always reused. |
| 5. Dependencies | Makes the code read-only for the services and runs `npm ci` in place (skipped if the lockfile is unchanged). |
| 6. Edge | Provisions the Cloudflare tunnel, DNS and Turnstile, or configures the chosen mode. |
| 7. Build | Builds the backends and the four frontends with your brand and keys. |
| 8. PostgreSQL | `initdb` for a dedicated cluster on `127.0.0.1:POSTGRES_PORT`, managed by the `<slug>-postgresql` unit. |
| 9. Database | Creates `platform_db` and applies all migrations (checksummed ledger). Sets runtime role passwords as SCRAM verifiers, then applies platform settings: product name, public origin, reserved subdomains, default tier and integrations. |
| 10. PgBouncer | Three pools (platform, public, tenant) that share the SCRAM verifiers. |
| 11. Service config | Writes per-service environment files. |
| 12. Services | Starts all services and waits until each one answers. Upgrades existing tenant schemas. |
| 13. Owner | Creates the first platform owner (first install only). |
| 14. Timers | Enables the daily encrypted backup and the periodic health check. |
| 15. Demo | Adds 100 sample individuals and a `demo` tenant, provisioned through the real pipeline, with a one-time owner invitation link (only with `--with-demo`). |

### Upgrading

Copy the new code over the folder while keeping `.env/`, `runtime/` and
`backups/`. For example, unzip the new package somewhere else, then run:

```bash
sudo rsync -a --exclude .env --exclude runtime --exclude backups /tmp/new/ /opt/myplatform/
sudo ./setup.sh install
```

The upgrade:

- rebuilds only what changed
- applies new platform migrations
- upgrades every tenant schema
- restarts the services

Secrets, data, tenants and tenant PgBouncer entries are preserved. You can
also run tenant schema upgrades per tenant from the admin panel.

## 7. After installation

- **Create tenants:** *Platform console › Tenants › New*. The worker runs about
  20 steps: schema, role, grants, storage, domain and verification. The
  owner receives a one-time invitation link.
- **Configuration:** *Platform console › Configuration* controls features,
  limits, branding, tiers and integrations. Settings apply at the platform,
  plan or tenant level.
- **Bring-your-own storage or database:** tenants (or operators) add an
  S3-compatible bucket or an external PostgreSQL, run **Test** and then
  **Activate**. The worker relocates the data. By default everything stays
  on this server.
- **Operators:** invite additional operators from the console. Security-key
  step-up protects sensitive actions.

## 8. Backups and restore

`<slug>-backup.timer` runs `scripts/backup-platform-db.sh` on
`BACKUP_SCHEDULE`. Each backup is a single AES-256 encrypted archive,
`backups/platform-backup-<timestamp>.tar.gz.enc`, containing:

- the roles and a full database dump
- tenant credential files and the PgBouncer tenant auth file
- tenant storage (optional)
- a SHA-256 manifest

Backups older than `BACKUP_RETENTION_DAYS` are removed.

Decrypt a backup:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in platform-backup-<ts>.tar.gz.enc \
  -pass file:runtime/config/secrets/backup.key | tar -xz -C /tmp/restore
```

`scripts/validate-backup-restore.sh` restores a backup into a throwaway
cluster and verifies the tenant schemas and isolation. Run it regularly. See
`docs/operations/robustness-runbook.md` for the full recovery procedure.

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| `check` reports a busy port | Change the port in `setup.env`, or stop the other program. |
| `check` says service accounts cannot reach the folder | Move the folder to `/opt` or `/srv`, or make each listed parent traversable (`chmod o+x`). |
| `APP_SLUG ... is already installed from <other folder>` | Give this folder its own `APP_SLUG` and ports, or uninstall the other one from its own folder. |
| A service does not start | `sudo ./setup.sh logs <service>` or `journalctl -u <slug>-<service> -n 100` |
| Cloudflare step fails with DNS conflicts | Remove the listed records, or set `CLOUDFLARE_REPLACE_DNS=true`. |
| Tenant stuck in *provisioning* | Look at *Console › Tenants › job* for the failed step, then `logs provisioner`. Retry from the console. |
| Edge verification fails with `EDGE_MODE=none` | Keep `TENANT_EDGE_VERIFY=auto` (off without the Cloudflare API), or make sure your proxy serves the wildcard. |
| Lost owner password | `sudo ./setup.sh owner-password` |
| Start over from scratch | `sudo ./setup.sh uninstall --purge`, then `install` again. |
| Anything else | Re-run with `--debug`, and read the `runtime/logs/setup-*.log` of the failed run. |

## 10. Development and tests

```bash
./setup.sh test         # needs Node.js 22+ and PostgreSQL server binaries;
                        # runs npm ci and the backend build first if needed
./setup.sh package      # clean zip for distribution (see below)
```

The test harness (`scripts/with-test-cluster.sh`) creates a temporary cluster,
applies the migrations and provisions two fixture tenants (`alpha` and `beta`
on `sandbox.test`) through the real pipeline. It then runs the unit and
integration suites and removes everything afterwards.

### Packaging

`./setup.sh package` writes `../<folder>-<timestamp>.zip`, which contains
exactly what a new installation needs. It leaves out `runtime/`, `backups/`,
`node_modules/`, builds and logs, and every value in `.env/secrets.env` is
blanked. Your `.env/setup.env` decisions are kept. It works whether or not
the folder is installed, and it does not change the folder.
