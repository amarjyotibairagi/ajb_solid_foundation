# ADR-001: Tenancy isolation tiers, data placement, and scaling limits

- **Status:** Accepted and implemented (migrations 028–030)
- **Date:** 2026-09-29

## Context

Every B2B tenant has its own PostgreSQL schema and runtime role; requests run
under `SET LOCAL ROLE` with a transaction-bound `app.tenant_id` checked by
forced RLS. The original design also gave every tenant its own login role,
password, credential file and PgBouncer entry. PgBouncer pools are per
(database, user), so tenants could not share server connections:
`max_db_connections = 50` capped the number of tenants active at the same
moment at roughly fifty.

Some tenants also need their data or files outside the platform's host
(data residency, customer-controlled backups, existing cloud contracts).

## Decision

Two independent dimensions, both chosen per tenant and controlled from the
admin panel.

### 1. Connection tier (fixed at creation)

| Tier | Login | Isolation | Use for |
| --- | --- | --- | --- |
| `dedicated` (default) | Own login role, credential file, PgBouncer entry | Schema + runtime role + forced RLS + per-tenant credential | Regulated or high-value tenants |
| `pooled` | Shared `tenant_pool_login`, one PgBouncer pool | Schema + runtime role + forced RLS | Many small tenants |

A pooled tenant keeps its own schema and runtime role. The shared login holds
no privileges of its own: it is granted each pooled runtime role with
`SET TRUE, INHERIT FALSE` and switches into it per transaction. The trade-off
is explicit: whoever obtains the pool login's password can switch into any
pooled tenant's role, so the per-tenant credential boundary is gone for that
tier, while schema, role and RLS boundaries remain. The default comes from
`tenancy.default_connection_tier` (platform, then plan); operators may choose
per tenant at creation. The tier is immutable (enforced by trigger).

### 2. Data and file placement (changeable at any time)

| | Default | Bring-your-own |
| --- | --- | --- |
| Data | Schema on the VDS PostgreSQL | Dedicated schema in the tenant's PostgreSQL (13+) |
| Files | `STORAGE_ROOT/tenants/<key>/` on the VDS disk | Dedicated folder (prefix) in the tenant's S3-compatible bucket |

- Integrations are saved, **tested without side effects** (probe object or
  rolled-back transaction including a forced-RLS check), then activated. An
  activation requires a passing test of exactly the stored settings within 30
  minutes.
- Credentials are sealed with AES-256-GCM (`INTEGRATION_SECRET_KEY`) and bound
  to tenant, integration and kind.
- Outbound connections are resolved and pinned to addresses that pass the
  endpoint policy: private, loopback, link-local and metadata ranges are
  refused unless `integration.allow_private_endpoints` is on; plain HTTP and
  unencrypted PostgreSQL are refused unless `integration.allow_insecure_transport`
  is on.
- **Files** switch instantly: every object records the backend it was written
  to, so reads keep working; a `relocate_storage` job moves older objects.
- **Data** moves with a `relocate_database` job: maintenance mode (tenant BFF
  answers 503 except status reads), both sides upgraded to the latest schema,
  a consistent snapshot copied table by table with row-count verification,
  registry switched, the VDS copy purged, maintenance ends. A failure before
  the switch returns the tenant to its source untouched. Moving back to the
  VDS works the same way and never modifies the tenant's own database.
- On the tenant's database the platform's user owns the schema, so forced RLS
  (which applies to owners) is the enforcement; the connection test rejects
  users that bypass RLS (superusers, `BYPASSRLS`).

### 3. Horizontal scaling of BFFs

`SHARED_STATE_BACKEND=postgres` moves login throttles and request rate limits
into UNLOGGED counters in the `shared_state` schema, namespaced per database
identity. `TENANT_SESSION_SECRET` makes tenant CSRF tokens derivable from the
session, removing the per-process cache. With both set, any number of
processes per surface can run behind a load balancer.

### 4. Configuration propagation

Tenant BFFs cache resolved configuration for `TENANT_CONFIG_CACHE_TTL_MS`
(10 s). LISTEN/NOTIFY is not used because the registry connection goes through
a transaction-mode PgBouncer pool.

## Limits that remain

| Resource | Limit | Mitigation |
| --- | --- | --- |
| Dedicated tenants active at once | ~`max_db_connections` of the tenant PgBouncer pool | Use `pooled` for small tenants; raise pool limits with PostgreSQL `max_connections` |
| Catalog size | Every tenant adds ~17 tables with policies | Comfortable into the low thousands of schemas; fleet upgrades run per tenant |
| External-database tenants | One direct pool (max 2) per active tenant per BFF process | Bounded by the 100-pool LRU per process |
| Uploads | Buffered in memory, capped by `limit.storage.max_file_mb` | Keep the cap modest; streaming uploads are a future change |

## Consequences

- Modules stay tier- and placement-agnostic by using only `kit.withTenant()`
  and `kit.files`; code review should reject schema-qualified SQL in modules.
- Operators must register `tenant_pool_login` with the tenant PgBouncer and
  set `INTEGRATION_SECRET_KEY` on the platform, tenant and provisioner services
  before offering those features.
- Revisit when dedicated tenants routinely exceed ~40 concurrently active, or
  the schema count approaches 5,000.
