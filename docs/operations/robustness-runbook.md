# Production Robustness Runbook

This runbook covers an installation made by `setup.sh`. The platform is
installed in place, in the folder that holds `setup.sh` (written `<folder>`
below, for example `/opt/myplatform`). `<slug>` is `APP_SLUG` from
`.env/setup.env`.

| Path | Contents |
|---|---|
| `<folder>` | Code, run in place (plus `node_modules` and builds after install) |
| `<folder>/runtime/config` | `install.env`; `secrets/` (root only); `env/` (service environments, root only); `pgbouncer/` |
| `<folder>/runtime/data` | The PostgreSQL cluster, tenant credentials and tenant storage |
| `<folder>/runtime/logs` | Installer logs (service logs are in the journal) |
| `<folder>/runtime/node` | Node.js, when the installer downloaded it |
| `<folder>/backups` | Encrypted backups (or `BACKUP_DIR` if set) |

`sudo ./setup.sh status` gives a one-screen summary of everything below.

## Connection Map

All origins and databases listen on loopback only. The public edge is the
Cloudflare Tunnel (`<slug>-cloudflared`) or your reverse proxy
(`EDGE_MODE=none`).

| Interface | Origin | PgBouncer | Database |
| --- | --- | --- | --- |
| Landing | `127.0.0.1:3651` | n/a | n/a |
| Platform | `127.0.0.1:3656` | `127.0.0.1:3658` | PostgreSQL `127.0.0.1:5433` |
| Public | `127.0.0.1:3657` | `127.0.0.1:3659` | PostgreSQL `127.0.0.1:5433` |
| Tenant | `127.0.0.1:6355` | `127.0.0.1:6360` | PostgreSQL `127.0.0.1:5433` |

The PgBouncer server caps are 20 platform, 20 public and 60 tenant
connections. The provisioning worker opens at most 4 direct connections. The
total stays below PostgreSQL's default of 100 connections. Raise
`max_connections` in `<folder>/runtime/data/postgres/<ver>/conf.d/platform.conf` before you
raise any pool cap in `<folder>/runtime/config/pgbouncer/*.ini`.

systemd units:

- `<slug>-postgresql`
- `<slug>-pgbouncer@{platform,public,tenant}`
- `<slug>-{landing,platform,public,tenant,provisioner}`
- `<slug>-cloudflared`
- `<slug>-backup.timer`
- `<slug>-healthcheck.timer`

## Deployment (upgrades)

1. On a development machine, build and verify:

   ```bash
   npm ci
   npm run build:server-kit && npm run build:cloudflare && npm run build:drizzle && npm run build:backend
   npm run typecheck
   ./setup.sh test          # disposable cluster; never the live one
   ```

   `./setup.sh test` runs the suite against a throwaway PostgreSQL cluster. It
   is created with `initdb` on a free port and destroyed on exit
   (`scripts/with-test-cluster.sh`). Never point the integration suite at a
   live cluster: it creates and deletes tenants and platform accounts.

2. On the server, copy the new code over the folder. Keep `.env/`,
   `runtime/` and `backups/`; for example, unzip the new package elsewhere and
   `rsync -a --exclude .env --exclude runtime --exclude backups new/ <folder>/`.
   Then run:

   ```bash
   sudo ./setup.sh install
   ```

   This performs the following:

   - copies the code
   - rebuilds
   - applies pending platform migrations
   - upgrades tenant schemas
   - restarts each origin; its `ExecStartPost` readiness probe must pass
   - runs the health check

   The tunnel is not restarted for ordinary deployments.

