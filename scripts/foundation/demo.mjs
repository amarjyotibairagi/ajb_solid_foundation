#!/usr/bin/env node
// Adds a demo tenant through the real provisioning pipeline and prints the
// owner's one-time invitation link. Run by `setup.sh demo` (or install
// --with-demo) with the platform service environment loaded; the provisioning
// worker service must be running.
//
// Environment: DATABASE_URL (platform runtime), TENANT_ROOT_DOMAIN,
// DEMO_SUBDOMAIN (default "demo"), DEMO_OWNER_EMAIL, DEMO_ACTOR (operator
// username that "creates" the tenant).

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const { createTenantProvisioningJob } = await import(path.join(root, 'backend/dist/tenant-provisioning.js'))
const { issueOwnerInvitation } = await import(path.join(root, 'backend/dist/admin-routes.js'))
const { NotificationSender } = await import('@skeleton/server-kit')

const rootDomain = process.env.TENANT_ROOT_DOMAIN
const subdomain = process.env.DEMO_SUBDOMAIN || 'demo'
const ownerEmail = process.env.DEMO_OWNER_EMAIL || `owner@${subdomain}.${rootDomain}`
const actorName = process.env.DEMO_ACTOR
if (!process.env.DATABASE_URL || !rootDomain || !actorName) {
  throw new Error('DATABASE_URL, TENANT_ROOT_DOMAIN and DEMO_ACTOR are required.')
}
const log = (message) => console.log(`[demo] ${message}`)

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
try {
  const actor = (await pool.query('select id::text from platform.platform_user where username = $1', [actorName])).rows[0]
  if (!actor) throw new Error(`Operator ${actorName} not found.`)

  let tenantKey = (await pool.query(
    `select t.tenant_key from platform.tenant_registry t join platform.tenant_domain d on d.tenant_id = t.tenant_id
      where d.subdomain = $1 and t.lifecycle_status <> 'deleted'`,
    [subdomain],
  )).rows[0]?.tenant_key
  if (tenantKey) {
    log(`demo tenant ${subdomain}.${rootDomain} already exists (${tenantKey}); issuing a fresh owner invitation`)
  } else {
    // Same default the admin panel applies: the platform setting, else the definition default.
    const tier = (await pool.query(
      `select coalesce(
         (select value #>> '{}' from platform.config_value
           where scope_type = 'platform' and config_key = 'tenancy.default_connection_tier'),
         (select default_value #>> '{}' from platform.config_definition
           where config_key = 'tenancy.default_connection_tier')) as tier`,
    )).rows[0]?.tier === 'pooled' ? 'pooled' : 'dedicated'
    const created = await createTenantProvisioningJob(
      pool,
      {
        displayName: 'Demo Organization',
        legalName: 'Demo Organization',
        subdomain,
        region: 'global',
        locale: 'en',
        primaryColor: '#2563eb',
        secondaryColor: '#0f172a',
        loginMessage: 'Sign in to the demo workspace.',
        connectionTier: tier,
      },
      actor.id,
      rootDomain,
    )
    tenantKey = created.tenant.tenantId
    log(`provisioning ${subdomain}.${rootDomain} (${tenantKey}, ${tier} tier); waiting for the worker...`)
    const started = Date.now()
    for (;;) {
      const job = (await pool.query(
        'select status, current_step, safe_error_message from platform.tenant_provisioning_job where job_id = $1',
        [created.jobId],
      )).rows[0]
      if (job.status === 'succeeded') break
      if (job.status === 'failed') throw new Error(`Provisioning failed at ${job.current_step}: ${job.safe_error_message}`)
      if (Date.now() - started > 180_000) throw new Error(`Provisioning still running after 3 minutes (step ${job.current_step}).`)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    log(`tenant active after ${Math.round((Date.now() - started) / 1000)}s`)
  }

  const invitation = await issueOwnerInvitation(
    { pool, notifier: new NotificationSender(), tenantRootDomain: rootDomain },
    tenantKey,
    { email: ownerEmail, displayName: 'Demo Owner' },
    actor.id,
    72,
  )
  console.log('')
  console.log(`  Demo workspace:          https://${subdomain}.${rootDomain}`)
  console.log(`  Owner invitation (once): ${invitation.link}`)
  console.log('  Open the link, choose a username and password, then sign in.')
  console.log('')
} finally {
  await pool.end()
}
