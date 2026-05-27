import { RestCatalogConnector } from './rest-catalog-connector'
import type { ConnectorResult, ConnectorPlan, ActivateESIMParams, ActivateESIMResult, StatusResult, DiagnosticInfo } from './connector-interface'

interface UrlTokenConfig {
  apiBaseUrl: string
  apiToken?: string
  authUrl?: string
  environment?: string
}

async function fetchText(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{ text?: string; error?: { code: string; message: string }; status?: number }> {
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
    return { text, status }
  } catch (e: any) {
    if (e.name === 'AbortError') return { error: { code: 'TIMEOUT', message: 'Request timed out' } }
    return { error: { code: 'NETWORK_ERROR', message: e.message } }
  }
}

function maskToken(token: string): string {
  if (!token || token.length < 8) return token || ''
  return token.slice(0, 4) + '••••' + token.slice(-4)
}

interface AuthAccount {
  account: string
  accountName: string
  token: string
  uaid?: string
  userId?: string
}

export class UrlTokenConnector extends RestCatalogConnector {
  constructor(providerId: string, name: string | undefined, config: UrlTokenConfig) {
    super(providerId, name, config)
  }

  protected get headers(): Record<string, string> {
    return {}
  }

  async diagnoseConnection(): Promise<ConnectorResult<DiagnosticInfo>> {
    const token = this.config.apiToken || ''
    const path = `/account/v03_09/bundle_templates/${token}`
    return this.runDiagnostics('GET', path, { tokenPlacement: 'URL_PATH', authType: 'credentials' })
  }

  async authenticate(credentials: Record<string, string>): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
    const authUrl = credentials.authUrl || this.config.authUrl
    const username = credentials.username
    const password = credentials.password

    if (!authUrl || !username || !password) {
      return super.authenticate(credentials)
    }

    // Try JSON auth first (Choice/VirtuoLink style)
    const jsonResult = await this.jsonAuthenticate(authUrl, username, password, credentials.environment)
    if (jsonResult.success) return jsonResult

    // If JSON auth failed with a non-network error (bad credentials, wrong format), don't retry SOAP
    if (jsonResult.error && jsonResult.error.code !== 'AUTH_NETWORK_ERROR' && jsonResult.error.code !== 'TIMEOUT' && jsonResult.error.code !== 'NETWORK_ERROR') {
      return jsonResult
    }

