import { prisma } from '@/lib/prisma'
import { decryptToken } from '@/lib/encryption'
import { TELNA_ENDPOINTS, type TelnaEndpoint, type TelnaPaginatedResponse, type TelnaCountry, type TelnaCompany, type TelnaInventory, type TelnaGroup, type TelnaWallet, type TelnaPackageTemplate, type TelnaPackageTemplateDetail, type TelnaPackage, type TelnaSimRegistry } from './telna-endpoints'
import type { IProviderConnector, ConnectorResult, ConnectorPlan, ActivateESIMParams, ActivateESIMResult, TopUpESIMParams, TopUpESIMResult, UsageResult, StatusResult, RateResult, TokenState } from './connector-interface'

interface TelnaRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  endpoint: TelnaEndpoint
  pathParams?: Record<string, string | number>
  query?: Record<string, string | number | undefined>
  body?: unknown
  timeoutMs?: number
}

interface TelnaRequestResult {
  success: boolean
  status?: number
  data?: unknown
  error?: { code: string; message: string }
  latencyMs?: number
  requestId?: string
}

function generateRequestId(): string {
  return `telna-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function maskToken(token: string): string {
  if (!token || token.length < 8) return token
  return token.slice(0, 4) + '••••' + token.slice(-4)
}

export class TelnaConnector implements IProviderConnector {
  readonly providerId: string
  readonly name: string

  constructor(providerId: string, name: string | undefined) {
    this.providerId = providerId
    this.name = name || 'Telna'
  }

  private async loadProvider(): Promise<{
    apiBaseUrl: string
    keyId: string
    authorizationMode: 'BEARER' | 'RAW'
    apiVersion: string
  } | null> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId } })
    if (!provider) return null

    const config = (provider.config as Record<string, unknown>) || {}
    const keyId = decryptToken(provider.apiToken)
    if (!keyId) return null

    return {
      apiBaseUrl: (provider.apiBaseUrl || 'https://developer-api.telna.com').replace(/\/+$/, ''),
      keyId,
      authorizationMode: (config.authorizationMode as 'BEARER' | 'RAW') || 'BEARER',
      apiVersion: provider.apiVersion || '2.1',
    }
  }

  private async request(opts: TelnaRequestOptions): Promise<TelnaRequestResult> {
    const requestId = generateRequestId()
    const startTime = Date.now()
    const providerConfig = await this.loadProvider()
    if (!providerConfig) {
      return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not found or KeyID not configured' }, requestId }
    }

    const { apiBaseUrl, keyId, authorizationMode } = providerConfig
    const method = opts.method || 'GET'
    let path: string = TELNA_ENDPOINTS[opts.endpoint]
    if (opts.pathParams) {
      for (const [key, value] of Object.entries(opts.pathParams)) {
        path = path.replace(`{${key}}`, String(value))
      }
    }
    const timeoutMs = opts.timeoutMs || 15000

    let url = `${apiBaseUrl}${path}`

    if (opts.query) {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined && value !== null && value !== '') {
          params.set(key, String(value))
        }
      }
      const qs = params.toString()
      if (qs) url += `?${qs}`
    }

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    }

    if (authorizationMode === 'RAW') {
      headers['Authorization'] = keyId
    } else {
      headers['Authorization'] = `Bearer ${keyId}`
    }

    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    console.log(`[TELNA_REQUEST] method=${method} path=${path} authorizationMode=${authorizationMode} hasToken=true requestId=${requestId}`)

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

      const response = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      const status = response.status
      const text = await response.text()
      const latencyMs = Date.now() - startTime

      console.log(`[TELNA_RESPONSE] method=${method} path=${path} status=${status} latencyMs=${latencyMs} requestId=${requestId}`)

      if (status === 401) {
        return { success: false, status, error: { code: 'HTTP_401', message: 'Authentication rejected — check KeyID' }, latencyMs, requestId }
      }
      if (status === 403) {
        return { success: false, status, error: { code: 'HTTP_403', message: 'KeyID lacks permission for this resource' }, latencyMs, requestId }
      }
      if (status === 404) {
        return { success: false, status, error: { code: 'HTTP_404', message: 'Resource not found' }, latencyMs, requestId }
      }
      if (status === 429) {
        return { success: false, status, error: { code: 'HTTP_429', message: 'Rate limited — too many requests' }, latencyMs, requestId }
      }
      if (status >= 400 && status < 500) {
        const msg = text ? text.substring(0, 300) : 'Bad request'
        return { success: false, status, error: { code: `HTTP_${status}`, message: msg }, latencyMs, requestId }
      }
      if (status >= 500) {
        return { success: false, status, error: { code: `HTTP_${status}`, message: 'Provider server error' }, latencyMs, requestId }
      }

      if (!text) {
        return { success: true, status, data: null, latencyMs, requestId }
      }

      try {
        const json = JSON.parse(text)
        return { success: true, status, data: json, latencyMs, requestId }
      } catch {
        return { success: false, status, error: { code: 'INVALID_JSON', message: 'Response was not valid JSON' }, latencyMs, requestId }
      }
    } catch (e: unknown) {
      const latencyMs = Date.now() - startTime
      if (e instanceof Error && e.name === 'AbortError') {
        return { success: false, error: { code: 'TIMEOUT', message: 'Request timed out' }, latencyMs, requestId }
      }
      const msg = e instanceof Error ? e.message : 'Unknown error'
      return { success: false, error: { code: 'NETWORK_ERROR', message: msg }, latencyMs, requestId }
    }
  }

  async testConnection(): Promise<ConnectorResult<{ message: string; latencyMs?: number }>> {
    const result = await this.request({ method: 'GET', endpoint: 'countries', query: { count: 1, offset: 0 } })

    console.log(`[TELNA_TEST_CONNECTION] success=${result.success} status=${result.status} latencyMs=${result.latencyMs} requestId=${result.requestId}`)

    if (result.success) {
      return { success: true, data: { message: 'Connected to Telna API', latencyMs: result.latencyMs } }
    }

    const msg = result.error?.message || 'Connection test failed'
    return { success: false, error: { code: result.error?.code || 'UNKNOWN', message: msg } }
  }

  async diagnoseConnection(): Promise<ConnectorResult<any>> {
    return this.testConnection()
  }

  async authenticate(_credentials: Record<string, string>): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Telna uses pre-configured KeyID, not runtime authentication' } }
  }

  async getTokenState(): Promise<TokenState> {
    return { tokenPresent: true, expiryPresent: false, expired: false, expiresSoon: false, tokenExpiry: null }
  }

  async ensureAuthenticated(): Promise<ConnectorResult<void>> {
    const cfg = await this.loadProvider()
    if (!cfg) return { success: false, error: { code: 'NO_TOKEN', message: 'KeyID not configured' } }
    return { success: true }
  }

  async refreshAuthentication(): Promise<boolean> {
    return false
  }

  async syncPlans(): Promise<ConnectorResult<ConnectorPlan[]>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Plan sync not implemented for Telna connector' } }
  }

  async activateESIM(_params: ActivateESIMParams): Promise<ConnectorResult<ActivateESIMResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Activation not implemented for Telna connector' } }
  }

  async getStatus(_subscriptionId: string): Promise<ConnectorResult<StatusResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Status not implemented for Telna connector' } }
  }

  async getUsage(_iccid: string): Promise<ConnectorResult<UsageResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Usage not implemented for Telna connector' } }
  }

  async suspendESIM(_subscriptionId: string): Promise<ConnectorResult<void>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Suspend not implemented for Telna connector' } }
  }

  async resumeESIM(_subscriptionId: string): Promise<ConnectorResult<void>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Resume not implemented for Telna connector' } }
  }

  async getRates(): Promise<ConnectorResult<RateResult[]>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Rates not implemented for Telna connector' } }
  }

  async getQRCode(_iccid: string): Promise<ConnectorResult<{ qrCodeUrl: string }>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'QR code not implemented for Telna connector' } }
  }

  async topUpESIM(_params: TopUpESIMParams): Promise<ConnectorResult<TopUpESIMResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Top-up not implemented for Telna connector' } }
  }

  // ── Discovery Layer (Telna Phase 1B) ──────────────────────────────────

  async listCountries(count?: number, offset?: number): Promise<ConnectorResult<{ items: TelnaCountry[]; total: number }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'countries', query: { count, offset } })
    const duration = Date.now() - start
    const items = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaCountry>).data : []) || []
    const total = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaCountry>).total : 0) || 0
    console.log(`[TELNA_DISCOVERY] method=listCountries success=${result.success} status=${result.status} itemCount=${items.length} total=${total} durationMs=${duration} requestId=${result.requestId}`)
    if (!result.success) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Failed to list countries' } }
    }
    return { success: true, data: { items, total } }
  }

  async getCompany(companyId: number): Promise<ConnectorResult<{ company: TelnaCompany }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'company', pathParams: { company_id: companyId } })
    const duration = Date.now() - start
    const company = result.success && result.data ? (result.data as { data: TelnaCompany }).data : null
    console.log(`[TELNA_DISCOVERY] method=getCompany companyId=${companyId} success=${result.success} status=${result.status} durationMs=${duration} requestId=${result.requestId}`)
    if (!result.success || !company) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Company not found' } }
    }
    return { success: true, data: { company } }
  }

  async listInventories(company?: number, count?: number, offset?: number): Promise<ConnectorResult<{ items: TelnaInventory[]; total: number }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'inventories', query: { company_id: company, count, offset } })
    const duration = Date.now() - start
    const items = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaInventory>).data : []) || []
    const total = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaInventory>).total : 0) || 0
    console.log(`[TELNA_DISCOVERY] method=listInventories company=${company} success=${result.success} status=${result.status} itemCount=${items.length} total=${total} durationMs=${duration} requestId=${result.requestId}`)
    if (!result.success) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Failed to list inventories' } }
    }
    return { success: true, data: { items, total } }
  }

  async listGroups(inventoryId?: number, company?: number, count?: number, offset?: number): Promise<ConnectorResult<{ items: TelnaGroup[]; total: number }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'groups', query: { inventory_id: inventoryId, company_id: company, count, offset } })
    const duration = Date.now() - start
    const items = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaGroup>).data : []) || []
    const total = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaGroup>).total : 0) || 0
    console.log(`[TELNA_DISCOVERY] method=listGroups inventoryId=${inventoryId} company=${company} success=${result.success} status=${result.status} itemCount=${items.length} total=${total} durationMs=${duration} requestId=${result.requestId}`)
    if (!result.success) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Failed to list groups' } }
    }
    return { success: true, data: { items, total } }
  }

  async getWallet(walletId: number): Promise<ConnectorResult<{ wallet: TelnaWallet }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'wallet', pathParams: { wallet_id: walletId } })
    const duration = Date.now() - start
    const wallet = result.success && result.data ? (result.data as { data: TelnaWallet }).data : null
    console.log(`[TELNA_DISCOVERY] method=getWallet walletId=${walletId} success=${result.success} status=${result.status} durationMs=${duration} requestId=${result.requestId}`)
    if (!result.success || !wallet) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Wallet not found' } }
    }
    return { success: true, data: { wallet } }
  }

  // ── Package Template Discovery (Telna Phase 2A) ───────────────────────

  async listPackageTemplates(inventoryId?: number, count?: number, offset?: number): Promise<ConnectorResult<{ items: TelnaPackageTemplate[]; total: number }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'packageTemplates', query: { inventory_id: inventoryId, count, offset } })
    const duration = Date.now() - start
    const items = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaPackageTemplate>).data : []) || []
    const total = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaPackageTemplate>).total : 0) || 0
    console.log(`[TELNA_PACKAGE_TEMPLATES] status=${result.status} requestId=${result.requestId} itemCount=${items.length} durationMs=${duration} inventoryId=${inventoryId}`)
    if (!result.success) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Failed to list package templates' } }
    }
    return { success: true, data: { items, total } }
  }

  async getPackageTemplate(packageTemplateId: number): Promise<ConnectorResult<{ template: TelnaPackageTemplateDetail }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'packageTemplate', pathParams: { package_template_id: packageTemplateId } })
    const duration = Date.now() - start
    const template = result.success && result.data ? (result.data as { data: TelnaPackageTemplateDetail }).data : null
    console.log(`[TELNA_PACKAGE_TEMPLATE_DETAIL] templateId=${packageTemplateId} status=${result.status} requestId=${result.requestId} durationMs=${duration}`)
    if (!result.success || !template) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Package template not found' } }
    }
    return { success: true, data: { template } }
  }

  // ── Package Sync (Telna Phase 2B) ────────────────────────────────────

  async listPackages(inventoryId?: number, packageTemplateId?: number, count?: number, offset?: number): Promise<ConnectorResult<{ items: TelnaPackage[]; total: number }>> {
    const start = Date.now()
    const result = await this.request({
      method: 'GET', endpoint: 'packages',
      query: { inventory_id: inventoryId, package_template_id: packageTemplateId, count, offset },
    })
    const duration = Date.now() - start
    const items = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaPackage>).data : []) || []
    const total = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaPackage>).total : 0) || 0
    console.log(`[TELNA_PACKAGES] status=${result.status} requestId=${result.requestId} itemCount=${items.length} total=${total} durationMs=${duration} inventoryId=${inventoryId}`)
    if (!result.success) {
      return { success: false, error: { code: result.error?.code || 'SYNC_FAILED', message: result.error?.message || 'Failed to list packages' } }
    }
    return { success: true, data: { items, total } }
  }

  async getPackage(packageId: number): Promise<ConnectorResult<{ pkg: TelnaPackage }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'package', pathParams: { package_id: packageId } })
    const duration = Date.now() - start
    const pkg = result.success && result.data ? (result.data as { data: TelnaPackage }).data : null
    console.log(`[TELNA_PACKAGE_DETAIL] packageId=${packageId} status=${result.status} requestId=${result.requestId} durationMs=${duration}`)
    if (!result.success || !pkg) {
      return { success: false, error: { code: result.error?.code || 'SYNC_FAILED', message: result.error?.message || 'Package not found' } }
    }
    return { success: true, data: { pkg } }
  }

  // ── SIM Registry (Telna Phase 3) ──────────────────────────────────────

  async listSimRegistries(inventoryId?: number, groupId?: number, status?: string, iccid?: string, imsi?: string, count?: number, offset?: number): Promise<ConnectorResult<{ items: TelnaSimRegistry[]; total: number }>> {
    const start = Date.now()
    const result = await this.request({
      method: 'GET', endpoint: 'simRegistries',
      query: { inventory_id: inventoryId, group_id: groupId, status, iccid, imsi, count, offset },
    })
    const duration = Date.now() - start
    const items = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaSimRegistry>).data : []) || []
    const total = (result.success && result.data ? (result.data as TelnaPaginatedResponse<TelnaSimRegistry>).total : 0) || 0
    console.log(`[TELNA_SIM_REGISTRIES] status=${result.status} requestId=${result.requestId} itemCount=${items.length} total=${total} durationMs=${duration} inventoryId=${inventoryId} groupId=${groupId}`)
    if (!result.success) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'Failed to list SIM registries' } }
    }
    return { success: true, data: { items, total } }
  }

  async getSimRegistry(iccid: string): Promise<ConnectorResult<{ sim: TelnaSimRegistry }>> {
    const start = Date.now()
    const result = await this.request({ method: 'GET', endpoint: 'simRegistry', pathParams: { iccid } })
    const duration = Date.now() - start
    const sim = result.success && result.data ? (result.data as { data: TelnaSimRegistry }).data : null
    console.log(`[TELNA_SIM_REGISTRY_DETAIL] iccid=${iccid} status=${result.status} requestId=${result.requestId} durationMs=${duration}`)
    if (!result.success || !sim) {
      return { success: false, error: { code: result.error?.code || 'DISCOVERY_FAILED', message: result.error?.message || 'SIM registry entry not found' } }
    }
    return { success: true, data: { sim } }
  }
}