3. Manual migration commands, run from `<folder>` as root:

   ```bash
   export PATH="$PWD/runtime/node/bin:$PATH"     # when Node.js was installed by setup.sh
   export DATABASE_ADMIN_URL="postgresql://postgres@/platform_db?host=/run/<slug>-postgresql&port=5433"
   runuser -u postgres -- env DATABASE_ADMIN_URL="$DATABASE_ADMIN_URL" node scripts/platform-migrate.mjs            # dry run
   runuser -u postgres -- env DATABASE_ADMIN_URL="$DATABASE_ADMIN_URL" node scripts/platform-migrate.mjs --verify   # non-zero unless in sync
   set -a; . <folder>/runtime/config/env/provisioner.env; set +a
   node scripts/migrate-tenants.mjs --apply
   ```

   Order and identity come from `database/migrations/manifest.json`. Every
   applied file's SHA-256 is recorded in `platform.schema_migration`, and
   editing an already-applied file is a hard error. To change applied SQL, add
   a new migration and append it to the manifest. Tenant schema upgrades can
   also be started per tenant from the admin panel.

4. Reconcile the tenant control plane:

   ```bash
   set -a; . <folder>/runtime/config/env/provisioner.env; set +a
   node scripts/reconcile-tenants.mjs                                   # report
   node scripts/reconcile-tenants.mjs --repair                          # registry-only fixes
   node scripts/reconcile-tenants.mjs --repair --reap-orphans --reap-failed
   node scripts/reconcile-tenants.mjs --verify                          # non-zero exit on drift
   ```

   The reconciler compares four stores that must agree:

   - the registry
   - the PostgreSQL catalog
   - `<folder>/runtime/data/tenant-credentials/`
   - the PgBouncer tenant auth file

   It never drops anything itself. Orphaned resources go to the audited
   deprovisioning pipeline, which the provisioner worker then executes.

5. Change a setting that lives in `.env/setup.env` (ports, domain, edge mode)
   by editing it and re-running `sudo ./setup.sh install`. Change platform
   behaviour (features, limits, tiers, integrations, origins) in the admin
   panel instead.

## Pool Exhaustion

Use the root-only PgBouncer statistics credential:

```bash
set -a; . <folder>/runtime/config/secrets/pgbouncer-stats.env; set +a
PGPASSWORD="$PGBOUNCER_STATS_PASSWORD" psql -h 127.0.0.1 -p 6360 \
  -U pgbouncer_stats -d pgbouncer -c 'show pools'
```

Check these:

- `cl_waiting`
- PostgreSQL `pg_stat_activity`
- origin response latency
- the service journal (`sudo ./setup.sh logs tenant`)

Do not increase pool sizes before reconciling the total against PostgreSQL
`max_connections`.

## Provisioning Recovery

The worker heartbeats `locked_at` every 15 seconds. It reclaims a `running`
job after a two-minute stale lease. Inspect jobs:

```bash
runuser -u postgres -- psql -h /run/<slug>-postgresql -p 5433 -d platform_db
```

```sql
select job_id, tenant_id, status, current_step, worker_id, locked_at, safe_error_message
from platform.tenant_provisioning_job
where status in ('running', 'retrying', 'failed')
order by updated_at desc;
```

After a worker interruption, confirm that the same job ID resumes from its
persisted step and reaches `active`. Never mark a tenant active by hand.
Activation happens only after the database identity, cross-schema denial,
hostname and login-role checks all pass.

The database enforces this. A row cannot move to `active` unless its schema
and login role exist. It cannot move to `deleted` while its schema or roles
still exist.

To remove a tenant, always go through the pipeline (suspend, then
deprovision) or run `reconcile-tenants.mjs --repair --reap-orphans`. Never run
`UPDATE ... set lifecycle_status = 'deleted'` by hand.

## Platform Operator Accounts

Platform passwords are argon2id hashes computed in the BFF process. The
database never sees a plaintext password, and a CHECK constraint enforces the
hash format.

