import { createHash, randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { Readable } from 'node:stream'
import { z } from 'zod'
import { configInteger, objectKeyFor } from '@skeleton/server-kit'
import type { TenantStorage } from '../tenant-storage.js'
import type { TenantModule, TenantRequestKit } from './types.js'

export type StoredFile = {
  id: string
  fileName: string
  contentType: string
  sizeBytes: number
  sha256: string
  storage: 'vds' | 'external'
  moduleCode: string | null
  createdAt: string
}

export class FileLimitError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
  }
}

type Row = {
  object_id: string
  storage_ref: string
  object_key: string
  file_name: string
  content_type: string
  size_bytes: string
  sha256: string
  module_code: string | null
  created_at: Date
}

const toFile = (row: Row): StoredFile => ({
  id: row.object_id,
  fileName: row.file_name,
  contentType: row.content_type,
  sizeBytes: Number(row.size_bytes),
  sha256: row.sha256,
  storage: row.storage_ref === 'vds' ? 'vds' : 'external',
  moduleCode: row.module_code,
  createdAt: new Date(row.created_at).toISOString(),
})

const contentTypePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(;\s*charset=[a-z0-9_-]+)?$/i

export interface FileService {
  save(
    request: FastifyRequest,
    input: { fileName: string; contentType: string; body: Buffer; createdBy: string | null; moduleCode?: string | null },
  ): Promise<StoredFile>
  open(request: FastifyRequest, objectId: string): Promise<{ file: StoredFile; body: Readable } | null>
  remove(request: FastifyRequest, objectId: string): Promise<boolean>
  list(request: FastifyRequest, options: { limit: number; moduleCode?: string | undefined }): Promise<StoredFile[]>
  usage(request: FastifyRequest): Promise<Array<{ backend: string; files: number; bytes: number }>>
}

