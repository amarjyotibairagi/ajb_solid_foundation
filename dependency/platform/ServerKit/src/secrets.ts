import crypto from 'node:crypto'

/**
 * Authenticated encryption for integration credentials at rest
 * (AES-256-GCM). The key comes from INTEGRATION_SECRET_KEY: 32 random bytes,
 * base64 encoded, identical for every service that reads or writes tenant
 * integrations (platform BFF, tenant BFF, provisioner).
 *
 * Every ciphertext is bound to additional authenticated data (tenant id,
 * integration id, kind). A ciphertext copied onto another tenant's row fails
 * to decrypt instead of granting that tenant someone else's credentials.
 */
export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  static fromEnvironment(variable = 'INTEGRATION_SECRET_KEY'): SecretBox | null {
    const raw = process.env[variable]?.trim()
    if (!raw) return null
    return SecretBox.fromBase64(raw)
  }

  static fromBase64(value: string): SecretBox {
    const key = Buffer.from(value, 'base64')
    if (key.length !== 32) throw new Error('INTEGRATION_SECRET_KEY must be 32 bytes, base64 encoded.')
    return new SecretBox(key)
  }

  seal(plaintext: string, associatedData: string): string {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(associatedData, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.')
  }

  open(sealed: string, associatedData: string): string {
    const [version, iv, tag, ciphertext] = sealed.split('.')
    if (version !== 'v1' || !iv || !tag || ciphertext === undefined) throw new Error('Unsupported secret format.')
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
    decipher.setAAD(Buffer.from(associatedData, 'utf8'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8')
  }
}

export function integrationSecretAad(tenantId: string, integrationId: string, kind: string): string {
  return `tenant-integration:v1:${tenantId}:${integrationId}:${kind}`
}

/** Deterministic JSON (sorted keys) for fingerprints and comparisons. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
