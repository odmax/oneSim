export interface ProviderResult<T = any> {
  success: boolean
  data?: T
  error?: { code: string; message: string; details?: any }
}

export interface ProviderPlan {
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
  activationType?: string
  externalId?: string
  orderId?: string
  packageId?: string
}

export interface ActivateESIMResult {
  activationId: string
  iccids: string[]
  imsis?: string[]
  activationCodes?: string[]
  qrCodeUrl?: string
  status?: string
  /** Reservation ID for two-step purchase workflows */
  reservationId?: string
  /** Raw QR payload (data URI) as returned by the provider. */
  qrCode?: string
  /** SM-DP+ address for manual LPA-based installation. */
  smdpAddress?: string
  /** Matching ID for manual LPA-based installation. */
  matchingId?: string
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

export interface RateResult {
  country?: string
  operator?: string
  dataPerGB?: number
  priceUSD?: number
  validityDays?: number
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

export interface CredentialField {
  name: string
  label: string
  type: 'text' | 'password' | 'select'
  required: boolean
  placeholder?: string
  options?: { value: string; label: string }[]
}

export interface ProviderCapability {
  key: string
  label: string
  supported: boolean
}

export interface AuthResult {
  token: string
  accountInfo?: any
}

export interface ProviderAdapterConfig {
  baseUrl?: string
  authUrl?: string
  token?: string
  environment?: string
  providerId?: string
  config?: Record<string, any>
}

export interface WebhookPayload {
  eventType: string
  providerId: string
  body: any
  headers?: Record<string, string>
}

export interface ProviderAdapter {
  readonly providerId: string
  readonly name: string

  authenticate(credentials: Record<string, string>): Promise<ProviderResult<AuthResult>>
  getTokenState(): Promise<{ tokenPresent: boolean; expiryPresent: boolean; expired: boolean; expiresSoon: boolean }>
  ensureAuthenticated(): Promise<ProviderResult<void>>
  refreshAuthentication(): Promise<boolean>

  getCredentialFields(): CredentialField[]

  getCapabilities(): ProviderCapability[]

  testConnection(): Promise<ProviderResult<{ message: string; latencyMs?: number }>>

  syncPlans(): Promise<ProviderResult<ProviderPlan[]>>

  activateESIM(params: ActivateESIMParams): Promise<ProviderResult<ActivateESIMResult>>

  /**
   * Validate that the adapter is configured for purchase.
   * Called before any wallet hold. Optional — adapters without this are treated as valid.
   */
  validatePurchase?(params: { planId: string; quantity: number; subscriber: { email: string } }): Promise<{ valid: boolean; reason?: string }>
  getBalance?(): Promise<ProviderResult<{ balance: number | null; currency: string | null; accountId?: string | null; accountName?: string | null }>>

  getActivationStatus(activationId: string | import('./connectors/connector-interface').StatusLookupIdentifier): Promise<ProviderResult<{
    status: string
    iccids?: string[]
    rawStatus?: string
    iccid?: string
    imsiVersion?: string | number
    packageName?: string
    expiresAt?: string
    rawMetadata?: Record<string, any>
    activationCode?: string
    activationCodes?: string[]
    qrCodeUrl?: string
    qrCode?: string
    smdpAddress?: string
    matchingId?: string
  }>>

  suspendESIM(subscriptionId: string | import('./connectors/connector-interface').StatusLookupIdentifier): Promise<ProviderResult<import('./connectors/connector-interface').EsimLifecycleResult>>

  resumeESIM(subscriptionId: string | import('./connectors/connector-interface').StatusLookupIdentifier): Promise<ProviderResult<import('./connectors/connector-interface').EsimLifecycleResult>>

  getUsage(identifier: string | import('./connectors/connector-interface').StatusLookupIdentifier): Promise<ProviderResult<UsageResult>>

  getRates(): Promise<ProviderResult<RateResult[]>>

  getQRCode(iccid: string): Promise<ProviderResult<import('./connectors/connector-interface').QRCodeResult>>

  handleWebhook(payload: WebhookPayload): Promise<ProviderResult<{ handled: boolean; action?: string }>>
  topUpESIM(params: TopUpESIMParams): Promise<ProviderResult<TopUpESIMResult>>
}
