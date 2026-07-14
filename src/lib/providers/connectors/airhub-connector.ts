import { encryptToken, decryptToken } from '@/lib/encryption'
import { prisma } from '@/lib/prisma'
import { recordHealthEvent } from '@/lib/services/providers/health-monitor'
import type { IProviderConnector, ConnectorResult, ConnectorPlan, DiagnosticInfo, ActivateESIMParams, ActivateESIMResult, UsageResult, StatusResult, RateResult, TopUpESIMParams, TopUpESIMResult } from './connector-interface'

export class AirHubConnector implements IProviderConnector {
  readonly providerId: string
  readonly name: string = 'AirHub'
  private token: string | null = null

  constructor(providerId: string, token?: string | null) {
    this.providerId = providerId
    this.token = token || null
  }

  async authenticate(credentials: Record<string, string>): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId } })
    if (!provider) return { success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }

    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    const authPath = provider.authUrl || '/api/Authentication/UserLogin'
    const url = `${baseUrl.replace(/\/$/, '')}/${authPath.replace(/^\//, '')}`

    console.log(`[AIRHUB_AUTH_START] providerId=${this.providerId} baseUrl=${baseUrl} resolvedUrl=${url}`)
    console.log(`[AIRHUB_AUTH_REQUEST] method=POST bodyFields=userName,password`)

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 25000)
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ userName: credentials.username, password: credentials.password }),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      const text = await response.text()
      let data: any
      try { data = JSON.parse(text) } catch {
        return { success: false, error: { code: 'NON_JSON', message: 'AirHub returned non-JSON response' } }
      }

      const respKeys = Object.keys(data)
      console.log(`[AIRHUB_AUTH_RESPONSE] httpStatus=${response.status} isSuccess=${data.isSuccess} responseKeys=${respKeys.join(',')} tokenFound=${!!(data.token || data.data?.token)}`)

      if (!response.ok) return { success: false, error: { code: `HTTP_${response.status}`, message: `AirHub auth failed: HTTP ${response.status}` } }
      if (data.isSuccess === false) return { success: false, error: { code: 'AUTH_REJECTED', message: `AirHub rejected: ${data.message || 'unknown'}` } }

      const token = data.token || data.accessToken || data.access_token || data.data?.token || ''
      if (!token || token.length < 8) return { success: false, error: { code: 'NO_TOKEN', message: 'No valid token returned' } }

      const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token.trim()
      const partnerCode = (data as any).partnerCode || (data as any).data?.partnerCode || (provider.config as any)?.partnerCode
      const tokenExpiry = data.token_expire || data.expiresAt || null

      await prisma.provider.update({
        where: { id: this.providerId },
        data: {
          apiToken: encryptToken(cleanToken),
          tokenPlacement: 'HEADER',
          lastSuccessfulConnection: new Date(),
          lastError: null,
          errorCount: 0,
          config: {
            ...((provider.config as any) || {}),
            lastAuthenticatedAt: new Date().toISOString(),
            authEnvironmentAtAuth: ((provider.config as any)?.upstreamEnvironment) || provider.environment || 'production',
          },
        },
      })

      await recordHealthEvent(this.providerId, { eventType: 'CONNECTION_TEST', success: true, message: 'AirHub authenticated' })

      console.log(`[AIRHUB_AUTH_RESULT] success=true tokenPersisted=true tokenExpiryPresent=${!!tokenExpiry} partnerCode=${partnerCode}`)
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
    // Load token + provider
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId }, select: { apiBaseUrl: true, apiToken: true, config: true } })
    if (!provider) return { success: false, error: { code: 'NOT_FOUND', message: 'Provider not found' } }
    if (!this.token && provider.apiToken) {
      try { this.token = decryptToken(provider.apiToken) || null } catch {}
    }
    if (!this.token) return { success: false, error: { code: 'NO_TOKEN', message: 'No token. Authenticate first.' } }

    const config = (provider.config as any) || {}
    const partnerCode = config.partnerCode || 200652387
    const flag = config.flag || 6
    const countryCode = config.countryCode ?? ''
    const multiplecountrycode = config.multiplecountrycode || ['UK']
    if (!multiplecountrycode?.length) return { success: false, error: { code: 'MISSING_CONFIG', message: 'multiplecountrycode empty' } }

    const baseUrl = provider.apiBaseUrl || 'https://api.airhubapp.com'
    const url = `${baseUrl.replace(/\/$/, '')}/api/ESIM/GetPlanInformation`
    const body = { partnerCode, flag, countryCode, multiplecountrycode }
    console.log(`[AIRHUB_GET_PLANS_REQUEST] url=${url} partnerCode=${partnerCode} flag=${flag}`)

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
      let data: any; try { data = JSON.parse(text) } catch { return { success: false, error: { code: 'NON_JSON', message: 'Non-JSON response' } } }

      console.log(`[AIRHUB_GET_PLANS_RESPONSE] status=${response.status} isSuccess=${data.isSuccess}`)
      if (!response.ok) return { success: false, error: { code: `HTTP_${response.status}`, message: `AirHub returned ${response.status}` } }
      if (data.isSuccess === false) return { success: false, error: { code: 'PROVIDER_REJECTED', message: `AirHub rejected: ${data.message || ''}` } }

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
      return { success: false, error: { code: 'NETWORK_ERROR', message: e.message?.substring(0, 200) } }
    }
  }

  // Stub methods — not yet implemented for AirHub
  async activateESIM(): Promise<ConnectorResult<ActivateESIMResult>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Not implemented' } } }
  async getStatus(): Promise<ConnectorResult<StatusResult>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Not implemented' } } }
  async getUsage(): Promise<ConnectorResult<UsageResult>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Not implemented' } } }
  async suspendESIM(): Promise<ConnectorResult<void>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Not implemented' } } }
  async resumeESIM(): Promise<ConnectorResult<void>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Not implemented' } } }
  async getRates(): Promise<ConnectorResult<RateResult[]>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Not implemented' } } }
  async getQRCode(): Promise<ConnectorResult<{ qrCodeUrl: string }>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Not implemented' } } }
  async topUpESIM(): Promise<ConnectorResult<TopUpESIMResult>> { return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Not implemented' } } }
}
