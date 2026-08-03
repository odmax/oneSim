import { RestCatalogConnector } from './rest-catalog-connector'
import type { ConnectorResult, ConnectorPlan, ActivateESIMParams, ActivateESIMResult, StatusResult, UsageResult, DiagnosticInfo, EsimLifecycleResult } from './connector-interface'

interface HeaderTokenConfig {
  apiBaseUrl: string
  apiToken?: string
  authUrl?: string
  environment?: string
}

async function fetchJson(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{ data?: any; error?: { code: string; message: string }; status?: number }> {
  const timeout = opts?.timeoutMs || 15000
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)
    const response = await fetch(url, {
      method: opts?.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...opts?.headers },
      body: opts?.body,
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    const status = response.status
    const text = await response.text()
    if (!response.ok) return { error: { code: `HTTP_${status}`, message: text.substring(0, 300) }, status }
    let data: any
    try { data = JSON.parse(text) } catch { return { error: { code: 'INVALID_JSON', message: 'Non-JSON response' }, status } }
    return { data, status }
  } catch (e: any) {
    if (e.name === 'AbortError') return { error: { code: 'TIMEOUT', message: 'Request timed out' } }
    return { error: { code: 'NETWORK_ERROR', message: e.message } }
  }
}

export class HeaderTokenRestConnector extends RestCatalogConnector {
  constructor(providerId: string, name: string | undefined, config: HeaderTokenConfig) {
    super(providerId, name, config)
  }

  protected get headers(): Record<string, string> {
    const h: Record<string, string> = {}
    if (this.config.apiToken) h['Authorization'] = `Token ${this.config.apiToken}`
    return h
  }

  async diagnoseConnection(): Promise<ConnectorResult<DiagnosticInfo>> {
    return this.runDiagnostics('GET', '/api/v1/plans', { headers: this.headers, tokenPlacement: 'HEADER', authType: 'bearer_token' })
  }

  async syncPlans(): Promise<ConnectorResult<ConnectorPlan[]>> {
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NO_BASE_URL', message: 'API Base URL not configured' } }
    const { data, error } = await fetchJson(this.baseUrl('/api/v1/plans'), { headers: this.headers })
    if (error) return { success: false, error }
    const items = this.extractList(data, 'results')
    if (!Array.isArray(items)) return { success: false, error: { code: 'INVALID_RESPONSE', message: 'Plans response did not contain an array' } }
    const plans: ConnectorPlan[] = items.map((item: any) => this.mapPlan(item))
    return { success: true, data: plans }
  }

  async activateESIM(params: ActivateESIMParams): Promise<ConnectorResult<ActivateESIMResult>> {
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NO_BASE_URL', message: 'API Base URL not configured' } }
    const apiToken = this.config.apiToken || ''

    try {
      // Step 1: Create subscriber
      const subscriberRes = await fetchJson(this.baseUrl('/api/v1/subscribers'), {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          first_name: params.subscriber.first_name || params.subscriber.email,
          last_name: params.subscriber.last_name || '',
          email: params.subscriber.email,
        }),
      })
      if (!subscriberRes.data) return { success: false, error: subscriberRes.error || { code: 'SUBSCRIBER_FAILED', message: 'Failed to create subscriber' } }
      const subscriberId = subscriberRes.data.id || subscriberRes.data.subscriber_id || ''

