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
  /** Whether the plan requires a travel date in the purchase payload. */
  requiresTravelDate?: boolean
}

export interface ActivateESIMParams {
  planId: string
  quantity: number
  subscriber: { email: string; first_name?: string; last_name?: string }
  externalId?: string
  /** OneSim purchase/order id — used to bind a reserved SIM at purchase time. */
  orderId?: string
  packageId?: string
}

export interface ActivateESIMResult {
  activationId: string
  iccids: string[]
  imsis?: string[]
  activationCodes?: string[]
  qrCodeUrl?: string
  matchingId?: string
  smdpAddress?: string
  status?: string
  /** Upstream SIM/ICCID identifier when the provider returns simID instead of iccids. */
  iccidOrSimId?: string
  /** Sanitized upstream purchase metadata (no secrets). */
  rawMetadata?: Record<string, any>
}

export interface UsageResult {
  iccid: string
  dataUsedMB: number
  timestamp?: string
  /** Total allowance in MB (normalized). Additive — non-Choice providers may omit it. */
  dataTotalMB?: number
  /** Remaining allowance in MB (normalized). */
  dataRemainingMB?: number
  /** Percentage of the allowance used, clamped 0–100. */
  percentageUsed?: number
  /** Provider-reported expiry as an ISO 8601 UTC string. */
  expiresAt?: string
  /** Supplemental normalized status. Never used to downgrade a meaningful stored status. */
  status?: string
  /** Sanitized provider metadata safe to persist. */
  rawMetadata?: Record<string, any>
}

export interface StatusResult {
  status: string
  iccids?: string[]
  iccid?: string
  /** Raw provider lifecycle value that produced `status`. */
  rawStatus?: string
  /** Choice `imsi_version` returned by package_detail. */
  imsiVersion?: string | number
  packageName?: string
  rateGroupStarttime?: string
  rateGroupExpire?: string
  expiresAt?: string
  /** Sanitized provider metadata safe to persist. */
  rawMetadata?: Record<string, any>
}

/**
 * Provider identifier used for status lookups that accept structured identifiers.
 * Choice package_detail supports lookup by ICCID, IMSI, or imsi_version.
 * `currentStatus` is only used as a safe fallback when the provider returns an
 * unrecognized lifecycle value.
 */
export interface StatusLookupIdentifier {
  iccid?: string
  imsi?: string
  imsiVersion?: string | number
  currentStatus?: string
}

/**
 * The minimal eSIM shape a connector needs to resolve the correct upstream
 * status-lookup identifier. Provider-owned references (subscription/activation
 * id) are included so string-based connectors never fall back to a local
 * OneSIM id.
 */
export interface StatusLookupEsim {
  iccid?: string | null
  imsi?: string | null
  imsiVersion?: string | number | null
  status?: string | null
  providerSubscriptionId?: string | null
  providerActivationId?: string | null
}

export interface TopUpESIMParams {
  iccid: string
  imsi?: string | null
  planId: string
  sku?: string
  packageName?: string
  quantity: number
  subscriber?: { email: string; first_name?: string; last_name?: string }
}

export interface TopUpESIMResult {
  providerReference: string
  dataAddedMB?: number
  validityDaysAdded?: number
  status: string
  newExpiry?: string
  newDataTotalMB?: number
  newDataRemainingMB?: number
}

/**
 * Result of a successful provider suspend/resume call.
 * `status` is the internal lifecycle value to persist (SUSPENDED / ACTIVE);
 * `providerStatus` is the provider-facing value (e.g. Choice 'suspended'/'active');
 * `message` carries the provider confirmation text (e.g. the Choice errmsg);
 * `rawMetadata` is the sanitized response safe to persist.
 */
export interface EsimLifecycleResult {
  status: 'SUSPENDED' | 'ACTIVE'
  providerStatus: string
  message?: string
  rawMetadata?: Record<string, any>
}

export interface RateResult {
  country?: string
  operator?: string
  dataPerGB?: number
  priceUSD?: number
  validityDays?: number
}

/**
 * Canonical result of a delayed QR/install-data lookup. Mirrors the normalized
 * ESIM installation columns; only these fields may be persisted.
 */
export interface QRCodeResult {
  qrCodeUrl?: string
  qrCode?: string
  activationCode?: string
  smdpAddress?: string
  matchingId?: string
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

export interface TokenState {
  tokenPresent: boolean
  expiryPresent: boolean
  expired: boolean
  expiresSoon: boolean
  tokenExpiry: unknown
}

export interface IProviderConnector {
  readonly providerId: string
  readonly name: string

  authenticate(credentials: Record<string, string>): Promise<ConnectorResult<{ token: string; accountInfo?: any }>>
  getTokenState(): Promise<TokenState>
  ensureAuthenticated(): Promise<ConnectorResult<void>>
  refreshAuthentication(): Promise<boolean>
  testConnection(): Promise<ConnectorResult<{ message: string; latencyMs?: number }>>
  diagnoseConnection(): Promise<ConnectorResult<DiagnosticInfo>>
  syncPlans(): Promise<ConnectorResult<ConnectorPlan[]>>
  activateESIM(params: ActivateESIMParams): Promise<ConnectorResult<ActivateESIMResult>>
  getStatus(identifier: string | StatusLookupIdentifier): Promise<ConnectorResult<StatusResult>>
  /**
   * Resolve the provider-appropriate status-lookup identifier for an eSIM.
   * Connectors that support structured lookups (e.g. Choice package_detail by
   * ICCID/IMSI/imsi_version) return a `StatusLookupIdentifier` object; string-
   * based connectors return their provider-owned reference (subscription /
   * activation id), never a local OneSIM id. Returns null when no safe upstream
   * identifier exists — the caller MUST skip the provider call in that case.
   * Optional: callers fall back to a safe provider-reference default when a
   * connector does not implement it.
   */
  resolveStatusLookup?(esim: StatusLookupEsim): string | StatusLookupIdentifier | null
  getUsage(identifier: string | StatusLookupIdentifier): Promise<ConnectorResult<UsageResult>>
  suspendESIM(subscriptionId: string | StatusLookupIdentifier): Promise<ConnectorResult<EsimLifecycleResult>>
  resumeESIM(subscriptionId: string | StatusLookupIdentifier): Promise<ConnectorResult<EsimLifecycleResult>>
  getRates(): Promise<ConnectorResult<RateResult[]>>
  getQRCode(iccid: string): Promise<ConnectorResult<QRCodeResult>>
  topUpESIM(params: TopUpESIMParams): Promise<ConnectorResult<TopUpESIMResult>>
  /**
   * Validate that the connector is configured for purchase.
   * Called before any wallet hold. Returns the reason if invalid.
   * Optional — connectors without this method are treated as valid.
   */
  validatePurchase?(params: { planId: string; quantity: number; subscriber: { email: string } }): Promise<{ valid: boolean; reason?: string }>
  getBalance?(): Promise<ConnectorResult<{ balance: number | null; currency: string | null; accountId?: string | null; accountName?: string | null }>>
  getRoamingProfiles?(): Promise<ConnectorResult<Array<{ id: string; code: string; name: string; description?: string; isDefault?: boolean }>>>
}
