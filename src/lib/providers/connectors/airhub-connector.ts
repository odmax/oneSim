import { encryptToken, decryptToken } from '@/lib/encryption'
import { prisma } from '@/lib/prisma'
import { recordHealthEvent } from '@/lib/services/providers/health-monitor'
import type { IProviderConnector, ConnectorResult, ConnectorPlan, DiagnosticInfo, ActivateESIMParams, ActivateESIMResult, UsageResult, StatusResult, RateResult, TopUpESIMParams, TopUpESIMResult, TokenState } from './connector-interface'

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

export function urlHostname(baseUrl: string): string {
  try { return new URL(baseUrl).hostname } catch { return baseUrl }
}

/**
 * Guards against sending credentials/tokens to the wrong environment.
 * Only an explicit `config.upstreamEnvironment` counts as intent; a provider
 * label (environment) alone is too ambiguous to block on.
 */
export function environmentMismatchMessage(baseUrl: string, cfg: Record<string, any>): string | null {
  const intended = typeof cfg.upstreamEnvironment === 'string' ? cfg.upstreamEnvironment.toLowerCase() : null
  if (!intended) return null
  const host = urlHostname(baseUrl).toLowerCase()
  const looksStaging = /staging|stg[-.]/.test(host)
  if (intended === 'production' && looksStaging) {
    return `AirHub environment mismatch: config.upstreamEnvironment=production but base URL host "${host}" looks like staging. Refusing to send production credentials to a staging host.`
  }
  if (intended === 'staging' && !looksStaging && host === 'api.airhubapp.com') {
    return `AirHub environment mismatch: config.upstreamEnvironment=staging but base URL host "${host}" is the production host. Refusing to send staging credentials to production.`
  }
  return null
}

export class AirHubConnector implements IProviderConnector {
  readonly providerId: string
  readonly name: string = 'AirHub'
  private token: string | null = null

  constructor(providerId: string, token?: string | null) {
    this.providerId = providerId
    this.token = token || null
  }

