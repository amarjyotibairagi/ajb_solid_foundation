# ajb_solid_foundation
Self-installing multi-tenant SaaS foundation. Unzip, set .env, run setup.sh: builds PostgreSQL (schema-per-tenant, forced RLS), PgBouncer, admin console, B2C app, tenant workspaces, provisioning worker, encrypted backups and health checks in place under systemd. Optional Cloudflare Tunnel, BYO S3/Postgres per tenant. Clean uninstall.
