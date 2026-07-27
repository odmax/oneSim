import { RestCatalogConnector } from './rest-catalog-connector'
import type { ConnectorResult, ConnectorPlan, ActivateESIMParams, ActivateESIMResult, TopUpESIMParams, TopUpESIMResult, StatusResult, DiagnosticInfo } from './connector-interface'

interface UrlTokenConfig {
  apiBaseUrl: string
  apiToken?: string
  authUrl?: string
  environment?: string
  fieldMappings?: Record<string, any>
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

  private get fieldMappings(): Record<string, any> {
    return (this.config as any).fieldMappings || {}
  }

  protected get headers(): Record<string, string> {
    return {}
  }

  async getBalance(): Promise<ConnectorResult<{ balance: number | null; currency: string | null; accountId?: string | null; accountName?: string | null }>> {
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'API base URL not configured' } }
    const token = this.config.apiToken || ''
    if (!token) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'No API token configured' } }

    const path = `/account/v03_09/prepaid_balance/${token}`
    console.log(`[PROVIDER_BALANCE_REQUEST] providerCode=CHOICE endpoint=/account/v03_09/prepaid_balance/[REDACTED]`)

    const { text, error, status } = await fetchText(this.baseUrl(path), { headers: this.headers })
    if (error) {
      console.log(`[PROVIDER_BALANCE_RESULT] providerCode=CHOICE success=false error=${error.code}`)
      return { success: false, error }
    }
    if (!text) return { success: false, error: { code: 'EMPTY', message: 'Empty balance response' } }

    try {
      const json = JSON.parse(text)
      const rawBalance = json.balance ?? json.prepaid_balance ?? json.amount ?? null
      const balance = rawBalance != null ? parseFloat(String(rawBalance)) : null
      const currency = json.currency || null

      console.log(`[PROVIDER_BALANCE_RESULT] providerCode=CHOICE success=true hasBalance=${balance != null} currency=${currency || 'null'}`)
      return {
        success: true,
        data: {
          balance: balance != null && !isNaN(balance) ? balance : null,
          currency: currency || null,
          accountId: json.account_id || json.accountId || null,
          accountName: json.account_name || json.accountName || null,
        },
      }
    } catch {
      return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse balance response' } }
    }
  }

  async getRoamingProfiles(): Promise<ConnectorResult<Array<{ id: string; code: string; name: string; description?: string; isDefault?: boolean }>>> {
    if (!this.config.apiBaseUrl) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'API base URL not configured' } }
    const token = this.config.apiToken || ''
    if (!token) return { success: false, error: { code: 'NOT_CONFIGURED', message: 'No API token configured' } }

    const path = `/account/v03_09/roaming_profiles/${token}`
    console.log(`[PROVIDER_ROAMING_REQUEST] providerCode=CHOICE endpoint=/account/v03_09/roaming_profiles/[REDACTED]`)

    const { text, error } = await fetchText(this.baseUrl(path), { headers: this.headers })
    if (error) {
      console.log(`[PROVIDER_ROAMING_RESULT] providerCode=CHOICE success=false error=${error.code}`)
      return { success: false, error }
    }
    if (!text) return { success: false, error: { code: 'EMPTY', message: 'Empty roaming profiles response' } }

    try {
      const json = JSON.parse(text)
      const list = Array.isArray(json) ? json : (json.data || json.profiles || json.roaming_profiles || [])
      if (!Array.isArray(list)) return { success: false, error: { code: 'INVALID_RESPONSE', message: 'Roaming profiles response is not an array' } }

      const profiles = list.map((p: any) => ({
        id: String(p.id || p.code || p.roaming_profile_id || p.profile_id || ''),
        code: String(p.code || p.id || p.roaming_profile_code || ''),
        name: String(p.name || p.roaming_profile_name || p.profile_name || p.code || ''),
        description: p.description || p.desc || undefined,
        isDefault: typeof p.isDefault === 'boolean' ? p.isDefault : typeof p.default === 'boolean' ? p.default : undefined,
      }))

      console.log(`[PROVIDER_ROAMING_RESULT] providerCode=CHOICE success=true profileCount=${profiles.length}`)
      return { success: true, data: profiles }
    } catch {
      return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse roaming profiles response' } }
    }
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

    console.log(`[CHOICE_AUTH_START] providerId=${this.providerId} usernamePresent=${!!username} passwordPresent=${!!password}`)

    if (!authUrl || !username || !password) {
      console.log(`[CHOICE_AUTH_START] Missing: authUrl=${!!authUrl} username=${!!username} password=${!!password} — falling back`)
      return super.authenticate(credentials)
    }

    console.log(`[CHOICE_AUTH_URL] resolvedUrl=${authUrl}`)
    console.log(`[CHOICE_AUTH_REQUEST] method=POST bodyFields=request.un,request.pw,request.command`)
    console.log(`[CHOICE_AUTH_REQUEST] target=${authUrl}`)

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

      console.log(`[CHOICE_AUTH_RESPONSE] httpStatus=${status} choiceStatus=${resp.status} accountCount=${accounts.length} responseKeys=${Object.keys(json).join(',')}`)
      console.log(`[CHOICE_AUTH_RESULT] success=true selectedAccountId=${accounts[0].account} selectedAccountName=${accounts[0].accountName}`)

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

  async validatePurchase(_params: { planId: string; quantity: number; subscriber: { email: string } }): Promise<{ valid: boolean; reason?: string }> {
    if (!this.config.apiBaseUrl) {
      return { valid: false, reason: 'API base URL not configured' }
    }
    if (!this.config.apiToken) {
      return { valid: false, reason: 'API token not configured' }
    }
    const payloadType = this.fieldMappings.activationPayloadType
    if (!payloadType) {
      return { valid: false, reason: `Required field mapping "activationPayloadType" is missing. Set it to "CHOICE_ADD_BUNDLE_FROM_POOL" in the provider fieldMappings.` }
    }
    if (!this.fieldMappings.userId) {
      return { valid: false, reason: `Required field mapping "userId" is missing. Set it in the provider fieldMappings.` }
    }
    return { valid: true }
  }

  async activateESIM(params: ActivateESIMParams): Promise<ConnectorResult<ActivateESIMResult>> {
    const token = this.config.apiToken || ''
    const path = `/template/v03_09/add_bundle_using_template_from_pool/${token}`
    const maskedPath = path.replace(token, token.slice(0, 4) + '••••')
    const payloadType = this.fieldMappings.activationPayloadType

    let body: Record<string, any>
    let maskedBody: Record<string, any>

    if (payloadType === 'CHOICE_ADD_BUNDLE_FROM_POOL') {
      body = {
        sku: params.planId,
        user_id: this.fieldMappings.userId || 'onesim',
        eu_email_address: params.subscriber.email || undefined,
      }

      const roamingProfileId = this.fieldMappings.roamingProfileId
      if (roamingProfileId && typeof roamingProfileId === 'string' && roamingProfileId.trim()) {
        body.imsi1_roaming_profile = roamingProfileId.trim()
      }

      maskedBody = { ...body, sku: body.sku }
      if (body.imsi1_roaming_profile) maskedBody.imsi1_roaming_profile = body.imsi1_roaming_profile
      console.log(`[UrlTokenConnector] Choice activation:\n  URL: ${this.baseUrl(maskedPath)}\n  Body: ${JSON.stringify(maskedBody)}`)
    } else {
      body = { template_id: params.planId, quantity: params.quantity, email: params.subscriber.email }
      maskedBody = { ...body, template_id: body.template_id }
      console.log(`[UrlTokenConnector] Generic activation:\n  URL: ${this.baseUrl(maskedPath)}\n  Body: ${JSON.stringify(maskedBody)}`)
    }

    // Remove undefined values
    Object.keys(body).forEach(k => { if (body[k] === undefined) delete body[k] })

    const { text, error, status } = await fetchText(this.baseUrl(path), {
      method: 'POST', headers: this.headers, body: JSON.stringify(body),
    })

    if (error) {
      console.log(`[UrlTokenConnector] activateESIM FAILED: status=${status} error=${error.code} msg=${error.message}`)
      return { success: false, error }
    }
    if (!text) {
      console.log(`[UrlTokenConnector] activateESIM FAILED: empty response`)
      return { success: false, error: { code: 'EMPTY', message: 'Empty activation response' } }
    }

    console.log(`[UrlTokenConnector] activateESIM response (${text.length} chars): ${text.substring(0, 500)}`)

    try {
      const json = JSON.parse(text)

      // Check for explicit provider failure
      if (json.success === false || json.status === 'failed' || json.status === 'error') {
        const errMsg = json.message || json.error || json.error_message || 'Provider rejected activation'
        console.log(`[UrlTokenConnector] Provider returned failure: ${errMsg}`)
        return { success: false, error: { code: 'PROVIDER_FAILED', message: errMsg } }
      }

      const topKeys = Object.keys(json)

      if (payloadType === 'CHOICE_ADD_BUNDLE_FROM_POOL' && Array.isArray(json.data?.imsis)) {
        // Choice-specific response: data.imsis[].iccid, .imsi, .activation_code, .qr_code_link
        const imsis = json.data.imsis as Array<any>
        const iccids = imsis.map((s: any) => s.iccid).filter(Boolean)
        const imsis_arr: string[] = imsis.map((s: any) => s.imsi != null ? String(s.imsi) : null).filter((v): v is string => v !== null)
        const activationCodes = imsis.map((s: any) => s.activation_code).filter(Boolean)
        const qrCodeUrl = imsis[0]?.qr_code_link || ''

        if (iccids.length === 0) {
          console.log(`[UrlTokenConnector] WARNING: Choice response has no ICCIDs in data.imsis. Top keys: ${topKeys.join(', ')}`)
          return { success: false, error: { code: 'NO_ICCIDS', message: 'Provider returned 0 ICCIDs' } }
        }

        return {
          success: true,
          data: {
            activationId: json.transaction_id || json.order_id || json.id || '',
            iccids,
            imsis: imsis_arr,
            activationCodes,
            qrCodeUrl: qrCodeUrl || undefined,
            status: json.status || 'ACTIVATED',
          },
        }
      }

      // Generic response extraction
      const iccids: string[] = (() => {
        if (Array.isArray(json.iccids) && json.iccids.length > 0) return json.iccids
        if (json.iccid) return [json.iccid]
        if (Array.isArray(json.iccid_list) && json.iccid_list.length > 0) return json.iccid_list
        if (json.data?.iccids) return json.data.iccids
        if (json.data?.iccid) return [json.data.iccid]
        if (json.response?.iccids) return json.response.iccids
        if (json.response?.iccid) return [json.response.iccid]
        if (json.sim?.iccid) return [json.sim.iccid]
        if (Array.isArray(json.sims)) return json.sims.map((s: any) => s.iccid).filter(Boolean)
        if (json.esim?.iccid) return [json.esim.iccid]
        if (json.order?.iccids) return json.order.iccids
        if (json.bundle?.iccid) return [json.bundle.iccid]
        console.log(`[UrlTokenConnector] WARNING: No ICCID field found in response. Top keys: ${topKeys.join(', ')}`)
        return []
      })()

      return {
        success: true,
        data: {
          activationId: json.transaction_id || json.order_id || json.id || json.response?.transaction_id || '',
          iccids,
          qrCodeUrl: json.qr_code_url || json.qrCodeUrl || json.data?.qr_code_url || '',
          status: json.status || 'ACTIVATED',
        },
      }
    } catch (e: any) {
      console.log(`[UrlTokenConnector] activateESIM PARSE FAILED: ${e.message}`)
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

  async topUpESIM(params: TopUpESIMParams): Promise<ConnectorResult<TopUpESIMResult>> {
    const token = this.config.apiToken || ''
    const topUpPath = this.fieldMappings.topUpPath || `/account/v03_09/update_imsi/${token}`
    const maskedPath = topUpPath.replace(token, token.slice(0, 4) + '••••')

    const payloadType = this.fieldMappings.topUpPayloadType

    let body: Record<string, any>

    if (payloadType === 'CHOICE_UPDATE_IMSI') {
      body = {
        user_id: this.fieldMappings.userId || 'onesim',
        iccid: params.iccid,
        package_name: params.sku || params.packageName || params.planId,
        top_up_occurrences: this.fieldMappings.topUpOccurrences || 1,
        top_up_allow_days: this.fieldMappings.topUpAllowDays || 30,
        top_up_quantity: params.quantity || 1,
      }
    } else {
      body = {
        iccid: params.iccid,
        plan_id: params.planId,
        quantity: params.quantity,
        email: params.subscriber?.email,
      }
    }

    // Remove undefined values
    Object.keys(body).forEach(k => { if (body[k] === undefined) delete body[k] })

    console.log(`[UrlTokenConnector] topUpESIM:\n  URL: ${this.baseUrl(maskedPath)}\n  Body: ${JSON.stringify(body)}`)

    const url = topUpPath.startsWith('http') ? topUpPath : this.baseUrl(topUpPath)
    const { text, error, status } = await fetchText(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    })

    if (error) {
      console.log(`[UrlTokenConnector] topUpESIM FAILED: status=${status} error=${error.code} msg=${error.message}`)
      return { success: false, error }
    }
    if (!text) {
      return { success: false, error: { code: 'EMPTY', message: 'Empty top-up response' } }
    }

    console.log(`[UrlTokenConnector] topUpESIM response (${text.length} chars): ${text.substring(0, 500)}`)

    try {
      const json = JSON.parse(text)

      if (json.success === false || json.status === 'failed' || json.status === 'error') {
        const errMsg = json.message || json.error || json.error_message || 'Provider rejected top-up'
        return { success: false, error: { code: 'PROVIDER_FAILED', message: errMsg } }
      }

      // Extract data added from package info or response
      let dataAddedMB: number | undefined
      let validityDaysAdded: number | undefined

      if (params.sku) {
        // If we have a top-up package, use its data from field mappings
        dataAddedMB = this.fieldMappings.topUpDataMB || undefined
        validityDaysAdded = this.fieldMappings.topUpValidityDays || undefined
      }

      return {
        success: true,
        data: {
          providerReference: json.transaction_id || json.order_id || json.id || json.reference || '',
          dataAddedMB,
          validityDaysAdded,
          status: json.status || 'COMPLETED',
          newExpiry: json.expiry_date || json.expires_at || undefined,
          newDataTotalMB: json.data_total_mb || json.dataTotalMB || undefined,
          newDataRemainingMB: json.data_remaining_mb || json.dataRemainingMB || undefined,
        },
      }
    } catch (e: any) {
      return { success: false, error: { code: 'INVALID_JSON', message: 'Failed to parse top-up response' } }
    }
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