export function createFileService(storage: TenantStorage) {
  const service = (kit: TenantRequestKit): FileService => ({
    async save(
      request: FastifyRequest,
      input: { fileName: string; contentType: string; body: Buffer; createdBy: string | null; moduleCode?: string | null },
    ): Promise<StoredFile> {
      const context = kit.tenant(request)
      const config = await kit.config(request)
      const maxFileBytes = configInteger(config, 'limit.storage.max_file_mb', 25) * 1024 * 1024
      if (input.body.length > maxFileBytes) throw new FileLimitError(`Files may be at most ${maxFileBytes / 1024 / 1024} MB.`, 413)
      const fileName = input.fileName.replace(/[\u0000-\u001f\\/]/g, '_').trim().slice(0, 255) || 'file'
      const contentType = contentTypePattern.test(input.contentType) ? input.contentType : 'application/octet-stream'
      const quotaBytes = configInteger(config, 'limit.storage.max_mb', 0) * 1024 * 1024
      const objectId = randomUUID()
      const storageRef = storage.activeRef(context)
      const key = objectKeyFor(objectId)
      const sha256 = createHash('sha256').update(input.body).digest('hex')
      // Reserve the metadata row first (quota checked under a lock), then
      // write bytes, so a failed write never leaves bytes without a record.
      await kit.withTenant(request, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`tenant-storage-quota:${context.schemaName}`])
        if (quotaBytes > 0) {
          const used = Number((await client.query<{ used: string }>('select coalesce(sum(size_bytes), 0) as used from stored_object')).rows[0]?.used)
          if (used + input.body.length > quotaBytes) throw new FileLimitError('This workspace has reached its storage quota.', 409)
        }
        await client.query(
          `insert into stored_object (object_id, storage_ref, object_key, file_name, content_type, size_bytes, sha256, module_code, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [objectId, storageRef, key, fileName, contentType, input.body.length, sha256, input.moduleCode ?? null, input.createdBy],
        )
      })
      try {
        await (await storage.store(context, storageRef)).put(key, input.body, contentType)
      } catch (error) {
        await kit.withTenant(request, (client) => client.query('delete from stored_object where object_id = $1', [objectId]))
        throw error
      }
      return { id: objectId, fileName, contentType, sizeBytes: input.body.length, sha256, storage: storageRef === 'vds' ? 'vds' : 'external', moduleCode: input.moduleCode ?? null, createdAt: new Date().toISOString() }
    },

    async open(request: FastifyRequest, objectId: string): Promise<{ file: StoredFile; body: Readable } | null> {
      const row = await kit.withTenant(request, async (client) =>
        (await client.query<Row>('select *, size_bytes::text from stored_object where object_id = $1', [objectId])).rows[0],
      )
      if (!row) return null
      const object = await (await storage.store(kit.tenant(request), row.storage_ref)).get(row.object_key)
      return { file: toFile(row), body: object.body }
    },

    async remove(request: FastifyRequest, objectId: string): Promise<boolean> {
      const row = await kit.withTenant(request, async (client) =>
        (await client.query<Row>('delete from stored_object where object_id = $1 returning *, size_bytes::text', [objectId])).rows[0],
      )
      if (!row) return false
      await (await storage.store(kit.tenant(request), row.storage_ref)).delete(row.object_key).catch(() => undefined)
      return true
    },

    async list(request: FastifyRequest, options: { limit: number; moduleCode?: string | undefined }): Promise<StoredFile[]> {
      return kit.withTenant(request, async (client) =>
        (await client.query<Row>(
          `select *, size_bytes::text from stored_object
            where ($1::text is null or module_code = $1)
            order by created_at desc limit $2`,
          [options.moduleCode ?? null, options.limit],
        )).rows.map(toFile),
      )
    },

    async usage(request: FastifyRequest) {
      return kit.withTenant(request, async (client) => {
        const rows = (await client.query<{ storage_ref: string; files: number; bytes: string }>(
          `select storage_ref, count(*)::int as files, coalesce(sum(size_bytes), 0)::text as bytes
             from stored_object group by storage_ref`,
        )).rows
        return rows.map((row) => ({ backend: row.storage_ref, files: row.files, bytes: Number(row.bytes) }))
      })
    },
  })

  const module: TenantModule = {
    code: 'files',
    register(app, kit) {
      const files = service(kit)
      // Uploads arrive as raw bytes; the real type travels in X-Content-Type
      // so a .json upload is never parsed as a JSON request body.
      app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 1024 * 1024 * 1024 }, (_request, body, done) => done(null, body))

      app.get('/api/v1/files', async (request, reply) => {
        const session = await kit.requireSession(request, reply)
        if (!session || !(await kit.requirePermission(request, reply, session, 'tenant.files.read'))) return
        const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), module: z.string().max(40).optional() }).parse(request.query)
        const config = await kit.config(request)
        return {
          success: true,
          files: await files.list(request, { limit: query.limit, moduleCode: query.module }),
          usage: await files.usage(request),
          limits: { maxFileMb: configInteger(config, 'limit.storage.max_file_mb', 25), quotaMb: configInteger(config, 'limit.storage.max_mb', 0) },
          activeBackend: kit.tenant(request).storageIntegrationId ? 'external' : 'vds',
        }
      })

      app.post('/api/v1/files', {
        preParsing: async (request, reply) => {
          const declared = Number(request.headers['content-length'] || 0)
          const limit = configInteger(await kit.config(request), 'limit.storage.max_file_mb', 25) * 1024 * 1024
          if (declared > limit) return reply.code(413).send({ success: false, message: `Files may be at most ${limit / 1024 / 1024} MB.` })
        },
      }, async (request, reply) => {
        const session = await kit.requireSession(request, reply)
        if (!session) return
        if (!(await kit.requirePermission(request, reply, session, 'tenant.files.write')) || !kit.requireCsrf(request, reply, session)) return
        if (!Buffer.isBuffer(request.body)) return reply.code(415).send({ success: false, message: 'Send the file as application/octet-stream.' })
        const rawName = String(request.headers['x-file-name'] || '')
        let fileName = 'file'
        try {
          fileName = decodeURIComponent(rawName) || 'file'
        } catch {
          fileName = rawName || 'file'
        }
        try {
          const file = await files.save(request, {
            fileName,
            contentType: String(request.headers['x-content-type'] || 'application/octet-stream'),
            body: request.body,
            createdBy: session.userId,
          })
          await kit.audit(request, { actorUserId: session.userId, action: 'file:upload', resourceType: 'stored_object', resourceId: file.id, outcome: 'success' })
          return reply.code(201).send({ success: true, file })
        } catch (error) {
          if (error instanceof FileLimitError) return reply.code(error.statusCode).send({ success: false, message: error.message })
          throw error
        }
      })

      app.get('/api/v1/files/:fileId', async (request, reply) => {
        const session = await kit.requireSession(request, reply)
        if (!session || !(await kit.requirePermission(request, reply, session, 'tenant.files.read'))) return
        const { fileId } = z.object({ fileId: z.uuid() }).parse(request.params)
        const opened = await files.open(request, fileId)
        if (!opened) return reply.code(404).send({ success: false, message: 'File not found.' })
        // Always a download: user-supplied content is never rendered on the
        // tenant's origin, where it could run script.
        reply.header('Content-Type', opened.file.contentType)
        reply.header('Content-Length', String(opened.file.sizeBytes))
        reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(opened.file.fileName)}`)
        reply.header('X-Content-Type-Options', 'nosniff')
        reply.header('Content-Security-Policy', "default-src 'none'; sandbox")
        return reply.send(opened.body)
      })

      app.delete('/api/v1/files/:fileId', async (request, reply) => {
        const session = await kit.requireSession(request, reply)
        if (!session) return
        if (!(await kit.requirePermission(request, reply, session, 'tenant.files.write')) || !kit.requireCsrf(request, reply, session)) return
        const { fileId } = z.object({ fileId: z.uuid() }).parse(request.params)
        if (!(await files.remove(request, fileId))) return reply.code(404).send({ success: false, message: 'File not found.' })
        await kit.audit(request, { actorUserId: session.userId, action: 'file:delete', resourceType: 'stored_object', resourceId: fileId, outcome: 'success' })
        return { success: true }
      })
    },
  }
  return { module, service }
}