```bash
sudo ./setup.sh owner-password                     # new password for OWNER_USERNAME
cd <folder>
export PATH="$PWD/runtime/node/bin:$PATH"
export DATABASE_ADMIN_URL="postgresql://postgres@/platform_db?host=/run/<slug>-postgresql&port=5433"
runuser -u postgres -- env DATABASE_ADMIN_URL="$DATABASE_ADMIN_URL" node scripts/platform-operator.mjs list-operators
runuser -u postgres -- env DATABASE_ADMIN_URL="$DATABASE_ADMIN_URL" node scripts/platform-operator.mjs audit-hashes
runuser -u postgres -- env DATABASE_ADMIN_URL="$DATABASE_ADMIN_URL" node scripts/platform-operator.mjs set-password --username <name> --generate
```

Commands never take passwords as arguments, because argv is world-readable on
the host. Use `--generate` (the password is printed once) or
`--password-fd <fd>`. Changing a password revokes every session for that
account. Invite further operators from the admin panel.

## Tunnel Failure

```bash
systemctl status <slug>-cloudflared --no-pager
journalctl -u <slug>-cloudflared --since '-10 minutes'
```

The expected ingress order is:

1. apex and `www` → landing `3651`
2. platform → `3656`
3. user → `3657`
4. wildcard tenant → `6355`
5. `http_status:404`

With `EDGE_MODE=cloudflare-api`, re-running `sudo ./setup.sh install`
re-applies the ingress, DNS and Turnstile configuration. A connector restart
can return 502 briefly until its connections register. The health check
retries during this window.

## Backup And Disaster Recovery

### Targets

- **Recovery Point Objective (RPO)**: 24 hours or less, through daily automated encrypted backups. Add WAL archiving to reach 15 minutes or less.
- **Recovery Time Objective (RTO)**: 15 minutes or less to restore roles, the database, tenant schemas and RLS policies in a new cluster, and to verify tenant isolation.

### Backup Architecture

`<slug>-backup.timer` runs `scripts/backup-platform-db.sh` on
`BACKUP_SCHEDULE`. The encrypted archive contains:

1. A complete platform database dump (`pg_dump -Fc`).
2. Global cluster roles and security attributes (`pg_dumpall --globals-only`).
3. Tenant credential files.
4. The PgBouncer tenant authentication file.
5. Tenant storage, when `BACKUP_INCLUDE_STORAGE=true`.
6. A SHA-256 manifest of file digests, plus metadata: the PostgreSQL version, platform migrations and tenant registry.

The package is encrypted with AES-256-CBC
(`openssl enc -aes-256-cbc -pbkdf2 -iter 100000`). The key is
`<folder>/runtime/config/secrets/backup.key`, outside the backup directory. **Keep a copy
of this key off the server.** Plaintext staging files are removed when the
backup completes.

```bash
sudo ./setup.sh backup                     # immediate backup
```

Copy `<folder>/backups` to off-host storage (for example with rclone or
restic on its own timer).

### Restore Drill

`scripts/validate-backup-restore.sh` does the following:

1. Decrypts a backup into a temporary directory.
2. Verifies every file against the manifest.
3. Initialises a **fresh disposable PostgreSQL cluster** on an isolated loopback port. The source database is never touched.
4. Restores roles and the database. Ownership is preserved exactly (no `--no-owner`).
5. Verifies the following:
   - roles and their security attributes
   - ownership of schemas and tables
   - FORCE RLS
   - helper ACLs
   - the platform and tenant migration ledgers
   - cross-tenant isolation
6. Removes the disposable cluster.

Run it regularly, for example weekly from a timer:

```bash
set -a; . <folder>/runtime/config/env/backup.env; set +a
bash <folder>/scripts/validate-backup-restore.sh
```

### Operational Alerting

Alert if any of the following occurs:

1. `<slug>-backup.service` exits with a nonzero status.
2. `<slug>-healthcheck.service` exits with a nonzero status. It checks the services, local and public probes, the PgBouncer pools, stale provisioning jobs and backup age.
3. The newest backup in `<folder>/backups` is older than 26 hours.
4. Off-host backup synchronisation fails.
