/**
 * Reads a deployment-specific setting (domain, origin, secret path). In
 * production a missing value is a startup error, so a fresh deployment can
 * never silently fall back to another installation's domain or file layout.
 * Development and test fall back to a reserved, non-routable value.
 */
export function deploymentSetting(
  name: string,
  options: { production: boolean; developmentDefault: string },
): string {
  const value = process.env[name]?.trim()
  if (value) return value
  if (options.production) {
    throw new Error(`${name} must be set in production. See .env.example.`)
  }
  return options.developmentDefault
}
