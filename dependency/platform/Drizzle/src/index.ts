import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.js'

const { Pool } = pg

export * from 'drizzle-orm'
export * from './schema.js'
export { drizzle }
export type { NodePgDatabase }

export type DatabaseConnectionOptions = pg.PoolConfig | string

export interface DatabaseClient {
  pool: pg.Pool
  db: NodePgDatabase<typeof schema>
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function defaultPoolConfig(): pg.PoolConfig {
  return {
    max: positiveInteger(process.env.DB_POOL_MAX, 10),
    connectionTimeoutMillis: positiveInteger(process.env.DB_CONNECTION_TIMEOUT_MS, 5_000),
    idleTimeoutMillis: positiveInteger(process.env.DB_IDLE_TIMEOUT_MS, 30_000),
    query_timeout: positiveInteger(process.env.DB_QUERY_TIMEOUT_MS, 30_000),
  }
}

export function createDatabaseClient(options?: DatabaseConnectionOptions): DatabaseClient {
  const connectionString =
    typeof options === 'string'
      ? options
      : process.env.DATABASE_URL

  if (typeof options !== 'object' && !connectionString) {
    throw new Error('DATABASE_URL is required for database connections.')
  }

  const pool =
    typeof options === 'object'
      ? new Pool({ ...defaultPoolConfig(), ...options })
      : new Pool({ ...defaultPoolConfig(), connectionString })

  const db = drizzle(pool, { schema })

  return { pool, db }
}