    // Fall back to SOAP XML auth (iBASIS/Choice legacy style)
    return this.soapAuthenticate(authUrl, username, password, credentials.environment)
  }

  private async jsonAuthenticate(authUrl: string, username: string, password: string, _environment?: string): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
    try {
      const res = await fetch(authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request: { un: username, pw: password, command: 'accounts_getaccounts' },
        }),
      })

      const status = res.status
      const contentType = res.headers.get('content-type') || ''
      const text = await res.text()

      // If response is not JSON, can't handle with this method
      if (!contentType.includes('json') && !text.trim().startsWith('{')) {
        return { success: false, error: { code: 'NOT_JSON', message: 'Response is not JSON, falling back to SOAP' } }
      }

      let json: any
      try { json = JSON.parse(text) } catch {
        return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse auth response as JSON' } }
      }

      // Navigate response.response.data or response.data or data
      const resp = json.response || json
      if (resp.status !== undefined && resp.status !== 0) {
        const msg = resp.message || resp.error || `Auth refused (status ${resp.status})`
        return { success: false, error: { code: 'AUTH_FAILED', message: msg } }
      }

      const rawData = resp.data || json.data || json
      const accountsList = Array.isArray(rawData) ? rawData : (Array.isArray(json.data) ? json.data : null)

      if (!accountsList || accountsList.length === 0) {
        return { success: false, error: { code: 'AUTH_FAILED', message: 'No accounts returned' } }
      }

      const accounts: AuthAccount[] = accountsList.map((a: any) => ({
        account: String(a.account || a.id || ''),
        accountName: a.accountName || a.name || a.account_name || '',
        token: a.token || a.api_token || a.apiToken || '',
        uaid: a.uaid || a.UAID || '',
        userId: a.userId || a.user_id || a.UserId || '',
      })).filter((a: AuthAccount) => a.account || a.token)

      if (accounts.length === 0) {
        return { success: false, error: { code: 'AUTH_FAILED', message: 'No accounts with valid tokens found' } }
      }

      const diag = {
        authMode: 'JSON_USERNAME_PASSWORD',
        statusCode: status,
        contentType,
        topLevelKeys: Object.keys(json),
        accountCount: accounts.length,
        accountNames: accounts.map((a: AuthAccount) => a.accountName),
        maskedTokens: accounts.map((a: AuthAccount) => maskToken(a.token)),
      }

      return {
        success: true,
        data: { token: accounts[0].token, accountInfo: { accounts, account: accounts[0], authDiagnostics: diag } },
      }
    } catch (e: any) {
      return { success: false, error: { code: 'AUTH_NETWORK_ERROR', message: `JSON auth failed: ${e.message}` } }
    }
  }

  private async soapAuthenticate(authUrl: string, username: string, password: string, _environment?: string): Promise<ConnectorResult<{ token: string; accountInfo?: any }>> {
    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <getaccounts xmlns="http://tempuri.org/">
      <strUserName>${username}</strUserName>
      <strPassword>${password}</strPassword>
    </getaccounts>
  </soap:Body>
</soap:Envelope>`
    try {
      const res = await fetch(authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '"http://tempuri.org/getaccounts"' },
        body: envelope,
      })
      const status = res.status
      const contentType = res.headers.get('content-type') || ''
      const xml = await res.text()

      const accounts = this.parseSoapAccounts(xml)
      const diag = {
        authMode: 'SOAP_USERNAME_PASSWORD',
        statusCode: status,
        contentType,
        accountCount: accounts.length,
        accountNames: accounts.map((a: AuthAccount) => a.accountName),
        maskedTokens: accounts.map((a: AuthAccount) => maskToken(a.token)),
      }

      if (accounts.length === 0) {
        return { success: false, error: { code: 'AUTH_FAILED', message: 'No accounts returned', details: diag } }
      }

      return {
        success: true,
        data: { token: accounts[0].token, accountInfo: { accounts, account: accounts[0], authDiagnostics: diag } },
      }
    } catch (e: any) {
      return { success: false, error: { code: 'AUTH_NETWORK_ERROR', message: `SOAP auth failed: ${e.message}` } }
    }
  }

  private parseSoapAccounts(xml: string): AuthAccount[] {
    const accounts: AuthAccount[] = []
    const blocks = xml.split(/<Account[ >]/i).slice(1)
    for (const block of blocks) {
      const end = block.indexOf('</Account>')
      const content = end > -1 ? block.substring(0, end) : block
      const extract = (tag: string): string => {
        const m = content.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'))
        return m ? m[1].trim() : ''
      }
      const account = extract('Account')
      const accountName = extract('AccountName') || extract('Name')
      const token = extract('Token') || extract('token')
      const uaid = extract('UAID') || extract('Uaid')
      const userId = extract('UserId') || extract('UserID')
      if (account || token) accounts.push({ account, accountName, uaid, userId, token })
    }
    return accounts
  }

  async syncPlans(): Promise<ConnectorResult<ConnectorPlan[]>> {
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NO_BASE_URL', message: 'API Base URL not configured' } }
    const token = this.config.apiToken || ''
    const path = `/account/v03_09/bundle_templates/${token}`
    const { text, error } = await fetchText(this.baseUrl(path), { headers: this.headers })
    if (error) return { success: false, error }
    if (!text) return { success: false, error: { code: 'EMPTY', message: 'Empty response' } }
    try {
      const json = JSON.parse(text)
      const items = this.extractList(json, 'bundle_template_list')
      if (!Array.isArray(items)) return { success: false, error: { code: 'INVALID_RESPONSE', message: 'bundle_template_list not found in response' } }
      const plans: ConnectorPlan[] = items.map((item: any) => this.mapTemplatePlan(item))
      return { success: true, data: plans }
    } catch {
      return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse response JSON' } }
    }
  }

  async activateESIM(params: ActivateESIMParams): Promise<ConnectorResult<ActivateESIMResult>> {
    const token = this.config.apiToken || ''
    const path = `/template/v03_09/add_bundle_using_template_from_pool/${token}`
    const body = { template_id: params.planId, quantity: params.quantity, email: params.subscriber.email }
    const { text, error } = await fetchText(this.baseUrl(path), {
      method: 'POST', headers: this.headers, body: JSON.stringify(body),
    })
    if (error) return { success: false, error }
    if (!text) return { success: false, error: { code: 'EMPTY', message: 'Empty activation response' } }
    try {
      const json = JSON.parse(text)
      const iccids: string[] = json.iccid ? [json.iccid] : json.iccids || json.iccid_list || []
      return {
        success: true,
        data: {
          activationId: json.transaction_id || json.order_id || json.id || '',
          iccids,
          qrCodeUrl: json.qr_code_url || json.qrCodeUrl || '',
          status: json.status || 'ACTIVATED',
        },
      }
    } catch {
      return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse activation response' } }
    }
  }

  async getStatus(subscriptionId: string): Promise<ConnectorResult<StatusResult>> {
    const token = this.config.apiToken || ''
    const path = `/template/v03_09/package_detail/${token}/${subscriptionId}`
    const { text, error } = await fetchText(this.baseUrl(path), { headers: this.headers })
    if (error) return { success: false, error }
    if (!text) return { success: false, error: { code: 'EMPTY', message: 'Empty status response' } }
    try {
      const json = JSON.parse(text)
      return {
        success: true,
        data: {
          status: json.status || json.package_status || 'UNKNOWN',
          iccid: json.iccid || '',
          iccids: json.iccid ? [json.iccid] : [],
        },
      }
    } catch {
      return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse status response' } }
    }
  }

  async suspendESIM(subscriptionId: string): Promise<ConnectorResult<void>> {
    const token = this.config.apiToken || ''
    const path = `/template/v03_09/suspend/${token}/${subscriptionId}`
    const { error } = await fetchText(this.baseUrl(path), { method: 'POST', headers: this.headers })
    if (error) return { success: false, error }
    return { success: true }
  }

  async resumeESIM(subscriptionId: string): Promise<ConnectorResult<void>> {
    const token = this.config.apiToken || ''
    const path = `/template/v03_09/resume/${token}/${subscriptionId}`
    const { error } = await fetchText(this.baseUrl(path), { method: 'POST', headers: this.headers })
    if (error) return { success: false, error }
    return { success: true }
  }

  private mapTemplatePlan(item: any): ConnectorPlan {
    const name = item.bundle_name || item.bundleName || item.name || ''
    const allowance = parseFloat(item.rate_group_allowance ?? 0)
    const unit = (item.rate_group_allow_qtyp || 'GB').toUpperCase()
    const dataGB = unit === 'GB' ? allowance : unit === 'MB' ? Math.round(allowance / 1024) : allowance
    const days = parseInt(item.rate_group_allow_days ?? 30)
    const price = parseFloat(item.price_usd ?? item.priceUSD ?? 0)
    const id = item.bundle_template_id || item.id || ''
    const version = item.template_version || item.templateVersion || ''
    return {
      id: String(id), name: String(name),
      data_gb: Math.max(1, dataGB || 1), validity_days: Math.max(1, days || 30),
      price_usd: price, currency: 'USD',
      sku: String(id), templateVersion: String(version), raw_data: item,
    }
  }
}
