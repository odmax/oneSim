export function resolveProviderUrl(baseUrl: string | null | undefined, endpoint: string | null | undefined): string | null {
  if (!endpoint) return null

  // Absolute URL: use directly
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return endpoint.replace(/\/+$/, '')
  }

  if (!baseUrl) return null

  // Relative path: join with base
  const cleanBase = baseUrl.replace(/\/+$/, '')
  const cleanPath = endpoint.startsWith('/') ? endpoint : `/${endpoint}`
  return `${cleanBase}${cleanPath}`
}

export function detectUrlMismatch(
  environment: string | null | undefined,
  apiBaseUrl: string | null | undefined,
  authUrl: string | null | undefined,
): { hasMismatch: boolean; message: string } {
  // Compare upstream environment (config.upstreamEnvironment) vs actual URLs
  // Only warn when production upstream uses a staging host
  const urls = [apiBaseUrl, authUrl].filter(Boolean) as string[]
  const stagingUrls = urls.filter(u => u.includes('staging') || u.includes('stg-'))
  const prodMismatch = stagingUrls.length > 0

  if (prodMismatch) {
    const stagingFields = [
      apiBaseUrl?.includes('staging') ? 'API Base URL' : null,
      authUrl?.includes('staging') ? 'Auth URL' : null,
    ].filter(Boolean).join(', ')
    return {
      hasMismatch: true,
      message: `${stagingFields} points to a staging host. This may not be production-ready.`,
    }
  }

  return { hasMismatch: false, message: '' }
}
