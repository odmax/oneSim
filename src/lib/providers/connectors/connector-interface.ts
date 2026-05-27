export interface ConnectorResult<T = any> {
  success: boolean
  data?: T
  error?: { code: string; message: string; details?: any }
}

export interface ConnectorPlan {
  id: string
  name: string
  data_gb: number
  validity_days: number
  price_usd: number
  currency?: string
  description?: string
  sku?: string
  templateVersion?: string
  raw_data?: any
}

export interface ActivateESIMParams {
  planId: string
  quantity: number
  subscriber: { email: string; first_name?: string; last_name?: string }
  externalId?: string
}

export interface ActivateESIMResult {
  activationId: string
  iccids: string[]
  qrCodeUrl?: string
  status?: string
}

export interface UsageResult {
  iccid: string
  dataUsedMB: number
  timestamp?: string
}

export interface StatusResult {
  status: string
  iccids?: string[]
  iccid?: string
}

export interface RateResult {
  country?: string
  operator?: string
  dataPerGB?: number
  priceUSD?: number
  validityDays?: number
}

export interface DiagnosticInfo {
  connectorClass: string
  method: string
  baseUrl: string
  authUrl: string
  path: string
  finalUrl: string
  tokenPlacement: 'URL_PATH' | 'HEADER' | 'QUERY_PARAM' | 'NONE'
  authType: string
  authHeaderPresent: boolean
  tokenReplaced: boolean
  responseStatus: number | null
  responseContentType: string | null
  responseBody: string | null
  latencyMs: number | null
  warnings: string[]
  errorClassification?: string | null
  requestTimeoutMs?: number
  retryAttempted?: boolean
  retryExplanation?: string | null
}

export type ErrorClassification = 'NETWORK_ERROR' | 'HTTP_404' | 'HTTP_400' | 'NON_JSON_RESPONSE' | 'AUTH_ERROR' | 'TOKEN_MISSING' | 'TOKEN_NOT_REPLACED' | 'UNKNOWN'

export function classifyError(error: { code?: string; message?: string } | undefined | null, warnings?: string[]): ErrorClassification {
  if (!error) return 'UNKNOWN'
  const code = (error.code || '').toUpperCase()
  const msg = (error.message || '').toLowerCase()

  if (code === 'NO_TOKEN') return 'TOKEN_MISSING'
  if (code === 'HTTP_404') return 'HTTP_404'
  if (code.startsWith('HTTP_4')) return 'HTTP_400'
  if (code === 'INVALID_JSON') return 'NON_JSON_RESPONSE'
  if (code === 'TIMEOUT' || code === 'NETWORK_ERROR') return 'NETWORK_ERROR'
  if (code.includes('AUTH') || msg.includes('401') || msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('auth failed')) return 'AUTH_ERROR'

  if (msg.includes('fetch failed') || msg.includes('dns') || msg.includes('enotfound') || msg.includes('econnrefused') || msg.includes('connection refused') || msg.includes('etimedout') || msg.includes('tls') || msg.includes('certificate') || msg.includes('name resolution') || msg.includes('network')) return 'NETWORK_ERROR'

  if (warnings?.some(w => w.toLowerCase().includes('token was not replaced'))) return 'TOKEN_NOT_REPLACED'

  return 'UNKNOWN'
}

export function errorClassificationLabel(c: ErrorClassification): string {
  switch (c) {
    case 'NETWORK_ERROR': return 'Network Error'
    case 'HTTP_404': return 'Endpoint Not Found'
    case 'HTTP_400': return 'Bad Request / Auth Error'
    case 'NON_JSON_RESPONSE': return 'Non-JSON Response'
    case 'AUTH_ERROR': return 'Authentication Error'
    case 'TOKEN_MISSING': return 'Token Missing'
    case 'TOKEN_NOT_REPLACED': return 'Token Not Replaced in URL'
    default: return 'Unknown Error'
  }
}

export function sanitizeBodyPreview(body: string | null | undefined, maxLen = 300): string | null {
  if (!body) return null
  const escaped = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
  return escaped.substring(0, maxLen)
}

export interface IProviderConnector {
  readonly providerId: string
  readonly name: string

  authenticate(credentials: Record<string, string>): Promise<ConnectorResult<{ token: string; accountInfo?: any }>>
  testConnection(): Promise<ConnectorResult<{ message: string; latencyMs?: number }>>
  diagnoseConnection(): Promise<ConnectorResult<DiagnosticInfo>>
  syncPlans(): Promise<ConnectorResult<ConnectorPlan[]>>
  activateESIM(params: ActivateESIMParams): Promise<ConnectorResult<ActivateESIMResult>>
  getStatus(subscriptionId: string): Promise<ConnectorResult<StatusResult>>
  getUsage(iccid: string): Promise<ConnectorResult<UsageResult>>
  suspendESIM(subscriptionId: string): Promise<ConnectorResult<void>>
  resumeESIM(subscriptionId: string): Promise<ConnectorResult<void>>
  getRates(): Promise<ConnectorResult<RateResult[]>>
  getQRCode(iccid: string): Promise<ConnectorResult<{ qrCodeUrl: string }>>
}
