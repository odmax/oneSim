export const TELNA_ENDPOINTS = {
  // ── Telna Connect V2.1 (authoritative vendor collection "V2.1 APIs - One Global") ──
  // Every path carries the /v2.1 module prefix. No unversioned paths remain.
  // CORE
  countries: '/v2.1/core/countries',
  company: '/v2.1/core/companies/{company_id}',
  companies: '/v2.1/core/companies',
  // INVENTORY
  inventories: '/v2.1/inventory/inventories',
  inventory: '/v2.1/inventory/inventories/{inventory_id}',
  groups: '/v2.1/inventory/groups',
  group: '/v2.1/inventory/groups/{group_id}',
  simRegistries: '/v2.1/inventory/sim-registries',
  simRegistry: '/v2.1/inventory/sim-registries/{iccid}',
  // PCR
  packageTemplates: '/v2.1/pcr/package-templates',
  packageTemplate: '/v2.1/pcr/package-templates/{package_template_id}',
  packages: '/v2.1/pcr/packages',
  package: '/v2.1/pcr/packages/{package_id}',
  simPCRProfiles: '/v2.1/pcr/sim-pcr-profiles',
  simPCRProfile: '/v2.1/pcr/sim-pcr-profiles/{iccid}',
  simProfiles: '/v2.1/pcr/sim-pcr-profiles',
  wallet: '/v2.1/pcr/wallets/{wallet_id}',
  wallets: '/v2.1/pcr/wallets',
  trafficPolicies: '/v2.1/pcr/traffic-policies',
  trafficPolicy: '/v2.1/pcr/traffic-policies/{traffic_policy_id}',
  // USAGE (legacy read helpers; usage is primarily served via /v2.1/pcr/packages)
  simUsage: '/v2.1/usage/{iccid}',
  simSessions: '/v2.1/usage/sessions/{iccid}',
  simBalances: '/v2.1/usage/balances/{iccid}',
  consumption: '/v2.1/usage/consumption',
  // ESIM RSP (eUICC profile)
  euiccProfile: '/v2.1/esim-rsp/euicc-profiles/{iccid}', // GET installation data
  // SESSION management (paid add-on — not enabled on the standard account)
  openDataSessions: '/v2.1/session-management/open-data-sessions', // GET ?iccid= — add-on, disabled
} as const

export type TelnaEndpoint = keyof typeof TELNA_ENDPOINTS

/**
 * Telna Connect V2.1 auth families, from the authoritative vendor collection.
 *
 * COLLECTION-LEVEL AUTH (default for every request):
 *   Authorization: <API_ACCESS_KEY_ID>     (raw API key — NO "Bearer " prefix)
 *
 * PCR package-template/package requests additionally carry:
 *   ApiKey: <api_key>                      (explicit header shown in the collection)
 *
 * NO HTTP Basic and NO Bearer prefix are used anywhere. PCR does not use a
 * loginId/accessToken pair. Core reads are proven and included.
 *
 * Endpoints are classified by documented V2.1 module prefix:
 *   /v2.1/core/*      → CORE      (Authorization API key)
 *   /v2.1/pcr/*       → PCR       (Authorization API key + ApiKey)
 *   /v2.1/inventory/* → INVENTORY (Authorization API key)
 *   /v2.1/esim-rsp/*  → ESIM_RSP  (Authorization API key)
 *   /v2.1/session-management/* → SESSION (Authorization API key; paid add-on)
 *   /v2.1/usage/*     → USAGE     (Authorization API key)
 */
export type TelnaAuthFamily =
  | 'PCR'
  | 'INVENTORY'
  | 'ESIM_RSP'
  | 'SESSION'
  | 'CORE'
  | 'USAGE'
  | 'UNVERIFIED'

