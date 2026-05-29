function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'https://staging.onetelecom.cloud'
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

export { getAppUrl, getApiBaseUrl, absoluteUrl, apiUrl }
