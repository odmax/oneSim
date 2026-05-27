import type {
  IProviderAdapter, ActivateRequest, ActivateResponse,
  StatusResponse, TopUpResponse, WebhookEvent,
} from './IProviderAdapter'
import type { ProviderRecord } from '@/repositories/providerRepository'
import { ProviderAPIError, ProviderAuthError, FieldMappingError, WebhookVerificationError } from '@/errors/providerErrors'
import crypto from 'crypto'

interface OAuth2TokenCache {
  token: string
  expiresAt: number
}

export class BaseRestAdapter implements IProviderAdapter {
  readonly providerSlug: string
  protected config: ProviderRecord
  private oauth2Cache: OAuth2TokenCache | null = null

  constructor(config: ProviderRecord) {
    this.config = config
    this.providerSlug = config.slug
  }

  buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    const creds = this.config.credentials
    switch (this.config.authType) {
      case 'api_key': {
        const headerName = creds.headerName || 'X-API-Key'
        headers[headerName] = creds.apiKey || creds.api_key || ''
        break
      }
      case 'bearer_token':
        headers['Authorization'] = `Bearer ${creds.token || creds.apiToken || ''}`
        break
      case 'basic_auth':
        headers['Authorization'] = 'Basic ' + Buffer.from(`${creds.username || ''}:${creds.password || ''}`).toString('base64')
        break
      case 'custom_header': {
        const hdrName = creds.headerName || 'X-Custom-Auth'
        headers[hdrName] = creds.headerValue || creds.apiKey || ''
        break
      }
      case 'oauth2_client_credentials': {
        const cached = this.oauth2Cache
        if (cached && Date.now() < cached.expiresAt) {
          headers['Authorization'] = `Bearer ${cached.token}`
        } else {
          headers['Authorization'] = `Bearer ${this.fetchOAuth2Token()}`
        }
        break
      }
    }
    return headers
  }

  private async fetchOAuth2Token(): Promise<string> {
    const creds = this.config.credentials
    const tokenUrl = creds.tokenUrl || `${this.config.baseUrl}/oauth/token`
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: creds.clientId || creds.client_id || '',
      client_secret: creds.clientSecret || creds.client_secret || '',
    })

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })

    if (!res.ok) {
      throw new ProviderAuthError(this.providerSlug, `OAuth2 token request failed: HTTP ${res.status}`)
    }

    const json: any = await res.json()
    const token = json.access_token
    const expiresIn = json.expires_in || 3600
    this.oauth2Cache = { token, expiresAt: Date.now() + (expiresIn - 60) * 1000 }
    return token
  }

  resolvePath(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || `{${key}}`)
  }

  mapToProvider(obj: Record<string, unknown>): Record<string, unknown> {
    const fwd: Record<string, string> = {}
    for (const [providerField, oneSimField] of Object.entries(this.config.fieldMappings)) {
      fwd[oneSimField] = providerField
    }
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(obj)) {
      const providerKey = fwd[key] || key
      result[providerKey] = val
    }
    return result
  }

  mapFromProvider(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(obj)) {
      const oneSimKey = (this.config.fieldMappings as Record<string, string>)[key] || key
      result[oneSimKey] = val
    }
    return result
  }

  protected async request<T>(
    method: string,
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<T> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.buildAuthHeaders(),
    }

    const logCtx = { providerSlug: this.providerSlug, method, path: url }
    console.log(JSON.stringify({ level: 'INFO', ...logCtx, message: 'Outbound request' }))

    const start = Date.now()
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
    const latency = Date.now() - start

    if (res.status === 401 && this.config.authType === 'oauth2_client_credentials' && !retried) {
      this.oauth2Cache = null
      return this.request(method, path, body, true)
    }

    if (!res.ok) {
      const text = await res.text()
      console.log(JSON.stringify({ level: 'WARN', ...logCtx, status: res.status, latency, message: 'Provider API error' }))
      throw new ProviderAPIError(this.providerSlug, res.status, text)
    }

    const json = await res.json()
    console.log(JSON.stringify({ level: 'INFO', ...logCtx, status: res.status, latency, message: 'Response OK' }))
    return json as T
  }

  async activateESim(req: ActivateRequest): Promise<ActivateResponse> {
    const ep = this.config.endpoints.activate
    if (!ep) throw new Error(`No activate endpoint configured for provider ${this.providerSlug}`)

    const body = this.mapToProvider({
      bundleId: req.bundleId,
      orderId: req.orderId,
      ...(req.iccid ? { iccid: req.iccid } : {}),
      ...(req.msisdn ? { msisdn: req.msisdn } : {}),
      ...(req.metadata || {}),
    })

    const raw: any = await this.request(ep.method, ep.path, body)

    const mapped = this.mapFromProvider(raw)
    const iccid = String(mapped.iccid || req.iccid || '')
    const activationCode = String(mapped.activationCode || mapped.activation_code || '')
    const status = String(mapped.status || 'PENDING')
    const orderId = String(mapped.orderId || mapped.order_id || req.orderId)

    if (!iccid) throw new FieldMappingError(this.providerSlug, 'iccid')

    return { iccid, activationCode, orderId, status, rawResponse: raw }
  }

  async getStatus(iccid: string): Promise<StatusResponse> {
    const ep = this.config.endpoints.status
    if (!ep) throw new Error(`No status endpoint configured for provider ${this.providerSlug}`)

    const path = this.resolvePath(ep.path, { iccid })
    const raw: any = await this.request(ep.method, path)

    const mapped = this.mapFromProvider(raw)
    return {
      iccid: String(mapped.iccid || iccid),
      status: String(mapped.status || 'UNKNOWN'),
      dataUsedMb: mapped.dataUsedMb ? Number(mapped.dataUsedMb) : undefined,
      dataTotalMb: mapped.dataTotalMb ? Number(mapped.dataTotalMb) : undefined,
      expiryDate: mapped.expiryDate ? String(mapped.expiryDate) : undefined,
      rawResponse: raw,
    }
  }

  async topUp(iccid: string, bundleId: string): Promise<TopUpResponse> {
    const ep = this.config.endpoints.topup
    if (!ep) throw new Error(`No topup endpoint configured for provider ${this.providerSlug}`)

    const path = this.resolvePath(ep.path, { iccid })
    const body = this.mapToProvider({ bundleId, iccid })
    const raw: any = await this.request(ep.method, path, body)

    const mapped = this.mapFromProvider(raw)
    return {
      iccid: String(mapped.iccid || iccid),
      bundleId: String(mapped.bundleId || mapped.bundle_id || bundleId),
      status: String(mapped.status || 'PENDING'),
      rawResponse: raw,
    }
  }

  async deactivate(iccid: string): Promise<void> {
    const ep = this.config.endpoints.deactivate
    if (!ep) throw new Error(`No deactivate endpoint configured for provider ${this.providerSlug}`)

    const path = this.resolvePath(ep.path, { iccid })
    await this.request(ep.method, path)
  }

  parseWebhook(payload: unknown, headers: Record<string, string>): WebhookEvent {
    const wc = this.config.webhookConfig
    if (wc.enabled && wc.authType === 'hmac_sha256' && wc.secretEncrypted) {
      const signature = headers['x-signature'] || headers['X-Signature'] || ''
      const computed = crypto
        .createHmac('sha256', wc.secretEncrypted)
        .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
        .digest('hex')

      if (signature !== computed) {
        throw new WebhookVerificationError(this.providerSlug, headers['x-forwarded-for'] || headers['x-real-ip'] || 'unknown', 'HMAC signature mismatch')
      }
    }

    const raw = (payload as Record<string, unknown>) || {}
    const p = this.mapFromProvider(raw)
    const eventType = String(raw.event || raw.event_type || raw.type || 'esim.status_changed')

    return {
      type: eventType as WebhookEvent['type'],
      iccid: String(p.iccid || ''),
      status: p.status ? String(p.status) : undefined,
      timestamp: raw.timestamp ? new Date(String(raw.timestamp)) : new Date(),
      rawPayload: payload,
    }
  }
}
