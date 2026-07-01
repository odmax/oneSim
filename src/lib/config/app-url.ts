/**
 * Central app URL helper — the only source of truth for all generated absolute URLs.
 *
 * Priority chain for getAppBaseUrl():
 *   1. APP_URL env var
 *   2. NEXTAUTH_URL env var
 *   3. Request origin (from headers, if called in a request context)
 *   4. NEXT_PUBLIC_APP_URL env var
 *
 * assertEnvironmentUrlSafety() throws if the resolved URL doesn't match the expected
 * domain for the current APP_ENV (staging or production).
 */

function getAppEnv(): string {
  return process.env.APP_ENV || (process.env.NODE_ENV === 'production' ? 'production' : 'development')
}

function getExpectedDomain(): string {
  const env = getAppEnv()
  if (env === 'staging') return 'staging.onetelecom.cloud'
  if (env === 'production') return 'm2m.onetelecom.cloud'
  return ''  // development — no restriction
}

function stripTrailing(url: string): string {
  return url.replace(/\/+$/, '')
}

export function getAppBaseUrl(request?: { headers: { get: (name: string) => string | null } }): string {
  if (process.env.APP_URL) return stripTrailing(process.env.APP_URL)
  if (process.env.NEXTAUTH_URL) return stripTrailing(process.env.NEXTAUTH_URL)
  if (request) {
    const origin = request.headers.get('origin')
    if (origin) return stripTrailing(origin)
    const host = request.headers.get('host')
    const proto = request.headers.get('x-forwarded-proto') || (process.env.NODE_ENV === 'production' ? 'https' : 'http')
    if (host) return `${proto}://${stripTrailing(host)}`
  }
  if (process.env.NEXT_PUBLIC_APP_URL) return stripTrailing(process.env.NEXT_PUBLIC_APP_URL)
  // Development fallback
  return 'http://localhost:3000'
}

export function getApiBaseUrl(request?: { headers: { get: (name: string) => string | null } }): string {
  if (process.env.APP_API_URL) return stripTrailing(process.env.APP_API_URL)
  return `${getAppBaseUrl(request)}/api/v1`
}

export function absoluteUrl(path: string, request?: { headers: { get: (name: string) => string | null } }): string {
  const base = getAppBaseUrl(request)
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `${base}${cleanPath}`
}

export function isCurrentEnvironment(url: string): boolean {
  const expected = getExpectedDomain()
  if (!expected) return true  // development — no check
  try {
    const parsed = new URL(url)
    return parsed.hostname === expected
  } catch {
    return false
  }
}

export function safeCallbackUrl(url: string | null | undefined, defaultPath: string = '/'): string {
  if (!url) return defaultPath
  if (url.startsWith('/')) return url  // relative is always safe
  if (isCurrentEnvironment(url)) return url
  return defaultPath
}

export function assertEnvironmentUrlSafety(): void {
  const env = getAppEnv()
  if (env === 'development') return

  const expected = getExpectedDomain()
  if (!expected) {
    console.warn(`[app-url] APP_ENV=${env} but no expected domain configured. Set APP_URL or NEXTAUTH_URL.`)
    return
  }

  const appUrl = process.env.APP_URL
  const nextAuthUrl = process.env.NEXTAUTH_URL
  const publicUrl = process.env.NEXT_PUBLIC_APP_URL

  for (const [label, value] of [['APP_URL', appUrl], ['NEXTAUTH_URL', nextAuthUrl], ['NEXT_PUBLIC_APP_URL', publicUrl]] as const) {
    if (value) {
      try {
        const parsed = new URL(value)
        if (parsed.hostname !== expected) {
          throw new Error(
            `ENVIRONMENT MISMATCH: ${label}=${value} does not match APP_ENV=${env} (expected ${expected}). ` +
            `Staging must use staging.onetelecom.cloud. Production must use m2m.onetelecom.cloud.`
          )
        }
      } catch (e: any) {
        if (e.message && e.message.includes('ENVIRONMENT MISMATCH')) throw e
        console.warn(`[app-url] Could not parse ${label}=${value}: ${e.message}`)
      }
    }
  }
}

export function requireAppUrl(): void {
  assertEnvironmentUrlSafety()
  if (!process.env.APP_URL && !process.env.NEXTAUTH_URL && !process.env.NEXT_PUBLIC_APP_URL) {
    console.error('========================================')
    console.error('  FATAL: No APP_URL or NEXTAUTH_URL set.')
    console.error('  Set APP_URL or NEXTAUTH_URL in .env or .env.production')
    console.error('========================================')
    if (process.env.NODE_ENV === 'production') {
      throw new Error('APP_URL or NEXTAUTH_URL is required in production')
    }
  }
}

// Run safety check on import in production/staging
if (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'staging' || process.env.APP_ENV === 'production') {
  try { assertEnvironmentUrlSafety() } catch { /* will be caught at startup */ }
}
