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
  /**
   * Generic availability signal. Providers that can observe a plan/template is
   * NOT sellable (e.g. deactivated) set this false so the canonical sync marks
   * the persisted ProviderPackage unavailable instead of leaving it sellable.
   * Defaults to true for connectors that do not set it (backward-compatible).
   */
  isAvailable?: boolean
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
  /** QR/LPA installation payload string (e.g. `LPA:1$<smdp>$<matching-id>`),
   *  NOT an HTTP image URL. Connectors may return either qrCodeUrl (image) or
   *  qrCode (payload). */
  qrCode?: string
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
  /** Provider package↔eSIM association id used/discovered for this lookup
   *  (e.g. US-Matrix packageEsimId). Provider-owned and safe to persist so
   *  future usage lookups skip mobile-detail discovery. */
  providerPackageEsimId?: string
  /** Sanitized provider metadata safe to persist. */
  rawMetadata?: Record<string, any>
}

/**
 * Canonical activation-evidence signals a connector VERIFIED from provider
 * data. Provider-neutral. Only set when the connector has explicit evidence
 * for the exact target eSIM (e.g. US-Matrix network-attach event), NEVER
 * inferred from a weak "package active" claim. The generic lifecycle engine
 * uses these to promote ACTIVE/INSTALLED without a provider-name branch.
 * Defined as a type alias (not interface) so it is structurally assignable to
 * Prisma JSON inputs.
 */
export type StatusResultEvidence = {
  /** Verified network attach for the exact eSIM (e.g. DIAMETER_SUCCESS + serving network). */
  networkAttached?: boolean
  /** Verified profile installed/enabled on device (no network attach). */
  deviceInstalled?: boolean
  /** Provider event timestamp that produced the evidence (ISO 8601). */
  observedAt?: string
  /** Human-readable reason (sanitized, no credentials). */
  reason?: string
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
  /** Canonical activation-evidence signals the connector verified (see StatusResultEvidence). */
  evidence?: StatusResultEvidence
  /** Optional canonical install data recovered during a status lookup (e.g.
   *  AirHub GetActivationCode). Forwarded to finalization without inventing a
   *  second status type. */
  activationCode?: string
  qrCodeUrl?: string
  smdpAddress?: string
  matchingId?: string
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
  /** Optional provider-owned eSIM/activation UUID (US-Matrix usage discovery). */
  providerActivationId?: string
  /** Optional provider-owned package identity (provider package UUID / plan id).
   *  Used to match package↔eSIM associations deterministically (e.g. US-Matrix
   *  mobile-detail packageEsims[].package.id). Never a local OneSIM id. */
  providerPackageId?: string
  providerPlanId?: string
  /** Optional provider-owned subscription / package-instance reference (e.g.
   *  Telna exact package instance id). Never a local OneSIM id. */
  providerSubscriptionId?: string
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
  /** Optional provider metadata (e.g. persisted providerEsimId / packageEsimId). */
  providerResponse?: unknown
  providerSubscriberId?: string | null
  /** Optional provider-owned package identity (provider package UUID / plan id). */
  providerPackageId?: string | null
  providerPlanId?: string | null
}

export type InstallationLookupState = 'READY' | 'NOT_AVAILABLE_YET' | 'NOT_SUPPORTED' | 'NOT_RECOVERABLE' | 'PERMANENT_FAILURE'

/**
 * Canonical installation-lookup contract. The input is provider-owned
 * identifiers only (never a local OneSIM id). The result never carries a raw
 * provider payload; `diagnostics` holds safe metadata (method/identifier/http
 * status/duration and response KEYS only, never values).
 */
export interface InstallationLookupInput {
  esimId?: string | null
  iccid?: string | null
  imsi?: string | null
  imsiVersion?: string | number | null
  providerSubscriptionId?: string | null
  providerActivationId?: string | null
}

export interface InstallationLookupDiagnostics {
  methodUsed?: string
  identifierType?: string
  httpMethod?: string
  endpointName?: string
  httpStatus?: number
  durationMs?: number
  /** Response object keys only — never values, never a raw payload. */
  responseKeys?: string[]
  /**
   * Free-form SAFE note (no secrets). Used to clarify semantics, e.g. that the
   * queried endpoint is status/package metadata only and therefore a missing
   * QR/activation field is NOT proof the provider lacks installation data.
   */
  note?: string
}

export interface InstallationLookupResult {
  success: boolean
  state: InstallationLookupState
  data?: ConnectorInstallDataOutput
  errorCode?: string
  diagnostics?: InstallationLookupDiagnostics
}

/** Canonical, safe install-data output shape (whitelisted keys only). */
export interface ConnectorInstallDataOutput {
  qrCode?: string
  qrCodeUrl?: string
  activationCode?: string
  smdpAddress?: string
  matchingId?: string
}

