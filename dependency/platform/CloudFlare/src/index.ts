import Cloudflare from 'cloudflare'

export { default as Cloudflare } from 'cloudflare'
export * from 'cloudflare'

export type CloudflareClient = InstanceType<typeof Cloudflare>
export type CloudflareClientOptions = ConstructorParameters<typeof Cloudflare>[0]
export type CloudflareDnsRecordCreateParams = Parameters<CloudflareClient['dns']['records']['create']>[0]

export function createCloudflareClient(
  options?: CloudflareClientOptions,
): CloudflareClient {
  return new Cloudflare(options)
}
