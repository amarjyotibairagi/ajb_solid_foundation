/**
 * Types and validation for the control-plane configuration registry
 * (database/migrations/027_platform_configuration_registry.sql).
 *
 * validateConfigValue mirrors platform.validate_config_value. The database is
 * authoritative for platform/plan/tenant overrides; this copy validates
 * tenant-local values, which live in the tenant schema and never pass through
 * the platform function.
 */

export type ConfigValue = boolean | number | string | string[]

export type ConfigDefinitionMeta = {
  kind: 'feature' | 'limit' | 'setting'
  valueType: 'boolean' | 'integer' | 'string' | 'string_list'
  tenantEditable: boolean
  isPublic: boolean
  min?: number
  max?: number
  maxLength?: number
  allowed?: ConfigValue[]
}

export type ConfigSource = 'default' | 'platform' | 'plan' | 'tenant' | 'tenant_local'

export type ResolvedConfig = {
  planCode: string | null
  values: Record<string, ConfigValue>
  sources: Record<string, ConfigSource>
  definitions: Record<string, ConfigDefinitionMeta>
}

export class ConfigValidationError extends Error {}

export function validateConfigValue(key: string, meta: ConfigDefinitionMeta | undefined, value: unknown): ConfigValue {
  if (!meta) throw new ConfigValidationError(`Unknown configuration key ${key}.`)
  switch (meta.valueType) {
    case 'boolean':
      if (typeof value !== 'boolean') throw new ConfigValidationError(`${key} must be true or false.`)
      break
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new ConfigValidationError(`${key} must be a whole number.`)
      }
      if ((meta.min !== undefined && value < meta.min) || (meta.max !== undefined && value > meta.max)) {
        throw new ConfigValidationError(`${key} must be between ${meta.min ?? '-inf'} and ${meta.max ?? 'inf'}.`)
      }
      break
    case 'string':
      if (typeof value !== 'string') throw new ConfigValidationError(`${key} must be text.`)
      if (meta.maxLength !== undefined && value.length > meta.maxLength) {
        throw new ConfigValidationError(`${key} must be at most ${meta.maxLength} characters.`)
      }
      break
    case 'string_list':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || (meta.maxLength !== undefined && item.length > meta.maxLength))) {
        throw new ConfigValidationError(`${key} must be a list of text values.`)
      }
      break
  }
  if (meta.allowed) {
    const candidates = Array.isArray(value) ? value : [value]
    if (candidates.some((candidate) => !meta.allowed!.some((allowed) => allowed === candidate))) {
      throw new ConfigValidationError(`${key} contains a value that is not allowed.`)
    }
  }
  return value as ConfigValue
}

/** Only keys flagged is_public may reach a browser. */
export function publicConfigValues(config: ResolvedConfig): Record<string, ConfigValue> {
  const result: Record<string, ConfigValue> = {}
  for (const [key, value] of Object.entries(config.values)) {
    if (config.definitions[key]?.isPublic) result[key] = value
  }
  return result
}

export function configBoolean(config: ResolvedConfig, key: string, fallback = false): boolean {
  const value = config.values[key]
  return typeof value === 'boolean' ? value : fallback
}

export function configInteger(config: ResolvedConfig, key: string, fallback: number): number {
  const value = config.values[key]
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback
}

export function configString(config: ResolvedConfig, key: string, fallback = ''): string {
  const value = config.values[key]
  return typeof value === 'string' ? value : fallback
}

export function configStringList(config: Pick<ResolvedConfig, 'values'>, key: string, fallback: string[] = []): string[] {
  const value = config.values[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : fallback
}