/**
 * Connector-declared internal operation capabilities. This is the runtime truth
 * for what a connector can actually do (from its implementation), independent
 * of the provider DB capability booleans, the internal enable flags, and the
 * client portal/API exposure system.
 *
 * `installationDataAtPurchase` and `installationLookupHistorical` are declared
 * SEPARATELY: a provider may capture install data during NEW purchases (from
 * the activation response) while having NO verified read-only way to recover it
 * for already-provisioned eSIMs.
 *
 * The three installation capabilities accept a tri-state:
 *  - `true`            = the connector implements the capability
 *  - `false`           = explicit evidence the provider/connector does NOT support it
 *  - `'UNKNOWN'`       = no verified evidence either way (e.g. the official API
 *    mapping doc does not document a QR endpoint, but its absence is NOT proof
 *    the provider lacks installation data) → conservatively UNKNOWN, never
 *    claimed NOT_SUPPORTED.
 */
export interface ConnectorCapabilities {
  /**
   * Wired purchase path (activateESIM) implementation truth. Optional tri-state:
   *  - true        = connector implements a proven purchase mutation
   *  - false       = explicit evidence purchase is NOT wired
   *  - 'UNKNOWN'   = no verified evidence either way
   *  - absent      = legacy connectors: falls back to installationDataAtPurchase
   * Separated from installationDataAtPurchase because some providers complete
   * purchases without returning install data in the purchase response (install
   * data arrives later via status/installation lookup).
   */
  purchase?: boolean | 'UNKNOWN'
  installationLookup: boolean | 'UNKNOWN'
  installationDataAtPurchase: boolean | 'UNKNOWN'
  installationLookupHistorical: boolean | 'UNKNOWN'
  statusLookup: boolean
  usageLookup: boolean
  topUp: boolean
  suspend: boolean
  resume: boolean
  balance: boolean
  inventory: boolean
  webhooks: boolean
  /** Provider-side custom offering/template creation (createCustomPackage).
   *  Optional: absent/undefined means NOT supported (backward-compatible for
   *  connectors that do not implement createCustomPackage). */
  customPackageCreation?: boolean
}

export const DEFAULT_CONNECTOR_CAPABILITIES: ConnectorCapabilities = {
  installationLookup: false,
  installationDataAtPurchase: false,
  installationLookupHistorical: false,
  statusLookup: false,
  usageLookup: false,
  topUp: false,
  suspend: false,
  resume: false,
  balance: false,
  inventory: false,
  webhooks: false,
  customPackageCreation: false,
}

export type ConnectorAuthMode =
  | 'STATIC_KEY_ID'
  | 'STATIC_API_KEY'
  | 'BEARER_TOKEN'
  | 'LOGIN_TOKEN'
  | 'OAUTH'
  | 'BASIC'
  | 'NONE'
  | 'CUSTOM'

/**
 * Provider-neutral authentication contract. The connector declares HOW it
 * authenticates; the generic admin UI/service derives labels and behavior from
 * this instead of hardcoding provider names.
 *
 * Examples:
 *  STATIC_KEY_ID / STATIC_API_KEY:  credential stored encrypted (provider.apiToken);
 *    requiresRuntimeAuthentication=false → UI button "Save & Verify" (no fake login);
 *    verify by a read-only testConnection.
 *  LOGIN_TOKEN:  credentials → runtime token exchange → UI button "Save & Authenticate".
 *  BEARER_TOKEN: static bearer token → save + verify.
 *  OAUTH:        interactive connect flow.
 *  NONE:         no credentials → "Verify Connection".
 */
export interface ConnectorAuthProfile {
  mode: ConnectorAuthMode
  requiresRuntimeAuthentication: boolean
  canVerifyCredentials: boolean
  supportsRefresh: boolean
  /** Where a static credential is stored (provider.apiToken is encrypted). */
  credentialField?: 'apiToken' | 'apiKey' | 'keyId'
  /** Recommended admin action label; UI falls back to a default by mode. */
  actionLabel?: string
}