const TELNA_ENDPOINT_AUTH: Record<TelnaEndpoint, TelnaAuthFamily> = {
  // /v2.1/core/*
  countries: 'CORE',
  company: 'CORE',
  companies: 'CORE',
  // /v2.1/inventory/*
  inventories: 'INVENTORY',
  inventory: 'INVENTORY',
  groups: 'INVENTORY',
  group: 'INVENTORY',
  simRegistries: 'INVENTORY',
  simRegistry: 'INVENTORY',
  // /v2.1/pcr/*
  packageTemplates: 'PCR',
  packageTemplate: 'PCR',
  packages: 'PCR',
  package: 'PCR',
  simPCRProfiles: 'PCR',
  simPCRProfile: 'PCR',
  simProfiles: 'PCR',
  wallet: 'PCR',
  wallets: 'PCR',
  trafficPolicies: 'PCR',
  trafficPolicy: 'PCR',
  // /v2.1/usage/*
  simUsage: 'USAGE',
  simSessions: 'USAGE',
  simBalances: 'USAGE',
  consumption: 'USAGE',
  // ESIM RSP + SESSION (Authorization API key; session is a paid add-on).
  euiccProfile: 'ESIM_RSP',
  openDataSessions: 'SESSION',
}

export function telnaEndpointAuthFamily(endpoint: TelnaEndpoint): TelnaAuthFamily {
  return TELNA_ENDPOINT_AUTH[endpoint]
}

/** True when an endpoint has a documented, proven path/prefix (non-UNVERIFIED). */
export function isTelnaEndpointProven(endpoint: TelnaEndpoint): boolean {
  return TELNA_ENDPOINT_AUTH[endpoint] !== 'UNVERIFIED'
}

/**
 * Single source of truth for a Telna endpoint PATH (relative). Every Telna
 * request — testConnection, Discovery (listCountries/getCompany/...), and all
 * other connector operations — resolves its path through this getter so there
 * is exactly one canonical path per endpoint.
 */
export function telnaEndpointPath(endpoint: TelnaEndpoint): string {
  return TELNA_ENDPOINTS[endpoint]
}

/**
 * Compose the absolute Telna URL for an endpoint, preserving any path prefix the
 * configured apiBaseUrl already carries (never duplicated) and tolerating a
 * trailing slash on the base URL. Path parameters are substituted last.
 */
export function buildTelnaEndpointUrl(
  apiBaseUrl: string,
  endpoint: TelnaEndpoint,
  pathParams?: Record<string, string | number>,
): string {
  const base = String(apiBaseUrl || '').replace(/\/+$/, '')
  let path: string = TELNA_ENDPOINTS[endpoint]
  if (pathParams) {
    for (const [key, value] of Object.entries(pathParams)) {
      path = path.replace(`{${key}}`, String(value))
    }
  }
  return `${base}${path}`
}

export interface TelnaPaginatedResponse<T> {
  data: T[]
  total: number
  offset: number
  count: number
}

export interface TelnaCountry {
  id: number
  name: string
  iso: string
  code?: string
  region?: string
  flag?: string
}

export interface TelnaCompany {
  id: number
  name: string
  code: string
  status: string
  type?: string
  countryId?: number
  taxId?: string
  address?: string
  phone?: string
  email?: string
}

export interface TelnaInventory {
  id: number
  name: string
  type: string
  status: string
  companyId: number
  totalSims: number
  availableSims: number
  allocatedSims: number
  defectiveSims: number
  testSims: number
}

export interface TelnaGroup {
  id: number
  name: string
  inventoryId: number
  status: string
  profileId?: number
  totalSims: number
  availableSims: number
  allocatedSims: number
}

export interface TelnaWallet {
  id: number
  name: string
  currency: string
  balance: number
  status: string
  companyId: number
  type?: string
  minimumBalance?: number
  maximumBalance?: number
  lastTransactionDate?: string
}

// ── Package Template DTOs (Telna Phase 2A) ──────────────────────────────

export interface TelnaTimeAllowance {
  value: number
  unit: 'DAY' | 'WEEK' | 'MONTH' | 'CALENDAR_MONTH' | 'HOUR' | string
}

export interface TelnaDataAllowance {
  value: number
  unit: 'MB' | 'GB' | 'TB' | 'UNLIMITED' | string
}