      // Step 2: Create address
      const addressRes = await fetchJson(this.baseUrl('/api/v1/addresses'), {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          subscriber: subscriberId,
          country: 'ZA',
        }),
      })
      if (!addressRes.data) return { success: false, error: addressRes.error || { code: 'ADDRESS_FAILED', message: 'Failed to create address' } }
      const addressId = addressRes.data.id || addressRes.data.address_id || ''

      // Step 3: Validate activation
      const validateRes = await fetchJson(this.baseUrl('/api/v1/activations/validate'), {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          plan_id: params.planId,
          subscriber: subscriberId,
          address: addressId,
          quantity: params.quantity,
        }),
      })
      if (!validateRes.data) return { success: false, error: validateRes.error || { code: 'VALIDATE_FAILED', message: 'Activation validation failed' } }

      // Step 4: Activate subscription
      const activateRes = await fetchJson(this.baseUrl('/api/v1/activations'), {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          plan_id: params.planId,
          subscriber: subscriberId,
          address: addressId,
          quantity: params.quantity,
          activation_type: 'API',
        }),
      })
      if (!activateRes.data) return { success: false, error: activateRes.error || { code: 'ACTIVATE_FAILED', message: 'Activation request failed' } }

      const iccids: string[] = activateRes.data.iccid ? [activateRes.data.iccid] : activateRes.data.iccids || activateRes.data.subscriptions?.map((s: any) => s.iccid).filter(Boolean) || []
      return {
        success: true,
        data: {
          activationId: activateRes.data.id || activateRes.data.activation_id || '',
          iccids,
          qrCodeUrl: activateRes.data.qr_code_url || activateRes.data.qrCodeUrl || '',
          status: activateRes.data.status || 'PENDING',
        },
      }
    } catch (e: any) {
      return { success: false, error: { code: 'ACTIVATION_ERROR', message: `Activation failed: ${e.message}` } }
    }
  }

  async getStatus(subscriptionId: string): Promise<ConnectorResult<StatusResult>> {
    const { data, error } = await fetchJson(this.baseUrl(`/api/v1/subscriptions/${subscriptionId}`), { headers: this.headers })
    if (error) return { success: false, error }
    return {
      success: true,
      data: {
        status: data.status || data.subscription_status || 'UNKNOWN',
        iccid: data.iccid || '',
        iccids: data.iccid ? [data.iccid] : (data.iccids || []),
      },
    }
  }

  async getUsage(iccid: string): Promise<ConnectorResult<UsageResult>> {
    const { data, error } = await fetchJson(this.baseUrl(`/api/v1/subscriptions/${iccid}/usage`), { headers: this.headers })
    if (error) return { success: false, error }
    return {
      success: true,
      data: {
        iccid,
        dataUsedMB: data.data_used_mb || data.dataUsedMB || 0,
        timestamp: data.timestamp || new Date().toISOString(),
      },
    }
  }

  async suspendESIM(subscriptionId: string): Promise<ConnectorResult<EsimLifecycleResult>> {
    const { error } = await fetchJson(this.baseUrl(`/api/v1/subscriptions/${subscriptionId}/suspend`), {
      method: 'POST', headers: this.headers,
    })
    if (error) return { success: false, error }
    return { success: true, data: { status: 'SUSPENDED', providerStatus: 'suspended' } }
  }

  async resumeESIM(subscriptionId: string): Promise<ConnectorResult<EsimLifecycleResult>> {
    const { error } = await fetchJson(this.baseUrl(`/api/v1/subscriptions/${subscriptionId}/resume`), {
      method: 'POST', headers: this.headers,
    })
    if (error) return { success: false, error }
    return { success: true, data: { status: 'ACTIVE', providerStatus: 'active' } }
  }

  async getQRCode(iccid: string): Promise<ConnectorResult<{ qrCodeUrl: string }>> {
    const { data, error } = await fetchJson(this.baseUrl(`/api/v1/subscriptions/${iccid}/qrcode`), { headers: this.headers })
    if (error) return { success: false, error }
    return {
      success: true,
      data: { qrCodeUrl: data.qr_code_url || data.qrCodeUrl || data.url || '' },
    }
  }

  protected mapPlan(item: any): ConnectorPlan {
    const id = item.id || item.plan_id || item.sku || ''
    const name = item.name || item.plan_name || item.description || ''
    const dataGB = parseFloat(item.data_gb ?? item.dataGB ?? item.data_amount ?? 0)
    const unit = (item.data_unit || 'GB').toUpperCase()
    const finalData = unit === 'GB' ? dataGB : unit === 'MB' ? Math.round(dataGB / 1024) : dataGB
    const days = parseInt(item.validity_days ?? item.validityDays ?? item.duration_days ?? 30)
    const price = parseFloat(item.price_usd ?? item.priceUSD ?? item.price ?? 0)
    return {
      id: String(id), name: String(name),
      data_gb: Math.max(1, finalData || 1), validity_days: Math.max(1, days || 30),
      price_usd: price, currency: 'USD', sku: String(id), raw_data: item,
    }
  }
}
