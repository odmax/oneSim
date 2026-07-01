import { getAppBaseUrl, getApiBaseUrl, absoluteUrl } from './app-url'

export { getAppBaseUrl as getAppUrl, getApiBaseUrl, absoluteUrl }

export function apiUrl(path: string, request?: { headers: { get: (name: string) => string | null } }): string {
  const base = getApiBaseUrl(request).replace(/\/+$/, '')
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `${base}${cleanPath}`
}
