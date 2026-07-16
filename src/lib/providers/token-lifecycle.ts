import { prisma } from '@/lib/prisma'
import { buildConnectorFromProvider, getStoredCredentials } from './connectors/connector-factory'
import { buildAdapter } from './adapter-manager'

export interface TokenState {
  tokenPresent: boolean
  expiryPresent: boolean
  expired: boolean
  expiresSoon: boolean
  tokenExpiry: unknown
}

function isTokenExpired(expiry: unknown, bufferMs = 5 * 60 * 1000): boolean {
  if (!expiry) return false
  let expiryMs: number
  if (typeof expiry === 'number') {
    expiryMs = expiry * 1000
  } else if (typeof expiry === 'string') {
    const parsed = Date.parse(expiry)
    if (isNaN(parsed)) return false
    expiryMs = parsed
  } else {
    return false
  }
  return Date.now() >= expiryMs - bufferMs
}

function getExpiresSoon(expiry: unknown): boolean {
  if (!expiry) return false
  let expiryMs: number
  if (typeof expiry === 'number') {
    expiryMs = expiry * 1000
  } else if (typeof expiry === 'string') {
    const parsed = Date.parse(expiry)
    if (isNaN(parsed)) return false
    expiryMs = parsed
  } else {
    return false
  }
  return Date.now() >= expiryMs - 5 * 60 * 1000 && Date.now() < expiryMs
}

function isDefinitelyExpired(expiry: unknown): boolean {
  if (!expiry) return false
  let expiryMs: number
  if (typeof expiry === 'number') {
    expiryMs = expiry * 1000
  } else if (typeof expiry === 'string') {
    const parsed = Date.parse(expiry)
    if (isNaN(parsed)) return false
    expiryMs = parsed
  } else {
    return false
  }
  return Date.now() >= expiryMs
}

export async function getTokenState(providerId: string): Promise<TokenState> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { apiToken: true, config: true },
  })
  if (!provider) {
    return { tokenPresent: false, expiryPresent: false, expired: false, expiresSoon: false, tokenExpiry: null }
  }

  const tokenPresent = !!provider.apiToken
  const config = (provider.config as any) || {}
  const tokenExpiry = config.tokenExpiry || null
  const expiryPresent = !!tokenExpiry

  return {
    tokenPresent,
    expiryPresent,
    expired: tokenExpiry ? isDefinitelyExpired(tokenExpiry) : false,
    expiresSoon: tokenExpiry ? getExpiresSoon(tokenExpiry) : false,
    tokenExpiry,
  }
}

export async function ensureAuthenticated(providerId: string): Promise<{ success: boolean; error?: string }> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { apiToken: true, config: true, code: true },
  })
  if (!provider) return { success: false, error: 'Provider not found' }

  const config = (provider.config as any) || {}
  const tokenExpiry = config.tokenExpiry || null
  const needsRefresh = !provider.apiToken || (tokenExpiry && isTokenExpired(tokenExpiry))

  if (!needsRefresh) return { success: true }

  const reason = !provider.apiToken ? 'missing' : isDefinitelyExpired(tokenExpiry) ? 'expired' : 'expires_soon'

  try {
    const refreshed = await refreshAuthentication(providerId)
    console.log(`[PROVIDER_TOKEN_REFRESH] providerCode=${provider.code} reason=${reason} success=${refreshed}`)
    if (!refreshed) {
      return { success: false, error: 'Token refresh failed' }
    }
    return { success: true }
  } catch (e: any) {
    console.log(`[PROVIDER_TOKEN_REFRESH] providerCode=${provider.code} reason=${reason} success=false`)
    return { success: false, error: e.message || 'Token refresh threw' }
  }
}

export async function refreshAuthentication(providerId: string): Promise<boolean> {
  try {
    const creds = await getStoredCredentials(providerId)
    if (creds) {
      const connector = await buildConnectorFromProvider(providerId)
      if (connector) {
        const result = await connector.authenticate({ username: creds.username, password: creds.password })
        return result.success
      }

      const provider = await prisma.provider.findUnique({ where: { id: providerId } })
      if (!provider) return false
      const adapter = await buildAdapter(provider)
      if (adapter) {
        const result = await adapter.authenticate({ username: creds.username, password: creds.password })
        return result.success
      }
    }

    return false
  } catch {
    return false
  }
}

export async function withTokenRefresh<T>(
  providerId: string,
  operation: string,
  fn: () => Promise<{ success: boolean; status?: number; error?: any; data?: T }>
): Promise<{ success: boolean; data?: T; error?: any }> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { code: true },
  })
  const providerCode = provider?.code || providerId

  const tokenState = await getTokenState(providerId)
  console.log(`[PROVIDER_TOKEN_CHECK] providerCode=${providerCode} tokenPresent=${tokenState.tokenPresent} expiryPresent=${tokenState.expiryPresent} expired=${tokenState.expired} expiresSoon=${tokenState.expiresSoon}`)

  if (!tokenState.tokenPresent || tokenState.expired || tokenState.expiresSoon) {
    const reason = !tokenState.tokenPresent ? 'missing' : tokenState.expired ? 'expired' : 'expires_soon'
    const refreshed = await refreshAuthentication(providerId)
    console.log(`[PROVIDER_TOKEN_REFRESH] providerCode=${providerCode} reason=${reason} success=${refreshed}`)
    if (!refreshed) {
      return { success: false, error: { code: 'TOKEN_REFRESH_FAILED', message: `Token refresh failed: ${reason}` } }
    }
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await fn()
    if (result.success) return { success: true, data: result.data }

    if (result.status === 401 && attempt === 1) {
      const refreshed = await refreshAuthentication(providerId)
      console.log(`[PROVIDER_TOKEN_REFRESH] providerCode=${providerCode} reason=401 success=${refreshed}`)
      if (refreshed) {
        console.log(`[PROVIDER_REQUEST_RETRY] providerCode=${providerCode} operation=${operation} attempt=${attempt + 1}`)
        continue
      }
      return { success: false, error: result.error || { code: 'HTTP_401', message: 'Request returned 401 and reauthentication failed' } }
    }

    return { success: false, error: result.error }
  }

  return { success: false, error: { code: 'RETRIES_EXHAUSTED', message: `Max retries reached for ${operation}` } }
}
