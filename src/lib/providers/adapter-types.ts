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
}

export interface UsageResult {
  iccid: string
  dataUsedMB: number
  timestamp?: string
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

  getActivationStatus(activationId: string): Promise<ProviderResult<{ status: string; iccids?: string[] }>>

  suspendESIM(subscriptionId: string): Promise<ProviderResult<void>>

  resumeESIM(subscriptionId: string): Promise<ProviderResult<void>>

  getUsage(iccid: string): Promise<ProviderResult<UsageResult>>

  getRates(): Promise<ProviderResult<RateResult[]>>

  getQRCode(iccid: string): Promise<ProviderResult<{ qrCodeUrl: string }>>

  handleWebhook(payload: WebhookPayload): Promise<ProviderResult<{ handled: boolean; action?: string }>>
  topUpESIM(params: TopUpESIMParams): Promise<ProviderResult<TopUpESIMResult>>
}