export interface TelnaPriceInfo {
  amount: number
  currency: string
  type?: 'FIXED' | 'RECURRING' | string
  billingPeriod?: TelnaTimeAllowance
}

export interface TelnaCoverageZone {
  id?: number
  name?: string
  countries?: Array<{ id?: number; name?: string; iso?: string; code?: string }>
  countryCodes?: string[]
  type?: 'GLOBAL' | 'REGIONAL' | 'LOCAL' | string
}

export interface TelnaPackageTemplate {
  id: string | number
  name: string
  description?: string
  type?: string
  status?: string
  inventory_id?: string | number
  package_type?: string
  currency?: string
  price?: number | TelnaPriceInfo
  charging?: {
    type?: string
    amount?: number
    currency?: string
    billing_period?: TelnaTimeAllowance
  }
  data_allowance?: TelnaDataAllowance
  voice_allowance?: TelnaDataAllowance
  sms_allowance?: TelnaDataAllowance
  time_allowance?: TelnaTimeAllowance
  speed_allowance?: TelnaDataAllowance
  countries?: Array<{ id?: number; name?: string; iso?: string; code?: string }>
  zones?: TelnaCoverageZone[]
  traffic_policy_id?: string | number
  route_policy_id?: string | number
  recurring?: {
    enabled?: boolean
    period?: TelnaTimeAllowance
    renewal_price?: number
  }
  coverage_type?: string
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

export interface TelnaPackageTemplateDetail {
  id: string | number
  name: string
  description?: string
  type?: string
  status?: string
  inventory_id?: string | number
  package_type?: string
  currency?: string
  price?: number | TelnaPriceInfo
  charging?: {
    type?: string
    amount?: number
    currency?: string
    billing_period?: TelnaTimeAllowance
  }
  data_allowance?: TelnaDataAllowance
  voice_allowance?: TelnaDataAllowance
  sms_allowance?: TelnaDataAllowance
  time_allowance?: TelnaTimeAllowance
  speed_allowance?: TelnaDataAllowance
  countries?: Array<{ id?: number; name?: string; iso?: string; code?: string }>
  zones?: TelnaCoverageZone[]
  traffic_policy_id?: string | number
  route_policy_id?: string | number
  recurring?: {
    enabled?: boolean
    period?: TelnaTimeAllowance
    renewal_price?: number
  }
  coverage_type?: string
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

export interface MappedTelnaPackageTemplate {
  providerTemplateId: string
  name: string
  description: string | null
  inventoryId: number | null
  status: string
  currency: string
  providerCost: number | null
  dataAllowance: { value: number; unit: string } | null
  dataBytes: number | null
  dataMB: number | null
  dataGB: number | null
  unlimitedData: boolean
  timeAllowance: { value: number; unit: string } | null
  validityDays: number | null
  countries: string[]
  countryCodes: string[]
  regions: string[]
  trafficPolicyId: string | null
  routePolicyId: string | null
  warnings: string[]
  fees?: Array<{ type: string; amount: number; currency: string; chargeTiming: string }>
  rawData: Record<string, unknown>
}

// ── Package DTOs (Telna Phase 2B) ──────────────────────────────────────

export interface TelnaPackage {
  id: string | number
  package_template_id?: string | number
  inventory_id?: string | number
  name?: string
  status?: string
  data_allowance?: TelnaDataAllowance
  time_allowance?: TelnaTimeAllowance
  price?: number | TelnaPriceInfo
  currency?: string
  countries?: Array<{ id?: number; name?: string; iso?: string; code?: string }>
  zones?: TelnaCoverageZone[]
  traffic_policy_id?: string | number
  route_policy_id?: string | number
  wallet_id?: string | number
  activation_mode?: string
  coverage_type?: string
  type?: string
  description?: string
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

export interface MappedTelnaPackage {
  providerPackageId: string
  providerTemplateId: string | null
  name: string
  status: string
  currency: string
  costPrice: number | null
  dataGB: number | null
  dataBytes: number | null
  validityDays: number | null
  country: string | null
  region: string | null
  countryCodes: string[]
  coverageType: string | null
  planType: string | null
  isAvailable: boolean
  warnings: string[]
  rawData: Record<string, unknown>
}

// ── SIM Registry DTOs (Telna Phase 3) ────────────────────────────────────

export interface TelnaSimRegistry {
  id: number
  iccid: string
  imsi?: string
  msisdn?: string
  status: string
  activation_status?: string
  inventory_id?: number
  group_id?: number
  wallet_id?: number
  current_package_id?: string | number
  package_template_id?: string | number
  traffic_policy_id?: number
  pcr_profile_id?: number
  activation_date?: string
  last_session?: string
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

export type TelnaSimStatus =
  | 'AVAILABLE'
  | 'ALLOCATED'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'INACTIVE'
  | 'RETIRED'

export interface MappedTelnaSimRegistry {
  iccid: string
  imsi: string | null
  msisdn: string | null
  inventoryId: number | null
  groupId: number | null
  walletId: number | null
  currentPackageId: string | null
  packageTemplateId: string | null
  trafficPolicyId: number | null
  profileId: number | null
  activationDate: string | null
  lastSession: string | null
  providerStatus: string
  status: string
  normalizedStatus: string
  createdAt: string | null
  updatedAt: string | null
  rawData: Record<string, unknown>
}

// ── PCR Profile DTOs (Telna Phase 4) ────────────────────────────────────

export interface TelnaPCRPackage {
  id?: number | string
  package_template_id?: number | string
  name?: string
}

export interface TelnaPCRProfile {
  id: number
  iccid: string
  status: string
  current_package?: TelnaPCRPackage
  pending_package?: TelnaPCRPackage
  traffic_policy_id?: number
  wallet_id?: number
  activation_state?: string
  renewal?: {
    enabled?: boolean
    renewal_date?: string
    renewal_package_id?: number | string
  }
  expiration?: {
    expired?: boolean
    expiration_date?: string
  }
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

export interface MappedTelnaPCRProfile {
  iccid: string
  status: string
  currentPackage: {
    id: string | null
    packageTemplateId: string | null
    name: string | null
  }
  pendingPackage: {
    id: string | null
    packageTemplateId: string | null
    name: string | null
  }
  trafficPolicyId: number | null
  walletId: number | null
  activationState: string | null
  renewal: {
    enabled: boolean
    renewalDate: string | null
    renewalPackageId: string | null
  }
  expiration: {
    expired: boolean
    expirationDate: string | null
  }
  createdAt: string | null
  updatedAt: string | null
  rawData: Record<string, unknown>
}

export interface TelnaPCRProfileUpdate {
  package_template_id?: number | string
  traffic_policy_id?: number
  renewal?: {
    enabled?: boolean
    renewal_package_id?: number | string
  }
}

// ── Usage DTOs (Telna Phase 5) ──────────────────────────────────────────

export interface TelnaUsage {
  iccid: string
  package_name?: string
  bytes_used?: number
  bytes_remaining?: number
  total_allowance?: number
  percentage_used?: number
  data_used_mb?: number
  data_remaining_mb?: number
  data_total_mb?: number
  timestamp?: string
  [key: string]: unknown
}

export interface MappedTelnaUsage {
  iccid: string
  packageName: string | null
  bytesUsed: number | null
  bytesRemaining: number | null
  totalAllowance: number | null
  percentageUsed: number | null
  dataUsedMB: number | null
  dataRemainingMB: number | null
  dataTotalMB: number | null
  timestamp: string | null
  rawData: Record<string, unknown>
}

export interface TelnaSession {
  iccid?: string
  session_id?: string | number
  start_time?: string
  end_time?: string
  duration_sec?: number
  data_used_mb?: number
  country?: string
  operator?: string
  network?: string
  cost?: number
  currency?: string
  [key: string]: unknown
}

export interface MappedTelnaSession {
  sessionId: string | null
  startTime: string | null
  endTime: string | null
  durationSec: number | null
  durationLabel: string | null
  dataUsedMB: number | null
  country: string | null
  operator: string | null
  network: string | null
  cost: number | null
  currency: string | null
  rawData: Record<string, unknown>
}

export interface TelnaBalance {
  iccid?: string
  balance?: number
  currency?: string
  data_remaining_mb?: number
  data_remaining_bytes?: number
  voice_remaining?: string
  sms_remaining?: string
  monetary_balance?: number
  timestamp?: string
  [key: string]: unknown
}

export interface MappedTelnaBalance {
  iccid: string | null
  balance: number | null
  currency: string | null
  dataRemainingMB: number | null
  monetaryBalance: number | null
  timestamp: string | null
  rawData: Record<string, unknown>
}

export interface TelnaConsumption {
  iccid?: string
  period?: string
  total_bytes?: number
  total_mb?: number
  sessions_count?: number
  unique_countries?: number
  cost?: number
  currency?: string
  from_date?: string
  to_date?: string
  [key: string]: unknown
}

export interface MappedTelnaConsumption {
  iccid: string | null
  period: string | null
  totalBytes: number | null
  totalMB: number | null
  sessionsCount: number | null
  uniqueCountries: number | null
  cost: number | null
  currency: string | null
  fromDate: string | null
  toDate: string | null
  rawData: Record<string, unknown>
}

// ── Phase 1 documented contract DTOs (v2 package / sim / euicc surface) ──

/** Documented package template fields (data/voice/sms allowances in BYTES). */
export interface TelnaV2PackageTemplate {
  id?: number | string
  name?: string
  supported_countries?: string[]
  data_usage_allowance?: number              // BYTES
  voice_usage_allowance?: number             // minutes
  sms_usage_allowance?: number               // messages
  activation_time_allowance?: number         // seconds
  activation_type?: 'AUTO' | 'MANUAL' | string
  earliest_activation_date?: string
  earliest_available_date?: string
  latest_available_date?: string
  time_allowance?: number
  status?: string
  inventory?: Array<{ id?: number | string; name?: string }>
  apn?: string
  [key: string]: unknown
}

/** Documented POST /packages request. */
export interface TelnaCreatePackageRequest {
  sim: string               // existing Telna ICCID
  package_template: number  // Telna package template integer ID
  time_allowance?: number   // optional seconds
}

/** Documented created / listed package instance. */
export interface TelnaV2Package {
  id?: string | number
  sim?: string                        // ICCID
  created_date?: string
  expiry_date?: string
  activated_date?: string
  terminated_date?: string
  window_activation_start?: string
  window_activation_end?: string
  status?: 'NOT_ACTIVE' | 'ACTIVE' | 'TERMINATED' | string
  voice_usage_remaining?: number
  data_usage_remaining?: number       // BYTES
  sms_usage_remaining?: number
  time_allowance?: number
  package_template?: TelnaV2PackageTemplate | { id?: number | string; name?: string }
  apn?: string
  [key: string]: unknown
}

/** Documented SIM registry entry (v2). */
export interface TelnaV2SimRegistry {
  iccid?: string
  status?: 'WAITING_FOR_ASSIGNMENT' | 'PRE_SERVICE' | 'IN_SERVICE' | 'TERMINATED' | string
  inventory?: { id?: number | string; name?: string }
  group?: { id?: number | string; name?: string }
  [key: string]: unknown
}

/** Documented eUICC profile (installation/lifecycle data). */
export interface TelnaEuiccProfile {
  iccid?: string
  imsi?: string
  state?: 'AVAILABLE' | 'ALLOCATED' | 'LINKED' | 'CONFIRMED' | 'RELEASED' | 'DOWNLOADED' | 'INSTALLED' | 'ENABLED' | 'DISABLED' | 'ERROR' | 'UNAVAILABLE' | 'DELETED' | string
  last_operation_date?: string
  activation_code?: string
  reuse_remaining_count?: number
  reuse_enabled?: boolean
  release_date?: string
  cc_required?: boolean
  cc_retries?: number
  eid?: string
  [key: string]: unknown
}
