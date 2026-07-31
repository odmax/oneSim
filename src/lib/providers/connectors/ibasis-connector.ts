import { prisma } from '@/lib/prisma'
import { decryptToken } from '@/lib/encryption'
import { recordHealthEvent } from '@/lib/services/providers/health-monitor'
import type {
  IProviderConnector, ConnectorResult, ConnectorPlan, DiagnosticInfo,
  ActivateESIMParams, ActivateESIMResult, UsageResult, StatusResult,
  RateResult, TopUpESIMParams, TopUpESIMResult, TokenState,
} from './connector-interface'

/**
 * iBASIS Consumer Offer API connector.
 *
 * Phase 1 scope: authentication via a static API token and safe connection
 * testing against the inventory endpoint. Purchasing, plan sync, status,
 * suspend/resume and QR retrieval are declared capabilities but are wired in
 * later phases.
 *
 * Authentication is done by sending the configured token in an
 * `Authorization: Token <token>` header (never `Bearer`).
 *
 * The base URL and all behavior come from provider database configuration
 * (provider.config / provider.apiBaseUrl / provider.apiToken) — nothing is
 * hard-coded in source.
 */

interface IbasisConfig {
  baseUrl: string
  apiToken: string
  requestTimeoutMs: number
  environment: string
  defaultCurrency: string
  inventoryPath: string
  inventoryPageSize: number
}

interface IbasisRequestResult {
  success: boolean
  status?: number
  data?: any
  error?: { code: string; message: string }
  latencyMs?: number
}

const DEFAULT_INVENTORY_PATH = '/api/v1/inventory/sims'
const DEFAULT_REQUEST_TIMEOUT_MS = 15000
const DEFAULT_PAGE_SIZE = 1
const TOKEN_HEADER_PREFIX = 'Token '

