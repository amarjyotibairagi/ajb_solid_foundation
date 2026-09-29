import dns from 'node:dns/promises'
import net from 'node:net'

/**
 * Outbound connection policy for tenant-supplied endpoints (bring-your-own
 * storage and databases). Without it, a tenant could point "their" database
 * at 127.0.0.1:5433 or a cloud metadata address and use the platform as a
 * proxy into the host network (SSRF).
 *
 * Every address a hostname resolves to must be public unless the platform
 * explicitly allows private endpoints (integration.allow_private_endpoints).
 * Callers connect to the returned, already-validated address so a second DNS
 * answer cannot swap in a private one (DNS rebinding).
 */
export type EndpointPolicy = {
  allowPrivateEndpoints: boolean
  allowInsecureTransport: boolean
}

export class EndpointPolicyError extends Error {}

const blockedV4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

function ipv4ToInt(address: string): number {
  return address.split('.').reduce((total, octet) => (total << 8) + Number(octet), 0) >>> 0
}

function inV4Range(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(base) & mask)
}

export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) return blockedV4.some(([base, bits]) => inV4Range(address, base, bits))
  if (!net.isIPv6(address)) return true
  const lower = address.toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped?.[1]) return isPrivateAddress(mapped[1])
  if (lower === '::' || lower === '::1') return true
  const first = parseInt(lower.split(':')[0] || '0', 16)
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return true // multicast
  if (lower.startsWith('64:ff9b:') || lower.startsWith('2001:db8:')) return true
  return false
}

export async function resolveAllowedAddress(
  hostname: string,
  policy: EndpointPolicy,
): Promise<{ address: string; family: 4 | 6 }> {
  const host = hostname.replace(/^\[|\]$/g, '')
  const answers = net.isIP(host)
    ? [{ address: host, family: net.isIPv6(host) ? 6 : 4 }]
    : await dns.lookup(host, { all: true, verbatim: true }).catch(() => {
        throw new EndpointPolicyError(`Could not resolve ${hostname}.`)
      })
  if (!answers.length) throw new EndpointPolicyError(`Could not resolve ${hostname}.`)
  if (!policy.allowPrivateEndpoints) {
    const privateAnswer = answers.find((answer) => isPrivateAddress(answer.address))
    if (privateAnswer) {
      throw new EndpointPolicyError(
        `${hostname} resolves to a private or reserved address (${privateAnswer.address}). ` +
          'Private endpoints are disabled by the platform.',
      )
    }
  }
  const chosen = answers[0]!
  return { address: chosen.address, family: chosen.family === 6 ? 6 : 4 }
}
