import { delegationsModule } from './delegations.js'
import type { TenantModule } from './types.js'

/**
 * Application-layer modules mounted into the tenant BFF, in registration
 * order. Add a product module here; see ./types.ts for the contract and
 * docs/architecture/extending-the-foundation.md for the full checklist.
 */
export const applicationModules: TenantModule[] = [delegationsModule]

export type { TenantModule, TenantRequestKit, TenantSession } from './types.js'
