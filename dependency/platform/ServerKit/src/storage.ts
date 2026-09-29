import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, stat, unlink, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { EndpointPolicy } from './network.js'
import { S3Client, type S3Credentials, type S3Settings } from './s3.js'

/**
 * Object storage used by the foundation's file service and by modules.
 * `vds` (the default) keeps objects on the host's own disk; an S3-compatible
 * bucket is used when the tenant brings its own storage. Keys are relative to
 * the tenant's area: a directory per tenant locally, a folder (prefix) in a
 * bucket otherwise.
 */
export interface ObjectStore {
  readonly kind: 'vds' | 's3'
  put(key: string, body: Buffer, contentType: string): Promise<void>
  get(key: string): Promise<{ body: Readable; contentType: string | null; contentLength: number | null }>
  head(key: string): Promise<{ size: number } | null>
  delete(key: string): Promise<void>
  list(subPrefix?: string, maxKeys?: number): Promise<string[]>
}

const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,511}$/

export function assertObjectKey(key: string): string {
  if (!keyPattern.test(key) || key.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    throw new Error('Invalid object key.')
  }
  return key
}

export class LocalObjectStore implements ObjectStore {
  readonly kind = 'vds' as const

  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    const target = path.resolve(this.root, assertObjectKey(key))
    const relative = path.relative(this.root, target)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid object key.')
    return target
  }

  async put(key: string, body: Buffer): Promise<void> {
    const target = this.resolve(key)
    await mkdir(path.dirname(target), { recursive: true, mode: 0o770 })
    const temporary = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`
    const handle = await open(temporary, 'wx', 0o660)
    try {
      await handle.writeFile(body)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
  }

  async get(key: string) {
    const target = this.resolve(key)
    const info = await stat(target)
    return { body: createReadStream(target), contentType: null, contentLength: info.size }
  }

  async head(key: string) {
    try {
      return { size: (await stat(this.resolve(key))).size }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    await unlink(this.resolve(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }

  async list(subPrefix = '', maxKeys = 100): Promise<string[]> {
    const directory = subPrefix ? this.resolve(subPrefix.replace(/\/+$/, '')) : this.root
    const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => [])
    return entries
      .filter((entry) => entry.isFile() && !entry.name.endsWith('.tmp'))
      .map((entry) => path.relative(this.root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .slice(0, maxKeys)
  }
}

export class S3ObjectStore implements ObjectStore {
  readonly kind = 's3' as const
  private readonly client: S3Client

  constructor(settings: S3Settings, credentials: S3Credentials, policy: EndpointPolicy) {
    this.client = new S3Client(settings, credentials, policy)
  }

  put(key: string, body: Buffer, contentType: string) {
    return this.client.putObject(assertObjectKey(key), body, contentType)
  }

  get(key: string) {
    return this.client.getObject(assertObjectKey(key))
  }

  head(key: string) {
    return this.client.headObject(assertObjectKey(key))
  }

  delete(key: string) {
    return this.client.deleteObject(assertObjectKey(key))
  }

  list(subPrefix = '', maxKeys = 100) {
    return this.client.listKeys(subPrefix, maxKeys)
  }
}

/** Root directory for VDS-local object storage of one tenant. */
export function localTenantStorageRoot(storageRoot: string, tenantKey: string): string {
  if (!/^T[A-Z0-9]{4,63}$/.test(tenantKey)) throw new Error('Invalid tenant key for storage.')
  return path.join(storageRoot, 'tenants', tenantKey)
}
