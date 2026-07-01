function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000'
}

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL || `${getAppUrl()}/api/v1`
}

function absoluteUrl(path: string): string {
  const base = getAppUrl().replace(/\/+$/, '')
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `${base}${cleanPath}`
}

function apiUrl(path: string): string {
  const base = getApiBaseUrl().replace(/\/+$/, '')
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `${base}${cleanPath}`
}

/**
 * Get the app base URL with environment-aware fallback chain:
 * 1. APP_URL env var
 * 2. NEXTAUTH_URL env var
 * 3. Request origin from headers (if request provided)
 * 4. NEXT_PUBLIC_APP_URL env var
 * 5. Fallback: http://localhost:3000
 *
 * Use this in server actions and API routes where the request is available.
 */
function getAppBaseUrl(request?: Request | { headers: { get: (name: string) => string | null } }): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '')
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL.replace(/\/+$/, '')
  if (request) {
    const origin = request.headers.get('origin') || request.headers.get('host')
    if (origin) {
      const proto = request.headers.get('x-forwarded-proto') || 'https'
      const host = origin.startsWith('http') ? origin : `${proto}://${origin}`
      return host.replace(/\/+$/, '')
    }
  }
  return getAppUrl().replace(/\/+$/, '')
}

export { getAppUrl, getApiBaseUrl, absoluteUrl, apiUrl, getAppBaseUrl }