function generateCorrelationId(): string {
  return `ibs-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
}

/** Masks a token for safe logging/diagnostics. Never log the raw token. */
export function maskToken(token: string | null | undefined): string {
  if (!token) return ''
  if (token.length <= 8) return '••••'
  return `${token.slice(0, 4)}••••${token.slice(-4)}`
}

function looksLikeHtml(text: string): boolean {
  const trimmed = text.trimStart().toLowerCase()
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || trimmed.startsWith('<head')
}

export class IbasisConnector implements IProviderConnector {
  readonly providerId: string
  readonly name: string = 'iBASIS'

  constructor(providerId: string) {
    this.providerId = providerId
  }

  private async loadConfig(): Promise<IbasisConfig | null> {
    const provider = await prisma.provider.findUnique({ where: { id: this.providerId } })
    if (!provider) return null
    const cfg = (provider.config as any) || {}
    const apiToken = provider.apiToken ? decryptToken(provider.apiToken) : cfg.apiToken || null
    if (!apiToken) return null
    const baseUrl = (cfg.baseUrl || provider.apiBaseUrl || '').replace(/\/+$/, '')
    if (!baseUrl) return null
    return {
      baseUrl,
      apiToken,
      requestTimeoutMs: Number(cfg.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS,
      environment: cfg.environment || provider.environment || 'staging',
      defaultCurrency: cfg.defaultCurrency || 'USD',
      inventoryPath: cfg.inventoryPath || DEFAULT_INVENTORY_PATH,
      inventoryPageSize: Number(cfg.inventoryPageSize) || DEFAULT_PAGE_SIZE,
    }
  }

  private async request(
    path: string,
    options: { queryParams?: Record<string, string | number> } = {},
  ): Promise<IbasisRequestResult> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'NOT_CONFIGURED', message: 'iBASIS not configured (baseUrl and apiToken required)' } }
    }

    const urlObj = new URL(config.baseUrl + path)
    if (options.queryParams) {
      for (const [k, v] of Object.entries(options.queryParams)) {
        if (v !== undefined && v !== null && v !== '') urlObj.searchParams.set(k, String(v))
      }
    }
    const finalUrl = urlObj.toString()
    const correlationId = generateCorrelationId()
    const startMs = Date.now()

    const headers: Record<string, string> = {
      Authorization: `${TOKEN_HEADER_PREFIX}${config.apiToken}`,
      Accept: 'application/json',
    }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs)
      const response = await fetch(finalUrl, { method: 'GET', headers, signal: controller.signal })
      clearTimeout(timeout)
      const latencyMs = Date.now() - startMs
      const rawText = await response.text()

      let data: any = null
      let parseFailed = false
      if (rawText.trim().length > 0) {
        try { data = JSON.parse(rawText) } catch { parseFailed = true }
      }

      console.log(`[IBASIS_REQUEST] correlationId=${correlationId} path=${path} status=${response.status} latencyMs=${latencyMs} parseFailed=${parseFailed} tokenMasked=${maskToken(config.apiToken)}`)

      if (parseFailed) {
        const html = looksLikeHtml(rawText)
        return {
          success: false, status: response.status, latencyMs,
          error: {
            code: 'NON_JSON_RESPONSE',
            message: html
              ? `iBASIS returned HTML instead of JSON (status ${response.status})`
              : `iBASIS returned malformed JSON (status ${response.status})`,
          },
        }
      }

      // A valid JSON body OR an authenticated empty result means connected.
      if (response.ok) return { success: true, status: response.status, data, latencyMs }

      if (response.status === 401 || response.status === 403) {
        return {
          success: false, status: response.status, latencyMs,
          error: { code: 'AUTH_ERROR', message: `iBASIS authentication failed (HTTP ${response.status})` },
        }
      }

      return {
        success: false, status: response.status, latencyMs,
        error: { code: `HTTP_${response.status}`, message: `iBASIS returned HTTP ${response.status}` },
      }
    } catch (e: any) {
      const latencyMs = Date.now() - startMs
      const causeCode = e?.cause?.code || ''
      let code = 'NETWORK_ERROR'
      let msg: string
      if (e?.name === 'AbortError') {
        code = 'TIMEOUT'
        msg = `iBASIS request timed out after ${config.requestTimeoutMs}ms`
      } else if (causeCode === 'ENOTFOUND') {
        msg = 'iBASIS host not found (DNS failure)'
      } else if (causeCode === 'ECONNREFUSED') {
        msg = 'iBASIS refused the connection'
      } else {
        msg = `iBASIS request failed: ${e?.message?.substring(0, 200)}`
      }
      console.log(`[IBASIS_ERROR] correlationId=${correlationId} path=${path} code=${code} latencyMs=${latencyMs} error=${msg}`)
      return { success: false, error: { code, message: msg }, latencyMs }
    }
  }

  async authenticate(): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
    return { success: false, error: { code: 'UNSUPPORTED', message: 'iBASIS uses a static API token — configure apiToken directly' } }
  }

  async getTokenState(): Promise<TokenState> {
    const config = await this.loadConfig()
    return { tokenPresent: !!config?.apiToken, expiryPresent: false, expired: false, expiresSoon: false, tokenExpiry: null }
  }

  async ensureAuthenticated(): Promise<ConnectorResult<void>> {
    const config = await this.loadConfig()
    if (!config) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'iBASIS provider not configured (baseUrl and apiToken required)' } }
    return { success: true }
  }

  async refreshAuthentication(): Promise<boolean> {
    return false
  }

  async testConnection(): Promise<ConnectorResult<{ message: string; latencyMs?: number }>> {
    const config = await this.loadConfig()
    if (!config) {
      return { success: false, error: { code: 'NOT_CONFIGURED', message: 'Provider not configured (baseUrl and apiToken required)' } }
    }

    const result = await this.request(config.inventoryPath, { queryParams: { limit: config.inventoryPageSize } })

    await recordHealthEvent(this.providerId, { eventType: 'CONNECTION_TEST', success: result.success, message: result.error?.message || 'Connected', durationMs: result.latencyMs }).catch(() => {})

    if (result.success) {
      await prisma.provider.update({
        where: { id: this.providerId },
        data: { lastSuccessfulConnection: new Date(), lastError: null, errorCount: 0 },
      }).catch(() => {})
      return { success: true, data: { message: `Connected (${result.latencyMs}ms)`, latencyMs: result.latencyMs } }
    }

    await prisma.provider.update({
      where: { id: this.providerId },
      data: { lastFailedConnection: new Date(), lastError: (result.error?.message || 'Connection failed').substring(0, 500), errorCount: { increment: 1 } },
    }).catch(() => {})
    return { success: false, error: result.error }
  }

  async diagnoseConnection(): Promise<ConnectorResult<DiagnosticInfo>> {
    const config = await this.loadConfig()
    if (!config) {
      return {
        success: false,
        data: {
          connectorClass: 'IbasisConnector', method: 'GET', baseUrl: '', authUrl: '', path: DEFAULT_INVENTORY_PATH, finalUrl: '',
          tokenPlacement: 'HEADER', authType: 'API_TOKEN', authHeaderPresent: false, tokenReplaced: false,
          responseStatus: null, responseContentType: null, responseBody: null, latencyMs: null,
          warnings: ['Provider not configured (baseUrl and apiToken required)'],
        },
        error: { code: 'NOT_CONFIGURED', message: 'Provider not configured' },
      }
    }

    const path = config.inventoryPath
    const finalUrl = `${config.baseUrl}${path}`
    const result = await this.request(path, { queryParams: { limit: config.inventoryPageSize } })

    return {
      success: result.success,
      data: {
        connectorClass: 'IbasisConnector', method: 'GET', baseUrl: config.baseUrl, authUrl: '', path, finalUrl,
        tokenPlacement: 'HEADER', authType: 'API_TOKEN', authHeaderPresent: true, tokenReplaced: false,
        responseStatus: result.status ?? null,
        responseContentType: result.status ? 'application/json' : null,
        responseBody: result.data ? JSON.stringify(result.data).substring(0, 300) : null,
        latencyMs: result.latencyMs ?? null,
        warnings: [],
        requestTimeoutMs: config.requestTimeoutMs,
      },
      error: result.error,
    }
  }

  async syncPlans(): Promise<ConnectorResult<ConnectorPlan[]>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Plan sync implementation pending (Phase 2)' } }
  }

  async validatePurchase(): Promise<{ valid: boolean; reason?: string }> {
    const config = await this.loadConfig()
    if (!config) return { valid: false, reason: 'Provider not configured (baseUrl and apiToken required)' }
    return { valid: true }
  }

  async activateESIM(_params: ActivateESIMParams): Promise<ConnectorResult<ActivateESIMResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Purchase implementation pending (Phase 2)' } }
  }

  async getStatus(_subscriptionId: string): Promise<ConnectorResult<StatusResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Status implementation pending (Phase 2)' } }
  }

  async getUsage(_iccid: string): Promise<ConnectorResult<UsageResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Usage implementation pending (Phase 2)' } }
  }

  async suspendESIM(_subscriptionId: string): Promise<ConnectorResult<void>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Suspend implementation pending (Phase 2)' } }
  }

  async resumeESIM(_subscriptionId: string): Promise<ConnectorResult<void>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Resume implementation pending (Phase 2)' } }
  }

  async getRates(): Promise<ConnectorResult<RateResult[]>> {
    return { success: false, error: { code: 'UNSUPPORTED', message: 'iBASIS does not expose a standalone rates endpoint' } }
  }

  async getQRCode(_iccid: string): Promise<ConnectorResult<{ qrCodeUrl: string }>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'QR retrieval pending (Phase 2)' } }
  }

  async topUpESIM(_params: TopUpESIMParams): Promise<ConnectorResult<TopUpESIMResult>> {
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Top-up implementation pending (Phase 2)' } }
  }
}
