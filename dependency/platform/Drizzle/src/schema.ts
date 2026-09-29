import { boolean, integer, jsonb, pgSchema, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'

export const platformSchema = pgSchema('platform')

export const platformUser = platformSchema.table('platform_user', {
  id: uuid('id').defaultRandom().primaryKey(),
  username: varchar('username', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: varchar('role', { length: 50 }).default('platform_owner').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export type PlatformUser = typeof platformUser.$inferSelect
export type NewPlatformUser = typeof platformUser.$inferInsert

export const platformAudit = platformSchema.table('platform_audit', {
  id: uuid('id').defaultRandom().primaryKey(),
  timestamp: timestamp('timestamp', { withTimezone: true }).defaultNow().notNull(),
  userId: uuid('user_id'),
  feature: varchar('feature', { length: 100 }).notNull(),
  action: varchar('action', { length: 100 }).notNull(),
  status: varchar('status', { length: 50 }).notNull(),
})

export type PlatformAudit = typeof platformAudit.$inferSelect
export type NewPlatformAudit = typeof platformAudit.$inferInsert

export const platformSession = platformSchema.table('platform_session', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  csrfHash: text('csrf_hash').notNull(),
  iapSubject: text('iap_subject'),
  iapEmail: text('iap_email'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

export type PlatformSession = typeof platformSession.$inferSelect
export type NewPlatformSession = typeof platformSession.$inferInsert

export const tenantRegistry = platformSchema.table('tenant_registry', {
  tenantId: uuid('tenant_id').defaultRandom().primaryKey(),
  tenantKey: text('tenant_key'),
  displayName: text('display_name').notNull(),
  legalName: text('legal_name'),
  slug: text('slug'),
  schemaIdentifier: text('schema_identifier').notNull(),
  dbRole: text('db_role'),
  loginRole: text('login_role'),
  credentialRef: text('credential_ref'),
  lifecycleStatus: text('lifecycle_status').default('provisioning').notNull(),
  primaryHostname: text('primary_hostname'),
  region: text('region').notNull(),
  schemaVersion: integer('schema_version').default(0).notNull(),
  defaultLocale: text('default_locale').default('en').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
})

export const tenantDomain = platformSchema.table('tenant_domain', {
  domainId: uuid('domain_id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  hostname: text('hostname').notNull(),
  subdomain: text('subdomain').notNull(),
  isPrimary: boolean('is_primary').default(false).notNull(),
  status: text('status').default('pending').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const tenantBranding = platformSchema.table('tenant_branding', {
  tenantId: uuid('tenant_id').primaryKey(),
  logoUrl: text('logo_url'),
  primaryColor: text('primary_color').default('#2563eb').notNull(),
  secondaryColor: text('secondary_color').default('#0f172a').notNull(),
  loginBackground: text('login_background'),
  loginMessage: text('login_message'),
  defaultLocale: text('default_locale').default('en').notNull(),
  safeMetadata: jsonb('safe_metadata').default({}).notNull(),
})

export const tenantProvisioningJob = platformSchema.table('tenant_provisioning_job', {
  jobId: uuid('job_id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  requestedBy: uuid('requested_by'),
  correlationId: uuid('correlation_id').notNull(),
  status: text('status').default('pending').notNull(),
  currentStep: text('current_step'),
  attemptCount: integer('attempt_count').default(0).notNull(),
  retryable: boolean('retryable').default(true).notNull(),
  safeErrorCode: text('safe_error_code'),
  safeErrorMessage: text('safe_error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
})

export const tenantProvisioningStep = platformSchema.table('tenant_provisioning_step', {
  jobId: uuid('job_id').notNull(),
  stepCode: text('step_code').notNull(),
  stepOrder: integer('step_order').notNull(),
  status: text('status').default('pending').notNull(),
  displayMessage: text('display_message').notNull(),
  safeErrorMessage: text('safe_error_message'),
  attemptCount: integer('attempt_count').default(0).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
})