  private async refreshTokenFromConfig(): Promise<boolean> {
    try {
      const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { config: true } })
      if (!provider) return false
      const cfg = (provider.config as any) || {}
      const username = cfg.username
      const password = cfg.password
      if (!username || !password) return false
      const result = await this.authenticate({ username, password })
      return result.success
    } catch {
      return false
    }
  }

  async getTokenState(): Promise<TokenState> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { apiToken: true, config: true, environment: true } })
    if (!provider) return { tokenPresent: false, expiryPresent: false, expired: false, expiresSoon: false, tokenExpiry: null }
    const cfg = (provider.config as any) || {}
    const tokenExpiry = cfg.tokenExpiry || null
    const tokenPresent = !!this.token || !!provider.apiToken
    let expired = false
    let expiresSoon = false

    // A token minted under a different environment than the one currently
    // configured must not be reused against the new endpoint.
    const authEnv = cfg.authEnvironmentAtAuth
    const currentEnv = cfg.upstreamEnvironment || provider.environment || 'production'
    const envChanged = typeof authEnv === 'string' && typeof currentEnv === 'string' && authEnv !== currentEnv

    if (tokenExpiry) {
      if (typeof tokenExpiry === 'number') {
        expired = Date.now() >= tokenExpiry * 1000
        expiresSoon = !expired && Date.now() >= (tokenExpiry * 1000) - 5 * 60 * 1000
      } else if (typeof tokenExpiry === 'string') {
        const parsed = Date.parse(tokenExpiry)
        if (!isNaN(parsed)) {
          expired = Date.now() >= parsed
          expiresSoon = !expired && Date.now() >= parsed - 5 * 60 * 1000
        }
      }
    }
    if (envChanged) {
      expired = true
      expiresSoon = false
    }
    return { tokenPresent, expiryPresent: !!tokenExpiry, expired, expiresSoon, tokenExpiry }
  }

  async ensureAuthenticated(): Promise<ConnectorResult<void>> {
    const state = await this.getTokenState()
    if (state.tokenPresent && !state.expired && !state.expiresSoon) return { success: true }
    const refreshed = await this.refreshTokenFromConfig()
    if (refreshed) return { success: true }
    if (this.token) return { success: true }
    return { success: false, error: { code: 'NO_TOKEN', message: 'No token. Authenticate first.' } }
  }

  async refreshAuthentication(): Promise<boolean> {
    return this.refreshTokenFromConfig()
  }

  async authenticate(credentials: Record<string, string>): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId } })
    if (!provider) return { success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }

    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    const authPath = provider.authUrl || '/api/Authentication/UserLogin'
    const url = `${baseUrl.replace(/\/$/, '')}/${authPath.replace(/^\//, '')}`
    const cfg = (provider.config as any) || {}
    const authEnv = cfg.upstreamEnvironment || provider.environment || 'production'

    console.log(`[AIRHUB_AUTH_START] providerId=${this.providerId} baseHost=${urlHostname(baseUrl)} resolvedUrl=${url} authEnvironment=${authEnv}`)
    console.log(`[AIRHUB_AUTH_REQUEST] method=POST bodyFields=userName,password`)

    // Validate credentials before making HTTP request
    const resolvedUsername = (credentials.username || '').trim()
    const resolvedPassword = (credentials.password || '').trim()
    if (!resolvedUsername || !resolvedPassword) {
      return {
        success: false,
        error: { code: 'AIRHUB_CREDENTIALS_MISSING', message: 'Username and password are required. Add them to provider.config.' },
      }
    }

    // Never send credentials to the wrong environment
    const mismatch = environmentMismatchMessage(baseUrl, cfg)
    if (mismatch) return { success: false, error: { code: 'AIRHUB_ENV_MISMATCH', message: mismatch } }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 25000)
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ userName: resolvedUsername, password: resolvedPassword }),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      const text = await response.text()
      const contentType = response.headers?.get?.('content-type') || ''

      // Handle 401 (invalid login) before attempting JSON parsing — the body
      // is frequently not JSON.
      if (response.status === 401) {
        let safeKeys: string[] = []
        try {
          const parsed = JSON.parse(text)
          if (parsed && typeof parsed === 'object') safeKeys = Object.keys(parsed)
        } catch { /* non-JSON — safeKeys stays empty */ }
        console.log(`[AIRHUB_AUTH_UNAUTHORIZED] httpStatus=401 contentType=${contentType} endpoint=${authPath} topKeys=${safeKeys.join(',')}`)
        return {
          success: false,
          error: {
            code: 'AIRHUB_AUTH_UNAUTHORIZED',
            message: 'AirHub login rejected credentials (HTTP 401)',
            details: { authStage: 'login', providerStatus: 401, retryable: false },
          },
        }
      }

      let data: any
      try { data = JSON.parse(text) } catch {
        console.log(`[AIRHUB_AUTH_RESPONSE] httpStatus=${response.status} contentType=${contentType} parse=NON_JSON`)
        return { success: false, error: { code: 'NON_JSON', message: 'AirHub returned non-JSON response' } }
      }

      const respKeys = Object.keys(data)
      const dataKeys = data.data && typeof data.data === 'object' ? Object.keys(data.data) : []
      console.log(`[AIRHUB_AUTH_RESPONSE] httpStatus=${response.status} isSuccess=${data.isSuccess} topKeys=${respKeys.join(',')} dataKeys=${dataKeys.join(',')} tokenSource=${data.token?'token':data.accessToken?'accessToken':data.data?.token?'data.token':'unknown'}`)

      if (!response.ok) return { success: false, error: { code: `HTTP_${response.status}`, message: `AirHub auth failed: HTTP ${response.status}` } }
      if (data.isSuccess === false) return { success: false, error: { code: 'AUTH_REJECTED', message: `AirHub rejected: ${data.message || 'unknown'}` } }

      const token = data.token || data.accessToken || data.access_token || data.data?.token || data.data?.accessToken || ''
      if (!token || token.length < 8) return { success: false, error: { code: 'NO_TOKEN', message: 'No valid token returned' } }

      const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token.trim()
      const partnerCode = (data as any).partnerCode || (data as any).data?.partnerCode || (provider.config as any)?.partnerCode
      const tokenExpiry = data.token_expire || data.expiresAt || null

      await prisma.provider.update({
        where: { id: this.providerId },
        data: {
          apiToken: encryptToken(cleanToken),
          tokenPlacement: provider.tokenPlacement || 'BEARER_HEADER',
          lastSuccessfulConnection: new Date(),
          lastError: null,
          errorCount: 0,
          config: {
            ...((provider.config as any) || {}),
            lastAuthenticatedAt: new Date().toISOString(),
            authEnvironmentAtAuth: ((provider.config as any)?.upstreamEnvironment) || provider.environment || 'production',
            tokenExpiry: tokenExpiry || null,
          },
        },
      })

      await recordHealthEvent(this.providerId, { eventType: 'CONNECTION_TEST', success: true, message: 'AirHub authenticated' })

      console.log(`[AIRHUB_AUTH_RESULT] success=true tokenPersisted=true tokenExpiryPresent=${!!tokenExpiry} partnerCode=${partnerCode} authEnvironment=${authEnv}`)
      this.token = cleanToken
      return { success: true, data: { token: cleanToken, accountInfo: { partnerCode, tokenExpiry } } }
    } catch (e: any) {
      const causeCode = e?.cause?.code || ''
      let msg: string
      if (e.name === 'AbortError') msg = 'AirHub auth timed out after 25 seconds'
      else if (causeCode === 'ENOTFOUND') msg = 'AirHub host not found (DNS failure)'
      else if (causeCode === 'ECONNREFUSED') msg = 'AirHub refused the connection'
      else if (causeCode?.includes('TLS') || causeCode?.includes('CERT')) msg = 'TLS connection to AirHub failed'
      else msg = `AirHub auth failed: ${e.message?.substring(0, 100)}`
      console.log(`[AIRHUB_AUTH_ERROR] ${msg}`)
      await prisma.provider.update({
        where: { id: this.providerId },
        data: { lastFailedConnection: new Date(), lastError: msg.substring(0, 500), errorCount: { increment: 1 } },
      }).catch(() => {})
      return { success: false, error: { code: 'NETWORK_ERROR', message: msg } }
    }
  }

  async testConnection(): Promise<ConnectorResult<{ message: string; latencyMs?: number }>> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { apiBaseUrl: true, apiToken: true } })
    if (!provider) return { success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }
    if (!this.token && provider.apiToken) {
      try { this.token = decryptToken(provider.apiToken) || null } catch {}
    }
    if (!this.token) return { success: false, error: { code: 'NO_TOKEN', message: 'No token. Authenticate first.' } }

    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    const startMs = Date.now()
    const url = `${baseUrl.replace(/\/$/, '')}/api/ESIM/Getcountry_regiondetail?flag=2`

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15000)
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.token}`, 'Accept': 'application/json' },
        signal: controller.signal,
      })
      clearTimeout(timeout)
      const latencyMs = Date.now() - startMs
      if (!response.ok) return { success: false, error: { code: `HTTP_${response.status}`, message: `AirHub returned ${response.status}` } }
      return { success: true, data: { message: `Connected (${latencyMs}ms)`, latencyMs } }
    } catch (e: any) {
      return { success: false, error: { code: 'NETWORK_ERROR', message: e.message?.substring(0, 200) } }
    }
  }

  async diagnoseConnection(): Promise<ConnectorResult<DiagnosticInfo>> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { apiBaseUrl: true, authUrl: true, apiToken: true, tokenPlacement: true, authType: true, config: true } })
    if (!provider) return { success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }
    if (!this.token && provider.apiToken) {
      try { this.token = decryptToken(provider.apiToken) || null } catch {}
    }

    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    const authUrl = provider.authUrl || '/api/Authentication/UserLogin'
    const path = '/api/ESIM/Getcountry_regiondetail?flag=2'
    const finalUrl = `${baseUrl.replace(/\/$/, '')}${path}`
    const warnings: string[] = []
    const config = (provider.config as any) || {}
    if (!config.partnerCode) warnings.push('partnerCode missing')

    try {
      const startMs = Date.now()
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000)
      const response = await fetch(finalUrl, {
        method: 'GET',
        headers: { 'Authorization': this.token ? `Bearer ${this.token}` : 'Bearer <missing>', 'Accept': 'application/json' },
        signal: controller.signal,
      })
      clearTimeout(timeout)
      const text = await response.text()
      let data: any = null; try { data = JSON.parse(text) } catch {}
      return {
        success: true,
        data: {
          connectorClass: 'AirHubConnector', method: 'GET', baseUrl, authUrl, path, finalUrl,
          tokenPlacement: (provider.tokenPlacement || 'BEARER_HEADER') as DiagnosticInfo['tokenPlacement'],
          authType: provider.authType || 'credentials', authHeaderPresent: !!this.token, tokenReplaced: false,
          responseStatus: response.status, responseContentType: response.headers.get('content-type') || null,
          responseBody: data ? JSON.stringify(data).substring(0, 300) : text.substring(0, 300),
          latencyMs: Date.now() - startMs, warnings,
        },
      }
    } catch (e: any) {
      return {
        success: false,
        data: {
          connectorClass: 'AirHubConnector', method: 'GET', baseUrl, authUrl, path, finalUrl,
          tokenPlacement: 'HEADER', authType: 'credentials', authHeaderPresent: !!this.token, tokenReplaced: false,
          responseStatus: null, responseContentType: null, responseBody: null, latencyMs: null,
          warnings: [...warnings, e.message?.substring(0, 200)],
        },
        error: { code: 'NETWORK_ERROR', message: e.message?.substring(0, 200) },
      }
    }
  }

  async syncPlans(): Promise<ConnectorResult<ConnectorPlan[]>> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { apiBaseUrl: true, apiToken: true, config: true } })
    if (!provider) return { success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }
    if (!this.token && provider.apiToken) {
      try { this.token = decryptToken(provider.apiToken) || null } catch {}
    }

    const config = (provider.config as any) || {}
    const partnerCode = config.partnerCode || 200652387
    const flag = config.flag ?? 6
    const countryCode = config.countryCode ?? ''
    const multiplecountrycode = Array.isArray(config.multiplecountrycode) ? config.multiplecountrycode : ['UK']

    // Flag-aware validation
    if ([0, 1, 2, 4].includes(flag)) {
      // Allow empty
    } else if (flag === 5) {
      if (!countryCode) return { success: false, error: { code: 'MISSING_CONFIG', message: 'countryCode required for flag=5' } }
    } else if (flag === 6) {
      if (!multiplecountrycode.length) return { success: false, error: { code: 'MISSING_CONFIG', message: 'multiplecountrycode required for flag=6' } }
    }

    // Token refresh if missing or expired
    const tokenExpiry = config.tokenExpiry
    if (!this.token || (tokenExpiry && isTokenExpired(tokenExpiry))) {
      const reason = !this.token ? 'missing' : 'expired'
      const refreshed = await this.refreshTokenFromConfig()
      console.log(`[AIRHUB_TOKEN_REFRESH] reason=${reason} success=${refreshed}`)
      if (!refreshed && !this.token) {
        return { success: false, error: { code: 'NO_TOKEN', message: 'No token. Authenticate first.' } }
      }
    }

    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    const url = `${baseUrl.replace(/\/$/, '')}/api/ESIM/GetPlanInformation`
    const body = { partnerCode, flag, countryCode, multiplecountrycode }
    const hasToken = !!this.token
    const tokenLooksValid = !!this.token && this.token.length > 20
    const hasBearerPrefix = !!(this.token && this.token.startsWith('Bearer '))
    console.log(`[AIRHUB_GET_PLANS_BODY] partnerCode=${partnerCode} flag=${flag} countryCode="${countryCode}" multiplecountrycode=${JSON.stringify(multiplecountrycode)}`)
    console.log(`[AIRHUB_GET_PLANS_REQUEST] url=${url} partnerCode=${partnerCode} flag=${flag}`)
    console.log(`[AIRHUB_GET_PLANS_AUTH] tokenAvailable=${hasToken} tokenLength=${this.token?.length||0} tokenLooksValid=${tokenLooksValid} hasBearerPrefix=${hasBearerPrefix} hasAuthorization=true scheme=Bearer`)

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 25000)
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const text = await response.text()
        const contentType = response.headers.get('content-type') || ''

        console.log(`[AIRHUB_GET_PLANS_HTTP] status=${response.status} statusText=${response.statusText} contentType=${contentType} bodyLength=${text.length}`)
        if (text.length < 500) console.log(`[AIRHUB_GET_PLANS_HTTP] body=${text.substring(0, 500)}`)

        // 401 on first attempt -> reauthenticate and retry once
        if (response.status === 401 && attempt === 1) {
          const refreshed = await this.refreshTokenFromConfig()
          console.log(`[AIRHUB_TOKEN_REFRESH] reason=401 success=${refreshed}`)
          if (refreshed) {
            console.log(`[AIRHUB_GET_PLANS_RETRY] attempt=${attempt + 1} status=${response.status}`)
            continue
          }
          return { success: false, error: { code: 'HTTP_401', message: 'AirHub GET_PLANS returned 401 and reauthentication failed' } }
        }

        let data: any
        try {
          data = JSON.parse(text)
        } catch (parseErr: any) {
          console.log(`[AIRHUB_GET_PLANS_ERROR] JSON parse failed: ${parseErr.message}`)
          const preview = text.substring(0, 300)
          if (preview.trim().startsWith('<')) {
            return { success: false, error: { code: 'HTML_RESPONSE', message: `AirHub returned HTML instead of JSON. Preview: ${preview}` } }
          }
          return { success: false, error: { code: 'NON_JSON', message: `AirHub returned non-JSON response. Status=${response.status} Preview: ${preview}` } }
        }

        console.log(`[AIRHUB_GET_PLANS_RESPONSE] status=${response.status} isSuccess=${data.isSuccess}`)
        if (!response.ok) return { success: false, error: { code: `HTTP_${response.status}`, message: `AirHub GET_PLANS returned ${response.status}: ${text.substring(0, 200)}` } }
        if (data.isSuccess === false) return { success: false, error: { code: 'PROVIDER_REJECTED', message: `AirHub rejected GET_PLANS: ${data.message || 'isSuccess=false'}` } }

        const plans = data.getInformation || []
        console.log(`[AIRHUB_SYNC_RESULT] fetched=${plans.length}`)

        let created = 0, updated = 0, failed = 0
        for (const plan of plans) {
          const planCode = plan.planCode
          if (!planCode) { failed++; continue }
          try {
            const cap = parseFloat(plan.capacity || '0')
            const unit = (plan.capacityUnit || 'GB').toUpperCase()
            const dataGB = unit === 'MB' ? Math.round((cap / 1024) * 100) / 100 : unit === 'KB' ? Math.round((cap / 1024 / 1024) * 100) / 100 : cap
            const pkg = {
              name: plan.planName || '',
              dataGB: Math.max(0.01, dataGB || 0.01),
              validityDays: parseInt(plan.validity || '30') || 30,
              costPrice: plan.price || 0,
              currency: plan.currency || 'USD',
              country: plan.countryName || null,
              region: plan.countryName || null,
              planType: plan.planType || null,
              providerPlanCode: planCode,
              providerRawData: plan,
              isAvailable: true,
            }
            const existing = await prisma.providerPackage.findFirst({ where: { providerId: this.providerId, providerPlanId: planCode } })
            if (existing) { await prisma.providerPackage.update({ where: { id: existing.id }, data: pkg }); updated++ }
            else { await prisma.providerPackage.create({ data: { providerId: this.providerId, providerPlanId: planCode, ...pkg } }); created++ }
          } catch { failed++ }
        }

        await prisma.provider.update({
          where: { id: this.providerId },
          data: { lastSyncAt: new Date(), lastSyncCount: plans.length, lastSyncResult: `${plans.length} fetched: ${created}c ${updated}u ${failed}f` },
        }).catch(() => {})

        const resultPlans = await prisma.providerPackage.findMany({
          where: { providerId: this.providerId },
          select: { id: true, name: true, dataGB: true, validityDays: true, costPrice: true, currency: true, providerPlanCode: true, providerRawData: true },
          take: 500,
        })
        return {
          success: true,
          data: resultPlans.map(p => ({
            id: p.providerPlanCode || p.id, name: p.name, data_gb: p.dataGB, validity_days: p.validityDays,
            price_usd: Number(p.costPrice), currency: p.currency, sku: p.providerPlanCode || '', raw_data: p.providerRawData || undefined,
          })),
        }
      } catch (e: any) {
        console.log(`[AIRHUB_GET_PLANS_ERROR] name=${e.name} message=${e.message?.substring(0,200)} causeCode=${e.cause?.code||''} causeMessage=${e.cause?.message?.substring(0,200)||''}`)
        return { success: false, error: { code: 'NETWORK_ERROR', message: e.message?.substring(0, 200) } }
      }
    }
    return { success: false, error: { code: 'UNKNOWN', message: 'syncPlans exhausted retries' } }
  }

  async validatePurchase(_params: { planId: string; quantity: number; subscriber: { email: string } }): Promise<{ valid: boolean; reason?: string }> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { apiBaseUrl: true, config: true, apiToken: true } })
    if (!provider) return { valid: false, reason: 'Provider not found' }
    if (!provider.apiBaseUrl) return { valid: false, reason: 'API base URL not configured' }
    const cfg = (provider.config as any) || {}
    if (!cfg.partnerCode && cfg.partnerCode !== 0) return { valid: false, reason: 'partnerCode not configured in provider config' }
    const hasCredentials = (!!cfg.username || !!cfg.userName) && (!!cfg.password || !!cfg.pass)
    const hasToken = !!provider.apiToken
    if (!hasCredentials && !hasToken) return { valid: false, reason: 'Credentials (username/password) or an API token are required in provider.config' }
    return { valid: true }
  }

  async activateESIM(params: ActivateESIMParams): Promise<ConnectorResult<ActivateESIMResult>> {
    const correlationId = `airhub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const startMs = Date.now()

    const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { apiBaseUrl: true, apiToken: true, config: true, code: true } })
    if (!provider) return { success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }

    const cfg = (provider.config as any) || {}
    const partnerCode = cfg.partnerCode || 200652387

    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    const url = `${baseUrl.replace(/\/$/, '')}/api/ESIM/PurhaseSim`

    // Never authenticate or purchase against the wrong environment
    const mismatch = environmentMismatchMessage(baseUrl, cfg)
    if (mismatch) return { success: false, error: { code: 'AIRHUB_ENV_MISMATCH', message: mismatch } }

    const tokenResult = await this.ensureAuthenticated()
    if (!tokenResult.success) return { success: false, error: tokenResult.error }

    const body: Record<string, any> = {
      partnerCode,
      planCode: params.planId,
      quantity: params.quantity,
      unique_order_id: params.externalId || `onesim-${Date.now()}`,
    }
    // email: historically sent, not in Swagger but kept for backward compat
    if (params.subscriber?.email) body.email = params.subscriber.email
    // travelDate: include when available
    const travelDate = (params as any).travelDate || (params.subscriber as any)?.travelDate
    if (travelDate) body.travelDate = travelDate

    console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} orderId=${params.externalId || 'unknown'} endpoint=POST /api/ESIM/PurhaseSim baseHost=${urlHostname(baseUrl)} planCode=${params.planId} quantity=${params.quantity} partnerCode=${partnerCode}`)

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30000)
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        clearTimeout(timeout)

        const text = await response.text()
        const contentType = response.headers?.get?.('content-type') || ''
        const durationMs = Date.now() - startMs

        // Handle 401 (rejected/expired purchase token) before attempting JSON
        // parsing — AirHub frequently returns a non-JSON body on 401.
        if (response.status === 401) {
          const hadToken = !!this.token
          let safeKeys: string[] = []
          try {
            const parsed = JSON.parse(text)
            if (parsed && typeof parsed === 'object') safeKeys = Object.keys(parsed)
          } catch { /* non-JSON — safeKeys stays empty */ }
          console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} httpStatus=401 contentType=${contentType} endpoint=/api/ESIM/PurhaseSim topKeys=${safeKeys.join(',')} durationMs=${durationMs}`)

          if (attempt === 1) {
            const refreshed = await this.refreshTokenFromConfig()
            console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} reason=401 refreshSuccess=${refreshed}`)
            if (refreshed) continue
          }

          return {
            success: false,
            error: {
              code: 'AIRHUB_AUTH_UNAUTHORIZED',
              message: hadToken
                ? 'AirHub purchase rejected the token (HTTP 401) and reauthentication failed'
                : 'AirHub purchase requires authentication (HTTP 401)',
              details: { authStage: hadToken ? 'purchase_token_rejected' : 'login_required', retryable: false, providerStatus: 401 },
            },
          }
        }

        let data: any
        try { data = JSON.parse(text) } catch {
          console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} httpStatus=${response.status} contentType=${contentType} durationMs=${durationMs} error=NON_JSON`)
          return { success: false, error: { code: 'PROVIDER_RESPONSE_INVALID', message: `AirHub returned non-JSON response (HTTP ${response.status})` } }
        }

        const dataKeys = data.data && typeof data.data === 'object' ? Object.keys(data.data) : []
        console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} httpStatus=${response.status} isSuccess=${data.isSuccess} durationMs=${durationMs} topKeys=${Object.keys(data).join(',')} dataKeys=${dataKeys.join(',')}`)

        if (!response.ok) {
          const code = this.classifyHttpError(response.status, data)
          return { success: false, error: { code, message: `AirHub returned HTTP ${response.status}: ${data.message || text.substring(0, 200)}`, details: { retryable: response.status >= 500, providerStatus: response.status } } }
        }

        if (data.isSuccess === false) {
          const code = this.classifyProviderError(data)
          return { success: false, error: { code: this.classifyProviderError(data), message: `AirHub rejected purchase: ${data.message || 'isSuccess=false'}`, details: { retryable: false, providerStatus: response.status } } }
        }

        const d = data.data || data
        const iccids = this.extractIccids(d, params.quantity)
        const orderId = d.orderId || d.order_id || d.transactionId || d.id || data.orderId || data.order_id || ''

        if (!iccids.length) {
          console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} warning=NO_ICCIDS orderId=${orderId} dataKeys=${Object.keys(d).join(',')}`)
          const pendingStatus = this.detectPendingStatus(d)
          if (pendingStatus) {
            console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} pendingStatus=${pendingStatus}`)
            return { success: true, data: { activationId: orderId, iccids: [], status: pendingStatus } }
          }
          return { success: false, error: { code: 'NO_ICCIDS', message: 'AirHub returned no ICCIDs in response', details: { retryable: false, providerStatus: response.status } } }
        }

        const activationCode = d.activationCode || d.data?.activationCode || d.lpa || d.data?.lpa || undefined
        const qrCodeUrl = d.qrCodeUrl || d.qr_code_url || d.data?.qrCodeUrl || d.data?.qr_code_url || undefined
        const matchingId = d.matchingId || d.matching_id || d.data?.matchingId || undefined
        const smdpAddress = d.smdpAddress || d.smdp_address || d.data?.smdpAddress || undefined
        const imsis = d.imsis || (d.imsi ? [d.imsi] : undefined)
        const activationCodes = activationCode ? [activationCode] : d.activationCodes || undefined

        if (!qrCodeUrl) {
          try {
            console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} step=FETCH_QR iccid=${iccids[0]}`)
            const qrResult = await this.getQRCode(iccids[0])
            if (qrResult.success && qrResult.data?.qrCodeUrl) {
              console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} step=FETCH_QR success=true`)
              return {
                success: true,
                data: {
                  activationId: orderId, iccids, imsis: imsis as string[] | undefined,
                  activationCodes, qrCodeUrl: qrResult.data.qrCodeUrl, matchingId, smdpAddress,
                  status: this.normalizeStatus(d.status || d.orderStatus || 'ACTIVATED'),
                },
              }
            }
            console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} step=FETCH_QR success=false reason=${qrResult.error?.code || 'unknown'}`)
          } catch (qrErr: any) {
            console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} step=FETCH_QR error=${qrErr.message?.substring(0, 100)}`)
          }
        }

        const status = this.normalizeStatus(d.status || d.orderStatus || 'ACTIVATED')
        console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} result=SUCCESS orderId=${orderId} iccidCount=${iccids.length} status=${status} durationMs=${durationMs}`)

        return {
          success: true,
          data: {
            activationId: orderId, iccids, imsis: imsis as string[] | undefined,
            activationCodes, qrCodeUrl, matchingId, smdpAddress, status,
          },
        }
      } catch (e: any) {
        const durationMs = Date.now() - startMs
        if (e.name === 'AbortError') {
          console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} error=TIMEOUT durationMs=${durationMs}`)
          return { success: false, error: { code: 'TIMEOUT', message: `AirHub activation timed out after ${durationMs}ms`, details: { retryable: true, providerStatus: undefined } } }
        }
        const causeCode = e?.cause?.code || ''
        let msg: string, code: string
        if (causeCode === 'ENOTFOUND') { code = 'NETWORK_ERROR'; msg = 'AirHub host not found (DNS failure)' }
        else if (causeCode === 'ECONNREFUSED') { code = 'NETWORK_ERROR'; msg = 'AirHub refused the connection' }
        else if (causeCode?.includes('TLS') || causeCode?.includes('CERT')) { code = 'NETWORK_ERROR'; msg = 'TLS connection to AirHub failed' }
        else { code = 'NETWORK_ERROR'; msg = `AirHub activation error: ${e.message?.substring(0, 200)}` }
        console.log(`[AIRHUB_PURCHASE] correlationId=${correlationId} error=${code} message=${msg.substring(0, 200)} durationMs=${durationMs}`)
        return { success: false, error: { code, message: msg, details: { retryable: true } } }
      }
    }
    return { success: false, error: { code: 'RETRIES_EXHAUSTED', message: 'AirHub activation exhausted retries' } }
  }

  async getStatus(subscriptionId: string): Promise<ConnectorResult<StatusResult>> {
    const correlationId = `airhub-status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { apiBaseUrl: true, apiToken: true, config: true } })
    if (!provider) return { success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }

    const tokenResult = await this.ensureAuthenticated()
    if (!tokenResult.success) return { success: false, error: tokenResult.error }

    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    const url = `${baseUrl.replace(/\/$/, '')}/api/ESIM/OrderDetails`
    const cfg = (provider.config as any) || {}
    const body = { partnerCode: cfg.partnerCode || 200652387, orderId: subscriptionId }

    console.log(`[AIRHUB_STATUS] correlationId=${correlationId} orderId=${subscriptionId}`)

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 20000)
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      const text = await response.text()
      let data: any
      try { data = JSON.parse(text) } catch {
        return { success: false, error: { code: 'PROVIDER_RESPONSE_INVALID', message: 'AirHub returned non-JSON status response' } }
      }

      console.log(`[AIRHUB_STATUS] correlationId=${correlationId} httpStatus=${response.status} isSuccess=${data.isSuccess}`)

      if (!response.ok) return { success: false, error: { code: `HTTP_${response.status}`, message: `AirHub status check returned ${response.status}` } }
      if (data.isSuccess === false) return { success: false, error: { code: 'PROVIDER_REJECTED', message: `AirHub rejected status check: ${data.message || 'isSuccess=false'}` } }

      const d = data.data || data
      const status = this.normalizeStatus(d.status || d.orderStatus || data.status || 'UNKNOWN')
      const iccids = this.extractIccids(d, 1)

      return { success: true, data: { status, iccids: iccids.length ? iccids : undefined, iccid: iccids[0] || undefined } }
    } catch (e: any) {
      if (e.name === 'AbortError') return { success: false, error: { code: 'TIMEOUT', message: 'AirHub status check timed out' } }
      return { success: false, error: { code: 'NETWORK_ERROR', message: `AirHub status error: ${e.message?.substring(0, 200)}` } }
    }
  }

  async getQRCode(iccid: string): Promise<ConnectorResult<{ qrCodeUrl: string }>> {
    const correlationId = `airhub-qr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { apiBaseUrl: true, apiToken: true, config: true } })
    if (!provider) return { success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }

    const tokenResult = await this.ensureAuthenticated()
    if (!tokenResult.success) return { success: false, error: tokenResult.error }

    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    const url = `${baseUrl.replace(/\/$/, '')}/api/ESIM/GetActivationCode`
    const cfg = (provider.config as any) || {}
    const body = { partnerCode: cfg.partnerCode || 200652387, iccid }

    console.log(`[AIRHUB_QR] correlationId=${correlationId} iccid=${iccid}`)

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 20000)
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      const text = await response.text()
      let data: any
      try { data = JSON.parse(text) } catch {
        return { success: false, error: { code: 'PROVIDER_RESPONSE_INVALID', message: 'AirHub returned non-JSON QR response' } }
      }

      console.log(`[AIRHUB_QR] correlationId=${correlationId} httpStatus=${response.status} isSuccess=${data.isSuccess}`)

      if (!response.ok) return { success: false, error: { code: `HTTP_${response.status}`, message: `AirHub QR retrieval returned ${response.status}` } }
      if (data.isSuccess === false) return { success: false, error: { code: 'PROVIDER_REJECTED', message: `AirHub rejected QR request: ${data.message || 'isSuccess=false'}` } }

      const d = data.data || data
      const qrCodeUrl = d.qrCodeUrl || d.qr_code_url || d.qrCode || d.activationCode || d.data?.qrCodeUrl || d.data?.qr_code_url || d.data?.qrCode || d.data?.activationCode || ''

      if (!qrCodeUrl) return { success: false, error: { code: 'NO_QR_CODE', message: 'AirHub returned no QR code data' } }
      return { success: true, data: { qrCodeUrl } }
    } catch (e: any) {
      if (e.name === 'AbortError') return { success: false, error: { code: 'TIMEOUT', message: 'AirHub QR retrieval timed out' } }
      return { success: false, error: { code: 'NETWORK_ERROR', message: `AirHub QR error: ${e.message?.substring(0, 200)}` } }
    }
  }

  async getUsage(_iccid: string): Promise<ConnectorResult<UsageResult>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Usage retrieval not supported for AirHub' } } }
  async suspendESIM(_subscriptionId: string): Promise<ConnectorResult<void>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Suspend not supported for AirHub' } } }
  async resumeESIM(_subscriptionId: string): Promise<ConnectorResult<void>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Resume not supported for AirHub' } } }
  async getRates(): Promise<ConnectorResult<RateResult[]>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Rates not supported for AirHub' } } }
  async topUpESIM(_params: TopUpESIMParams): Promise<ConnectorResult<TopUpESIMResult>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Top-up not supported for AirHub' } } }

  private extractIccids(d: any, minCount: number): string[] {
    const iccids: string[] = []
    const candidates = [
      d.iccids, d.iccid_list, d.data?.iccids, d.data?.iccid_list,
      d.esim?.iccids, d.order?.iccids, d.result?.iccids,
    ]
    for (const c of candidates) {
      if (Array.isArray(c) && c.length >= minCount) return c.map(String)
      if (Array.isArray(c) && c.length > 0 && !iccids.length) iccids.push(...c.map(String))
    }
    const singles = [d.iccid, d.data?.iccid, d.esim?.iccid, d.result?.iccid, d.sim?.iccid, d.sims?.[0]?.iccid]
    for (const s of singles) {
      if (s && typeof s === 'string' && s.length >= 10 && !iccids.includes(s)) { iccids.push(s); break }
    }
    return iccids
  }

  private normalizeStatus(raw: string): 'PENDING' | 'PENDING_ACTIVATION' | 'ACTIVE' | 'PROCESSING' {
    if (!raw) return 'PENDING'
    const s = raw.toUpperCase()
    // Only ACTIVE from status check (not purchase) means network-active
    if (s === 'ACTIVE') return 'ACTIVE'
    // AirHub purchase completion states → provisioned but not device-active
    if (s === 'COMPLETED' || s === 'SUCCESS' || s === 'ACTIVATED') return 'PENDING_ACTIVATION'
    if (s === 'PROCESSING' || s === 'QUEUED' || s === 'PENDING' || s === 'IN_PROGRESS' || s === 'INITIATED') return 'PROCESSING'
    return 'PENDING'
  }

  private detectPendingStatus(d: any): 'PENDING' | 'PROCESSING' | null {
    const raw = (d.status || d.orderStatus || '').toString().toUpperCase()
    if (['PROCESSING', 'QUEUED', 'PENDING', 'IN_PROGRESS', 'INITIATED'].includes(raw)) {
      if (raw === 'PROCESSING' || raw === 'QUEUED' || raw === 'IN_PROGRESS') return 'PROCESSING'
      return 'PENDING'
    }
    return null
  }

  private classifyHttpError(status: number, data: any): string {
    const msg = (data?.message || '').toLowerCase()
    if (status === 401 || status === 403) return 'AUTH_ERROR'
    if (status === 404) return 'NOT_FOUND'
    if (status === 429) return 'RATE_LIMITED'
    if (status === 402) return 'INSUFFICIENT_BALANCE'
    if (status === 400) {
      if (msg.includes('balance') || msg.includes('insufficient')) return 'INSUFFICIENT_BALANCE'
      if (msg.includes('plan') || msg.includes('package') || msg.includes('invalid')) return 'VALIDATION_ERROR'
      return 'VALIDATION_ERROR'
    }
    if (status >= 500) return 'PROVIDER_UNAVAILABLE'
    return 'PROVIDER_ERROR'
  }

  private classifyProviderError(data: any): string {
    const msg = (data.message || data.error || '').toLowerCase()
    if (msg.includes('auth') || msg.includes('login') || msg.includes('credential')) return 'AUTH_ERROR'
    if (msg.includes('balance') || msg.includes('insufficient') || msg.includes('credit')) return 'INSUFFICIENT_BALANCE'
    if (msg.includes('plan') || msg.includes('package') || msg.includes('sku')) return 'INVALID_PACKAGE'
    if (msg.includes('duplicate') || msg.includes('already') || msg.includes('exists')) return 'DUPLICATE_REQUEST'
    if (msg.includes('timeout') || msg.includes('unavailable') || msg.includes('maintenance')) return 'PROVIDER_UNAVAILABLE'
    return 'VALIDATION_ERROR'
  }

  /** Standard connector interface — delegates to AirHub's wallet endpoint */
  async getBalance(): Promise<ConnectorResult<{ balance: number | null; currency: string | null; accountId?: string | null; accountName?: string | null }>> {
    const result = await this.getWalletBalance()
    if (!result.success) return result as any
    return {
      success: true,
      data: { balance: result.data!.balance, currency: result.data!.currency, accountId: null, accountName: null },
    }
  }

  async getWalletBalance(): Promise<ConnectorResult<{ balance: number; currency: string; transactions?: any[]; rawAvailable?: any }>> {
    const tokenCheck = await this.ensureAuthenticated()
    if (!tokenCheck.success) return { success: false, error: tokenCheck.error || { code: 'NO_TOKEN', message: 'No token available' } }

    const provider = await prisma.provider.findUnique({ where: { id: this.providerId } })
    if (!provider) return { success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }

    const cfg = (provider.config as any) || {}
    const partnerCode = cfg.partnerCode
    if (!partnerCode) return { success: false, error: { code: 'NO_PARTNER_CODE', message: 'Partner code not configured' } }

    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    const flag = cfg.flag ?? 6
    const countryCode = cfg.countryCode ?? ''
    const multiplecountrycode = Array.isArray(cfg.multiplecountrycode) ? cfg.multiplecountrycode : ['UK']

    // Use the documented POST /api/ESIM/GetWallet endpoint
    const url = `${baseUrl.replace(/\/$/, '')}/api/ESIM/GetWallet`
    const body = { partnerCode: Number(partnerCode), flag, countryCode, multiplecountrycode }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 25000)
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      const text = await response.text()
      let data: any
      try { data = JSON.parse(text) } catch {
        return { success: false, error: { code: 'NON_JSON', message: 'Wallet response is not valid JSON' } }
      }

      if (response.status === 401) return { success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }
      if (!response.ok) return { success: false, error: { code: `HTTP_${response.status}`, message: `Wallet fetch failed: HTTP ${response.status}` } }
      if (data.isSuccess === false) return { success: false, error: { code: 'PROVIDER_REJECTED', message: data.message || 'Provider rejected wallet request' } }

      // Safe diagnostic logging
      const topKeys = Object.keys(data)
      const nested = data.data && typeof data.data === 'object' ? Object.keys(data.data) : []
      console.log(`[AIRHUB_WALLET] httpStatus=${response.status} topKeys=${topKeys.join(',')} nestedKeys=${nested.join(',')}`)

      // Robust balance parsing
      const balanceFields = ['balance', 'Balance', 'walletBalance', 'wallet_balance', 'currentBalance', 'current_balance',
        'availableBalance', 'available_balance', 'amount', 'data.balance', 'data.Balance', 'data.walletBalance',
        'data.wallet_balance', 'data.currentBalance', 'data.current_balance', 'data.availableBalance',
        'data.available_balance', 'data.amount', 'response.balance', 'response.walletBalance']
      let balanceRaw: any = null
      let balanceFieldPath = ''
      for (const f of balanceFields) {
        const parts = f.split('.')
        let v: any = data
        for (const p of parts) { if (v && typeof v === 'object') v = v[p]; else { v = null; break } }
        if (v != null) { balanceRaw = v; balanceFieldPath = f; break }
      }

      if (balanceRaw == null) {
        const tryLegacy = async () => {
          const legUrl = `${baseUrl.replace(/\/$/, '')}/api/ESIM/get_wallet_invidual?partnercode=${encodeURIComponent(String(partnerCode))}`
          const lr = await fetch(legUrl, { headers: { 'Authorization': `Bearer ${this.token}`, 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) })
          const lt = await lr.text(); try { return JSON.parse(lt) } catch { return null }
        }
        const legacy = await tryLegacy()
        if (legacy) {
          const lb = legacy.balance ?? legacy.Balance ?? legacy.walletBalance ?? legacy.data?.balance
          if (lb != null) { balanceRaw = lb; balanceFieldPath = 'legacy:get_wallet_invidual.balance' }
        }
      }

      if (balanceRaw == null) {
        return { success: false, error: { code: 'MALFORMED_RESPONSE', message: `No balance field found. Keys: ${topKeys.join(', ')}${nested.length ? '; nested: ' + nested.join(', ') : ''}` } }
      }

      const rawStr = String(balanceRaw).replace(/,/g, '')
      const balance = parseFloat(rawStr)
      if (isNaN(balance)) {
        return { success: false, error: { code: 'MALFORMED_RESPONSE', message: `Balance "${String(balanceRaw).substring(0, 50)}" is not a valid number` } }
      }

      // Currency parsing
      const currencyFields = ['currency', 'currencyCode', 'currency_code', 'Currency']
      let curr: string | null = null
      for (const f of currencyFields) {
        if (data[f]) { curr = String(data[f]); break }
        if (data.data?.[f]) { curr = String(data.data[f]); break }
      }
      const currency = curr || cfg.currency || 'USD'

      // Transaction history extraction
      const txFields = ['transactions', 'transactionHistory', 'transaction_history', 'walletHistory', 'wallet_history',
        'orders', 'orderHistory', 'order_history']
      let txArray: any[] | null = null
      for (const f of txFields) {
        if (Array.isArray(data[f])) { txArray = data[f]; break }
        if (Array.isArray(data.data?.[f])) { txArray = data.data[f]; break }
      }

      const transactions = txArray?.map((t: any, idx: number) => ({
        providerReference: String(t.reference || t.orderId || t.order_id || t.id || `tx-${idx}`),
        orderId: t.orderId || t.order_id || t.OrderID || null,
        occurredAt: t.date || t.transactionDate || t.createdAt || t.created_at || new Date().toISOString(),
        description: t.description || t.note || t.memo || t.Description || '',
        transactionType: normalizeTxType(t.type || t.transactionType || t.TransactionType || t.crDr || ''),
        amount: parseFloat(String(t.amount ?? t.Amount ?? t.value ?? 0)) || 0,
        currency: t.currency || t.Currency || currency,
        balanceBefore: t.balanceBefore != null ? parseFloat(String(t.balanceBefore)) : undefined,
        balanceAfter: t.balanceAfter != null ? parseFloat(String(t.balanceAfter)) : undefined,
        runningBalance: t.runningBalance != null ? parseFloat(String(t.runningBalance)) : undefined,
      })) || []

      console.log(`[AIRHUB_WALLET] balancePath=${balanceFieldPath} balanceType=${typeof balanceRaw} txCount=${transactions.length}`)

      return { success: true, data: { balance, currency, transactions, rawAvailable: data.available || data.data?.available || null } }
    } catch (e: any) {
      if (e.name === 'AbortError') return { success: false, error: { code: 'TIMEOUT', message: 'Wallet fetch timed out after 25 seconds' } }
      if (e?.cause?.code === 'ENOTFOUND') return { success: false, error: { code: 'DNS_ERROR', message: 'AirHub host not found' } }
      return { success: false, error: { code: 'NETWORK_ERROR', message: e.message?.substring(0, 100) || 'Network error' } }
    }
  }
}

function normalizeTxType(raw: string): string {
  const s = (raw || '').toUpperCase()
  if (['DEBIT', 'PURCHASE', 'ORDER', 'CHARGE', 'DEDUCTION', 'OUT'].includes(s)) return 'DEBIT'
  if (['CREDIT', 'REFUND', 'DEPOSIT', 'TOPUP', 'TOP_UP', 'ADD', 'IN'].includes(s)) return 'CREDIT'
  if (['ADJUSTMENT', 'ADJ', 'CORRECTION'].includes(s)) return 'ADJUSTMENT'
  return 'UNKNOWN'
}
