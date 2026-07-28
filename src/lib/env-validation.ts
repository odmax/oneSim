/**
 * OneSIM Environment Validation — Phase 5B
 * ==========================================
 *
 * Validate required environment variables at startup.
 * Fails fast with clear error messages.
 */

export function validateEnvironment(): { valid: boolean; errors: string[] } {
  const required = ['DATABASE_URL', 'NEXTAUTH_SECRET', 'NEXTAUTH_URL']
  const errors: string[] = []

  for (const key of required) {
    if (!process.env[key]) {
      errors.push(`Missing required environment variable: ${key}`)
    }
  }

  if (!process.env.DATABASE_URL) {
    errors.push('DATABASE_URL is required for database connectivity')
  }
  if (!process.env.NEXTAUTH_SECRET || process.env.NEXTAUTH_SECRET!.length < 16) {
    errors.push('NEXTAUTH_SECRET must be at least 16 characters')
  }

  if (errors.length > 0) {
    console.error(JSON.stringify({ level: 'FATAL', msg: 'Environment validation failed', errors, ts: new Date().toISOString() }))
  }

  return { valid: errors.length === 0, errors }
}