export function defaultAuthActionLabel(mode: ConnectorAuthMode): string {
  switch (mode) {
    case 'STATIC_KEY_ID':
    case 'STATIC_API_KEY':
    case 'BEARER_TOKEN':
      return 'Save & Verify'
    case 'OAUTH':
      return 'Connect'
    case 'NONE':
      return 'Verify Connection'
    case 'LOGIN_TOKEN':
    case 'BASIC':
    case 'CUSTOM':
    default:
      return 'Save & Authenticate'
  }
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

/** Provider-neutral custom package/offering create contract. */
export interface CustomPackageField {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'select'
  required: boolean
  options?: Array<{ value: string; label: string }>
}

export interface CustomPackageDefinition {
  /** Provider-owned inventory choices (id + label), if the provider requires one. */
  inventories?: Array<{ id: string | number; name: string }>
  /** Provider-owned traffic-policy choices (id + label), if required. */
  trafficPolicies?: Array<{ id: string | number; name: string }>
  /** Dynamic provider-specific required/optional fields (beyond the common ones). */
  providerFields: CustomPackageField[]
}

export interface CustomPackageDefinitionResult {
  success: boolean
  definition?: CustomPackageDefinition
  error?: { code: string; message: string }
}

/** Canonical custom offering create input (common OneSIM fields + provider-specific). */
export interface CustomPackageCreateInput {
  name: string
  countries?: string[]
  dataGB: number
  validityDays: number
  /** Optional provider activation-window allowance, expressed in SECONDS
   *  (maps 1:1 to Telna `activation_time_allowance`, an INTEGER with unit SECONDS). */
  activationTimeAllowanceSeconds?: number
  voiceMinutes?: number
  smsCount?: number
  activationType?: 'AUTO' | 'MANUAL' | string
  inventoryId?: string | number
  trafficPolicyId?: string | number
  notes?: string
  /** Provider-specific arbitrary fields. */
  providerValues?: Record<string, unknown>
}

export interface CustomPackageCreateResult {
  success: boolean
  providerPlanId?: string
  providerPlanCode?: string
  status?: string
  rawMetadata?: Record<string, unknown>
}

/**
 * Provider-neutral category for an upstream custom-offering creation outcome.
 * Lets the generic Mode B service take safe action (recover / retry / require
 * reconciliation) WITHOUT branching on provider code.
 */
export type UpstreamCreateCategory =
  | 'VALIDATION'
  | 'AUTH'
  | 'NOT_ENTITLED'
  | 'ALREADY_EXISTS'
  | 'RETRYABLE'
  | 'AMBIGUOUS'
  | 'UNKNOWN'

/**
 * Classify a connector error into a provider-neutral category for upstream
 * custom-package creation.
 *
 * AMBIGUOUS is reserved for outcomes where the request MAY have reached the
 * provider (timeout after dispatch, connection reset, socket closed) — a blind
 * re-create is never safe there.
 */
export function classifyUpstreamCreateError(error: { code?: string; message?: string; details?: any } | undefined | null): UpstreamCreateCategory {
  if (!error) return 'UNKNOWN'
  const code = String(error.code || '').toUpperCase()
  const msg = String(error.message || '').toLowerCase()
  const details = error.details || {}

  // Ambiguous transport outcomes.
  if (code === 'TIMEOUT' || details?.ambiguous === true || ['ECONNRESET', 'EPIPE', 'ERR_SOCKET_CLOSED', 'ETIMEDOUT'].includes(details?.causeCode || '')) {
    return 'AMBIGUOUS'
  }

  // Provider already has the object.
  if (code === 'ALREADY_EXISTS' || code === 'DUPLICATE' || (code === 'PROVIDER_REJECTED' && /already exists|duplicate|already used|conflict/.test(msg))) {
    return 'ALREADY_EXISTS'
  }

  // Auth / entitlement.
  if (code.includes('AUTH') || code === 'CHOICE_CREDENTIALS_MISSING' || code === 'UNAUTHORIZED' || code === 'CHOICE_AUTH_UNAUTHORIZED') {
    return 'AUTH'
  }
  if (code === 'CAPABILITY_NOT_ENABLED' || code === 'NOT_ENTITLED' || msg.includes('not enabled') || msg.includes('entitlement')) {
    return 'NOT_ENTITLED'
  }

  // Client-side validation.
  if (code === 'INVALID_REQUEST' || code === 'INVALID_JSON' || code === 'NO_BASE_URL') {
    return 'VALIDATION'
  }

  // Safe retries (request never dispatched / provider-side transient).
  if (code === 'NETWORK_ERROR' && details?.preDispatch === true) {
    return 'RETRYABLE'
  }

  return 'UNKNOWN'
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
  /**
   * Resolve the provider-appropriate USAGE-lookup identifier for an eSIM.
   * Optional — when absent, callers fall back to a safe provider-reference /
   * ICCID default. Usage identifiers may differ from status identifiers
   * (e.g. US-Matrix packageEsimId vs eSIM id). Never returns a local OneSIM id.
   */
  resolveUsageLookup?(esim: StatusLookupEsim): string | StatusLookupIdentifier | null
  /**
   * Connector-declared internal capabilities (runtime truth from the connector
   * implementation, NOT the provider DB booleans). Defaults to all-false when
   * absent.
   */
  capabilities?: ConnectorCapabilities
  /**
   * Connector-declared authentication contract. Generic admin UI/service derives
   * labels (Save & Verify vs Save & Authenticate) and the save/verify flow from
   * this instead of hardcoding provider names. Defaults to a runtime-auth
   * (CUSTOM) profile when absent.
   */
  authProfile?: ConnectorAuthProfile
  /**
   * Canonical read-only installation lookup. Never a purchase/subscription/
   * wallet mutation. Returns a safe normalized result with no raw provider
   * payload. Connectors that cannot look up installation data return
   * state=NOT_SUPPORTED.
   */
  lookupInstallationData?(input: InstallationLookupInput): Promise<InstallationLookupResult>
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

  /**
   * Provider-neutral custom offering/template creation contract.
   *
   * A connector that truthfully supports creating a NEW provider-side package
   * offering/template (e.g. Telna POST /v2.1/pcr/package-templates) declares
   * capabilities.CUSTOM_PACKAGE_CREATION and implements BOTH methods below.
   *
   * getCustomPackageDefinition() returns the provider's dynamic required/optional
   * fields. createCustomPackage(input) performs the provider mutation and returns
   * the provider-created offering id (= providerPlanId). Provider translation is
   * connector-local; NO local OneSIM id is sent upstream.
   */
  getCustomPackageDefinition?(): Promise<CustomPackageDefinitionResult>
  createCustomPackage?(input: CustomPackageCreateInput): Promise<ConnectorResult<CustomPackageCreateResult>>
  /**
   * Provider-neutral read-only reconciliation for an ambiguous purchase. A
   * connector that can defensibly correlate a timed-out mutation via documented
   * READ endpoints implements this; it MUST NOT issue a mutating provider call.
   * Returns resolved=true only on a unique, defensible match; otherwise
   * resolved=false with an explicit reason (no-match / multiple-matches /
   * inconclusive).
   */
  reconcileAmbiguousPurchase?(input: AmbiguousPurchaseReconcileInput): Promise<ConnectorResult<AmbiguousPurchaseReconcileResult>>
}

/** Input for a provider-neutral ambiguous-purchase reconciliation. */
export interface AmbiguousPurchaseReconcileInput {
  orderId: string
  /** Provider-owned SKU / bundle_code used at purchase time. */
  planId: string
  quantity: number
  /** ISO timestamp of the ambiguous attempt — correlation HINT only, never the sole basis. */
  attemptedAt: string
}

/** Result of a read-only reconciliation attempt (never a provider mutation). */
export interface AmbiguousPurchaseReconcileResult {
  resolved: boolean
  iccid?: string
  imsi?: string
  reason?: 'unique-match' | 'no-match' | 'multiple-matches' | 'inconclusive'
  evidence?: Record<string, unknown>
}

/**
 * Canonical classification of a purchase response that carried NO usable ICCID.
 *
 * A provider that accepted the mutation (HTTP 2xx, no explicit rejection) but
 * returned no ICCID MUST NOT be treated as a definitive failure — marking it so
 * could release reserved wallet funds for a purchase the provider has already
 * charged. Connectors call this to normalize that outcome using the existing
 * lifecycle semantics:
 *   - PENDING / PROCESSING  when the provider carries an explicit pending status
 *     and a usable reference (the async polling path polls the same provider).
 *   - DEFINITIVE            only when the provider explicitly reports failure.
 *   - AMBIGUOUS             when the provider signals success/unknown but OneSIM
 *     cannot prove fulfillment (caller returns an error whose `details` mark
 *     `ambiguous: true` / `upstreamConfirmed: true`, never retried against
 *     another provider, wallet never released).
 *
 * Never fabricates an ICCID.
 */
export type IccidlessOutcome =
  | { kind: 'PENDING'; status: 'PENDING' | 'PROCESSING'; providerOrderId: string }
  | { kind: 'DEFINITIVE'; providerOrderId: string }
  | { kind: 'AMBIGUOUS'; providerOrderId: string }

export function classifyPurchaseWithoutIccid(rawStatus: unknown, providerOrderId: string): IccidlessOutcome {
  const s = String(rawStatus || '').trim().toUpperCase()
  if (['PENDING', 'PROCESSING', 'QUEUED', 'IN_PROGRESS', 'INITIATED', 'RESERVED', 'PROVISIONING', 'PENDING_ACTIVATION'].includes(s)) {
    return { kind: 'PENDING', status: s === 'PROCESSING' ? 'PROCESSING' : 'PENDING', providerOrderId }
  }
  if (['FAILED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'ERROR'].includes(s)) {
    return { kind: 'DEFINITIVE', providerOrderId }
  }
  return { kind: 'AMBIGUOUS', providerOrderId }
}
