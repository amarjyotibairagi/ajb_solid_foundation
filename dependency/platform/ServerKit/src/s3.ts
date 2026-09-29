import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import type { Readable } from 'node:stream'
import { EndpointPolicyError, resolveAllowedAddress, type EndpointPolicy } from './network.js'

/**
 * Minimal S3-compatible client (AWS S3, MinIO, Cloudflare R2, Wasabi,
 * Backblaze B2, DigitalOcean Spaces, Ceph RGW, ...). Signature V4 with a
 * signed payload hash, path-style or virtual-hosted addressing. Connections
 * are pinned to an address validated by the endpoint policy.
 */
export type S3Settings = {
  endpoint: string
  region: string
  bucket: string
  prefix: string
  forcePathStyle: boolean
}

export type S3Credentials = { accessKeyId: string; secretAccessKey: string }

export class S3Error extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) {
    super(message)
  }
}

const sha256Hex = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex')
const hmac = (key: Buffer | string, data: string) => crypto.createHmac('sha256', key).update(data, 'utf8').digest()

export function uriEncode(value: string, keepSlash: boolean): string {
  let out = ''
  for (const byte of Buffer.from(value, 'utf8')) {
    const char = String.fromCharCode(byte)
    if (/[A-Za-z0-9\-_.~]/.test(char) || (keepSlash && char === '/')) out += char
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

export type SignInput = {
  method: string
  host: string
  path: string
  query?: Record<string, string>
  headers?: Record<string, string>
  payloadHash: string
  region: string
  credentials: S3Credentials
  date: Date
}

/** Returns the headers to send, including Authorization (AWS Signature V4, service s3). */
export function signS3Request(input: SignInput): Record<string, string> {
  const amzDate = input.date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const shortDate = amzDate.slice(0, 8)
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers || {}).map(([key, value]) => [key.toLowerCase(), value])),
    host: input.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate,
  }
  const signedHeaderNames = Object.keys(headers).sort()
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, ' ')}\n`).join('')
  const canonicalQuery = Object.entries(input.query || {})
    .map(([key, value]) => [uriEncode(key, false), uriEncode(value, false)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  const canonicalRequest = [
    input.method,
    uriEncode(input.path, true),
    canonicalQuery,
    canonicalHeaders,
    signedHeaderNames.join(';'),
    input.payloadHash,
  ].join('\n')
  const scope = `${shortDate}/${input.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, shortDate), input.region), 's3'), 'aws4_request')
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`
  return headers
}

type RawResponse = { statusCode: number; headers: http.IncomingHttpHeaders; body: Readable }

export class S3Client {
  private readonly endpoint: URL

  constructor(
    private readonly settings: S3Settings,
    private readonly credentials: S3Credentials,
    private readonly policy: EndpointPolicy,
    private readonly timeoutMs = 20_000,
  ) {
    this.endpoint = new URL(settings.endpoint)
    if (this.endpoint.protocol !== 'https:' && !(this.endpoint.protocol === 'http:' && policy.allowInsecureTransport)) {
      throw new EndpointPolicyError('Storage endpoints must use https.')
    }
  }

  /** Full object key inside the bucket, under the tenant's folder (prefix). */
  fullKey(key: string): string {
    return `${this.settings.prefix}${key}`
  }

  private target(key: string | null): { host: string; path: string } {
    const port = this.endpoint.port ? `:${this.endpoint.port}` : ''
    const objectPath = key === null ? '' : `/${key}`
    if (this.settings.forcePathStyle) {
      return { host: `${this.endpoint.hostname}${port}`, path: `/${this.settings.bucket}${objectPath || '/'}` }
    }
    return { host: `${this.settings.bucket}.${this.endpoint.hostname}${port}`, path: objectPath || '/' }
  }

  private async send(
    method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
    key: string | null,
    options: { query?: Record<string, string>; body?: Buffer; headers?: Record<string, string> } = {},
  ): Promise<RawResponse> {
    const { host, path } = this.target(key)
    const hostname = host.replace(/:\d+$/, '')
    const pinned = await resolveAllowedAddress(hostname, this.policy)
    const body = options.body ?? Buffer.alloc(0)
    const signed = signS3Request({
      method,
      host,
      path,
      ...(options.query ? { query: options.query } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      payloadHash: sha256Hex(body),
      region: this.settings.region,
      credentials: this.credentials,
      date: new Date(),
    })
    const query = Object.entries(options.query || {})
      .map(([name, value]) => `${uriEncode(name, false)}=${uriEncode(value, false)}`)
      .join('&')
    const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
      if ((lookupOptions as { all?: boolean }).all) {
        ;(callback as unknown as (error: null, addresses: Array<{ address: string; family: number }>) => void)(null, [pinned])
      } else {
        callback(null, pinned.address, pinned.family)
      }
    }
    const transport = this.endpoint.protocol === 'https:' ? https : http
    return new Promise<RawResponse>((resolve, reject) => {
      const request = transport.request(
        {
          method,
          hostname,
          port: this.endpoint.port || (this.endpoint.protocol === 'https:' ? 443 : 80),
          path: `${uriEncode(path, true)}${query ? `?${query}` : ''}`,
          headers: { ...signed, 'content-length': String(body.length) },
          lookup,
          timeout: this.timeoutMs,
          servername: hostname,
        },
        (response) => resolve({ statusCode: response.statusCode || 0, headers: response.headers, body: response }),
      )
      request.on('timeout', () => request.destroy(new Error(`Storage endpoint timed out after ${this.timeoutMs} ms.`)))
      request.on('error', reject)
      request.end(body)
    })
  }

  private static async readAll(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return Buffer.concat(chunks)
  }

  private static async fail(response: RawResponse): Promise<never> {
    const text = (await S3Client.readAll(response.body)).toString('utf8')
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] || `HTTP${response.statusCode}`
    const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1] || `Storage request failed with HTTP ${response.statusCode}.`
    throw new S3Error(`${code}: ${message}`, response.statusCode, code)
  }

  async putObject(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    const response = await this.send('PUT', this.fullKey(key), { body, headers: { 'content-type': contentType } })
    if (response.statusCode >= 300) await S3Client.fail(response)
    response.body.resume()
  }

  async getObject(key: string): Promise<{ body: Readable; contentType: string | null; contentLength: number | null }> {
    const response = await this.send('GET', this.fullKey(key))
    if (response.statusCode >= 300) await S3Client.fail(response)
    const length = response.headers['content-length']
    return {
      body: response.body,
      contentType: (response.headers['content-type'] as string | undefined) ?? null,
      contentLength: length ? Number(length) : null,
    }
  }

  async headObject(key: string): Promise<{ size: number } | null> {
    const response = await this.send('HEAD', this.fullKey(key))
    response.body.resume()
    if (response.statusCode === 404) return null
    if (response.statusCode >= 300) throw new S3Error(`HEAD failed with HTTP ${response.statusCode}.`, response.statusCode, `HTTP${response.statusCode}`)
    return { size: Number(response.headers['content-length'] || 0) }
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.send('DELETE', this.fullKey(key))
    if (response.statusCode >= 300 && response.statusCode !== 404) await S3Client.fail(response)
    response.body.resume()
  }

  /** Lists keys (relative to the tenant folder) under a sub-prefix. */
  async listKeys(subPrefix = '', maxKeys = 100): Promise<string[]> {
    const response = await this.send('GET', null, {
      query: { 'list-type': '2', prefix: this.fullKey(subPrefix), 'max-keys': String(maxKeys) },
    })
    if (response.statusCode >= 300) await S3Client.fail(response)
    const xml = (await S3Client.readAll(response.body)).toString('utf8')
    return [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)]
      .map((match) => decodeXml(match[1] || ''))
      .map((key) => key.slice(this.settings.prefix.length))
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
