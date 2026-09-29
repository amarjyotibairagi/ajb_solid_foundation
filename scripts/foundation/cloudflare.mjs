#!/usr/bin/env node
// Provisions the public edge on Cloudflare for EDGE_MODE=cloudflare-api:
//   - a remotely-managed Cloudflare Tunnel whose ingress maps
//       ROOT_DOMAIN, www      -> landing origin
//       PLATFORM hostname     -> platform origin
//       PUBLIC hostname       -> public (B2C) origin
//       *.ROOT_DOMAIN         -> tenant origin
//   - proxied DNS CNAMEs for those hostnames pointing at the tunnel
//   - three Turnstile widgets (platform, public, tenant)
// Idempotent: re-running updates the same tunnel, records and widgets.
//
// Writes a JSON result (tunnel token, widget keys) to the file given as the
// first argument, mode 0600. Prints only non-secret progress.
//
// Existing DNS records that are not CNAMEs to this tunnel are left untouched
// and reported, unless CLOUDFLARE_REPLACE_DNS=true.

import fs from 'node:fs'
import Cloudflare from 'cloudflare'

const output = process.argv[2]
if (!output) {
  console.error('usage: cloudflare.mjs <result-file>')
  process.exit(2)
}
const need = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for EDGE_MODE=cloudflare-api.`)
  return value
}
const accountId = need('CLOUDFLARE_ACCOUNT_ID')
const zoneId = need('CLOUDFLARE_ZONE_ID')
const apiToken = need('CLOUDFLARE_API_TOKEN')
const rootDomain = need('ROOT_DOMAIN')
const slug = need('APP_SLUG')
const tunnelName = process.env.CLOUDFLARE_TUNNEL_NAME || slug
const platformHost = `${need('PLATFORM_SUBDOMAIN')}.${rootDomain}`
const publicHost = `${need('PUBLIC_SUBDOMAIN')}.${rootDomain}`
const replaceDns = process.env.CLOUDFLARE_REPLACE_DNS === 'true'
const port = (name) => Number(need(name))

const client = new Cloudflare({ apiToken })
const log = (message) => console.log(`[cloudflare] ${message}`)

const zone = await client.zones.get({ zone_id: zoneId })
if (zone.name !== rootDomain && !rootDomain.endsWith(`.${zone.name}`)) {
  throw new Error(`Zone ${zone.name} does not contain ROOT_DOMAIN ${rootDomain}. Check CLOUDFLARE_ZONE_ID.`)
}
log(`zone ${zone.name} verified`)

// --- Tunnel -------------------------------------------------------------------
let tunnel = null
for await (const candidate of client.zeroTrust.tunnels.cloudflared.list({ account_id: accountId, name: tunnelName, is_deleted: false })) {
  if (candidate.name === tunnelName) {
    tunnel = candidate
    break
  }
}
if (!tunnel) {
  tunnel = await client.zeroTrust.tunnels.cloudflared.create({ account_id: accountId, name: tunnelName, config_src: 'cloudflare' })
  log(`tunnel ${tunnelName} created (${tunnel.id})`)
} else {
  log(`tunnel ${tunnelName} found (${tunnel.id})`)
}
const origin = (name) => `http://127.0.0.1:${port(name)}`
await client.zeroTrust.tunnels.cloudflared.configurations.update(tunnel.id, {
  account_id: accountId,
  config: {
    ingress: [
      { hostname: rootDomain, service: origin('LANDING_PORT') },
      { hostname: `www.${rootDomain}`, service: origin('LANDING_PORT') },
      { hostname: platformHost, service: origin('PLATFORM_PORT') },
      { hostname: publicHost, service: origin('PUBLIC_PORT') },
      { hostname: `*.${rootDomain}`, service: origin('TENANT_PORT') },
      { service: 'http_status:404' },
    ],
  },
})
log('tunnel ingress configured (apex, www, platform, public, wildcard tenants)')
const tunnelToken = await client.zeroTrust.tunnels.cloudflared.token.get(tunnel.id, { account_id: accountId })
const target = `${tunnel.id}.cfargotunnel.com`

// --- DNS ----------------------------------------------------------------------
const conflicts = []
for (const hostname of [rootDomain, `www.${rootDomain}`, platformHost, publicHost, `*.${rootDomain}`]) {
  const existing = []
  for await (const record of client.dns.records.list({ zone_id: zoneId, name: { exact: hostname }, per_page: 100 })) {
    if (record.name === hostname) existing.push(record)
  }
  const params = { zone_id: zoneId, type: 'CNAME', name: hostname, content: target, proxied: true, ttl: 1 }
  const current = existing.find((record) => record.type === 'CNAME')
  const others = existing.filter((record) => record.type !== 'CNAME')
  if (others.length && !replaceDns) {
    conflicts.push(`${hostname} (${others.map((record) => record.type).join(', ')})`)
    continue
  }
  for (const record of others) {
    await client.dns.records.delete(record.id, { zone_id: zoneId })
    log(`removed ${record.type} record for ${hostname}`)
  }
  if (current) {
    if (current.content !== target || !current.proxied) {
      await client.dns.records.update(current.id, params)
      log(`DNS ${hostname} updated -> tunnel`)
    } else {
      log(`DNS ${hostname} already points at the tunnel`)
    }
  } else {
    await client.dns.records.create(params)
    log(`DNS ${hostname} created -> tunnel`)
  }
}
if (conflicts.length) {
  throw new Error(
    `Existing DNS records block these hostnames: ${conflicts.join('; ')}. ` +
      'Remove them in the Cloudflare dashboard, or re-run with CLOUDFLARE_REPLACE_DNS=true to replace them.',
  )
}

// --- Turnstile ------------------------------------------------------------------
async function upsertWidget(name, domains) {
  let widget = null
  for await (const candidate of client.turnstile.widgets.list({ account_id: accountId, filter: `name:${name}`, per_page: 50 })) {
    if (candidate.name === name) {
      widget = candidate
      break
    }
  }
  const params = { account_id: accountId, name, domains, mode: 'managed', clearance_level: 'no_clearance' }
  widget = widget ? await client.turnstile.widgets.update(widget.sitekey, params) : await client.turnstile.widgets.create(params)
  log(`Turnstile widget ${name} ready`)
  return { siteKey: widget.sitekey, secretKey: widget.secret }
}
const widgets = {
  platform: await upsertWidget(`${slug}-platform`, [platformHost]),
  public: await upsertWidget(`${slug}-public`, [publicHost]),
  // A widget domain also covers its subdomains, so one widget serves every tenant.
  tenant: await upsertWidget(`${slug}-tenant`, [rootDomain]),
}

const result = { tunnelId: tunnel.id, tunnelName, tunnelToken, widgets }
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
fs.chmodSync(output, 0o600)
log(`done; credentials written to ${output}`)
