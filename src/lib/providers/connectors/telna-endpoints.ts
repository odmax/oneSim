/**
 * Telna Connect V2.1 auth families.
 *
 * COLLECTION-LEVEL AUTH (default for every request):
 *   Authorization: <API_ACCESS_KEY_ID>     (raw API key â€” NO "Bearer " prefix)
 *
 * PCR package-template/package/profile/wallet requests additionally carry:
 *   ApiKey: <api_key>                      (explicit header shown in the collection)
 *
 * NO HTTP Basic and NO Bearer prefix are used anywhere. PCR does not use a
 * loginId/accessToken pair.
 *
 * Endpoints are classified by documented V2.1 module prefix:
 *   /v2.1/core/*      â†’ CORE      (Authorization API key)
 *   /v2.1/pcr/*       â†’ PCR       (Authorization API key + ApiKey)
 *   /v2.1/inventory/* â†’ INVENTORY (Authorization API key)
 *   /v2.1/esim-rsp/*  â†’ ESIM_RSP  (Authorization API key)
 *   /v2.1/session-management/* â†’ SESSION (Authorization API key; paid add-on)
 *   /v2.1/usage/*     â†’ USAGE     (Authorization API key)
 *
 * `UNVERIFIED` marks a mapped contract whose exact path/auth is NOT yet
 * confirmed by the vendor docs â€” these are never called by the connector.
 */
export type TelnaAuthFamily =
  | 'PCR'
  | 'INVENTORY'
  | 'ESIM_RSP'
  | 'SESSION'
  | 'CORE'
  | 'USAGE'
  | 'UNVERIFIED'

/**
 * Telna endpoint entitlement classification â€” intentionally decoupled from
 * "endpoint exists in docs". An endpoint may be documented yet not enabled for
 * a given OneSIM account.
 *
 *   STANDARD        in the standard plan, usable
 *   ACCOUNT_GATED   contract supported; account not yet entitled
 *   PAID_ADDON      documented; requires a paid add-on (blocked)
 *   NOT_STANDARD    excluded from the standard plan (Sheldon)
 *   DANGEROUS       irreversible (e.g. SIM purge); never admin-exposed
 *   COMING_SOON     mapped contract, exact path/method not yet vendor-confirmed
 */
export type TelnaEntitlement =
  | 'STANDARD'
  | 'ACCOUNT_GATED'
  | 'PAID_ADDON'
  | 'NOT_STANDARD'
  | 'DANGEROUS'
  | 'COMING_SOON'

export type TelnaHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** READ or MUTATION â€” canonical derived operation type for an endpoint. */
export type TelnaOperationType = 'READ' | 'MUTATION'

/**
 * OneSIM exposure of a mapped Telna endpoint (canonical, derived):
 *   USED                     invoked by a OneSIM flow
 *   IMPLEMENTED_NOT_EXPOSED  provider method wired, no canonical OneSIM op maps to it
 *   MAPPED_ONLY              registered only; never invoked
 *   DISABLED                 mapped but gated/blocked (add-on / dangerous / excluded)
 */
export type TelnaOneSimExposure =
  | 'USED'
  | 'IMPLEMENTED_NOT_EXPOSED'
  | 'MAPPED_ONLY'
  | 'DISABLED'

/**
 * Endpoint provenance — the basis on which the registry entry's method/path/auth
 * is asserted. Independent of entitlement / exposure / operation type.
 *   LIVE_PROVEN           a staging/live provider request observed the contract
 *   SOURCE_PROVEN         exact method/path established by vendor source material
 *   EXISTING_CODE_PROVEN  a prior OneSIM implementation existed (does NOT prove vendor correctness)
 *   UNVERIFIED            exact vendor contract not proven — never USED / never callable
 */
export type TelnaEndpointProvenance =
  | 'LIVE_PROVEN'
  | 'SOURCE_PROVEN'
  | 'EXISTING_CODE_PROVEN'
  | 'UNVERIFIED'

/** Canonical definition of one Telna endpoint (single source of truth). */
export interface TelnaEndpointDef {
  method: TelnaHttpMethod
  /** Relative path including the /v2.1 module prefix. */
  path: string
  /** Auth family used when calling (UNVERIFIED ⇒ never called). */
  auth: TelnaAuthFamily
  /** True when the operation mutates provider/account state (READ/MUTATION). */
  mutation: boolean
  entitlement: TelnaEntitlement
  module: string
  /** OneSIM use / rationale for the endpoint. */
  use: string
  /** OneSIM exposure (derived canonically from entitlement/module/mutation via helpers). */
  exposure: TelnaOneSimExposure
  /** Provenance of the method/path/auth contract (independent of exposure/entitlement). */
  provenance: readonly TelnaEndpointProvenance[]
}

/**
 * â”€â”€ TELNA CONNECT V2.1 â€” CENTRAL ENDPOINT REGISTRY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * Every Telna endpoint is defined once here. If Telna later changes a host,
 * path, HTTP method, or auth family, this registry (and its tests) is the only
 * place to edit â€” generic OneSIM architecture and connector methods reference
 * endpoint KEYS, never literal `/v2.1/...` URLs.
 */
export const TELNA_ENDPOINTS = {
  // â”€â”€ CORE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  countries: {
    exposure: 'USED',
    provenance: ['LIVE_PROVEN', 'SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/core/countries', auth: 'CORE', mutation: false,
    entitlement: 'STANDARD', module: 'CORE', use: 'testConnection + discovery',
  },
  companies: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/core/companies', auth: 'CORE', mutation: false,
    entitlement: 'STANDARD', module: 'CORE', use: 'listCompanies discovery (paged)',
  },
  companiesCreate: {
    exposure: 'MAPPED_ONLY',
    provenance: ['UNVERIFIED'],
    method: 'POST', path: '/v2.1/core/companies', auth: 'CORE', mutation: true,
    entitlement: 'NOT_STANDARD', module: 'CORE', use: 'excluded from standard plan (Sheldon)',
  },
  company: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/core/companies/{company_id}', auth: 'CORE', mutation: false,
    entitlement: 'STANDARD', module: 'CORE', use: 'getCompany discovery',
  },
  companyUpdate: {
    exposure: 'MAPPED_ONLY',
    provenance: ['UNVERIFIED'],
    method: 'PUT', path: '/v2.1/core/companies/{company_id}', auth: 'CORE', mutation: true,
    entitlement: 'NOT_STANDARD', module: 'CORE', use: 'excluded from standard plan (Sheldon)',
  },

  // â”€â”€ INVENTORY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  inventories: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/inventory/inventories', auth: 'INVENTORY', mutation: false,
    entitlement: 'STANDARD', module: 'INVENTORY', use: 'listInventories discovery (paged; company filter)',
  },
  inventoryCreate: {
    exposure: 'MAPPED_ONLY',
    provenance: ['UNVERIFIED'],
    method: 'POST', path: '/v2.1/inventory/inventories', auth: 'INVENTORY', mutation: true,
    entitlement: 'NOT_STANDARD', module: 'INVENTORY', use: 'excluded from standard plan (Sheldon)',
  },
  inventory: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/inventory/inventories/{inventory_id}', auth: 'INVENTORY', mutation: false,
    entitlement: 'STANDARD', module: 'INVENTORY', use: 'getInventory discovery',
  },
  inventoryUpdate: {
    exposure: 'MAPPED_ONLY',
    provenance: ['UNVERIFIED'],
    method: 'PUT', path: '/v2.1/inventory/inventories/{inventory_id}', auth: 'INVENTORY', mutation: true,
    entitlement: 'NOT_STANDARD', module: 'INVENTORY', use: 'excluded from standard plan (Sheldon)',
  },
  groups: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/inventory/groups', auth: 'INVENTORY', mutation: false,
    entitlement: 'STANDARD', module: 'INVENTORY', use: 'listGroups discovery (paged)',
  },
  group: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/inventory/groups/{group_id}', auth: 'INVENTORY', mutation: false,
    entitlement: 'STANDARD', module: 'INVENTORY', use: 'getGroup discovery',
  },
  simRegistries: {
    exposure: 'USED',
    provenance: ['LIVE_PROVEN', 'SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/inventory/sim-registries', auth: 'INVENTORY', mutation: false,
    entitlement: 'STANDARD', module: 'INVENTORY', use: 'listSimRegistries (paged; status/inventory/group/provider filters)',
  },
  simRegistry: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/inventory/sim-registries/{iccid}', auth: 'INVENTORY', mutation: false,
    entitlement: 'STANDARD', module: 'INVENTORY', use: 'getSimRegistry / status normalization',
  },
  simRegistryPurge: {
    exposure: 'DISABLED',
    provenance: ['UNVERIFIED'],
    method: 'DELETE', path: '/v2.1/inventory/sim-registries/{iccid}', auth: 'INVENTORY', mutation: true,
    entitlement: 'DANGEROUS', module: 'INVENTORY', use: 'irreversible SIM purge â€” NEVER exposed via ordinary admin action',
  },

  // â”€â”€ PCR â€” package templates (provider OFFERINGS) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  packageTemplates: {
    exposure: 'USED',
    provenance: ['LIVE_PROVEN', 'SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/pcr/package-templates', auth: 'PCR', mutation: false,
    entitlement: 'STANDARD', module: 'PCR', use: 'listPackageTemplates sync (inventory filter, paged)',
  },
  packageTemplateCreate: {
    exposure: 'IMPLEMENTED_NOT_EXPOSED',
    provenance: ['SOURCE_PROVEN'],
    method: 'POST', path: '/v2.1/pcr/package-templates', auth: 'PCR', mutation: true,
    entitlement: 'ACCOUNT_GATED', module: 'PCR', use: 'provider custom-offering creation (gated by CUSTOM_PACKAGE_CREATION)',
  },
  packageTemplate: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/pcr/package-templates/{package_template_id}', auth: 'PCR', mutation: false,
    entitlement: 'STANDARD', module: 'PCR', use: 'getPackageTemplate â€” verify created template + plan sync read-back',
  },
  packageTemplateUpdate: {
    exposure: 'MAPPED_ONLY',
    provenance: ['UNVERIFIED'],
    method: 'PUT', path: '/v2.1/pcr/package-templates/{package_template_id}', auth: 'PCR', mutation: true,
    entitlement: 'COMING_SOON', module: 'PCR', use: 'mapped; not confirmed in docs â€” never called until confirmed',
  },

  // â”€â”€ PCR â€” packages (assigned service INSTANCES on a SIM) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  packages: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/pcr/packages', auth: 'PCR', mutation: false,
    entitlement: 'STANDARD', module: 'PCR', use: 'listPackages â€” usage/instance reads, package-instance status',
  },
  packageCreate: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN'],
    method: 'POST', path: '/v2.1/pcr/packages', auth: 'PCR', mutation: true,
    entitlement: 'STANDARD', module: 'PCR', use: 'fulfillment/purchase â€” assign a package INSTANCE to a SIM (distinct from template POST)',
  },
  package: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/pcr/packages/{package_id}', auth: 'PCR', mutation: false,
    entitlement: 'STANDARD', module: 'PCR', use: 'getPackage detail',
  },
  packageUpdate: {
    exposure: 'IMPLEMENTED_NOT_EXPOSED',
    provenance: ['SOURCE_PROVEN', 'EXISTING_CODE_PROVEN'],
    method: 'PUT', path: '/v2.1/pcr/packages/{package_id}', auth: 'PCR', mutation: true,
    entitlement: 'ACCOUNT_GATED', module: 'PCR', use: 'provider method exists; no OneSIM lifecycle clearly maps â€” internal only',
  },

  // â”€â”€ PCR â€” SIM PCR profiles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  simPCRProfiles: {
    exposure: 'MAPPED_ONLY',
    provenance: ['UNVERIFIED'],
    method: 'GET', path: '/v2.1/pcr/sim-pcr-profiles', auth: 'PCR', mutation: false,
    entitlement: 'COMING_SOON', module: 'PCR', use: 'sim-pcr-profiles COLLECTION not independently proven (only {iccid} detail is); never called by OneSIM',
  },
  simPCRProfile: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/pcr/sim-pcr-profiles/{iccid}', auth: 'PCR', mutation: false,
    entitlement: 'STANDARD', module: 'PCR', use: 'getSimPCRProfile â€” subscriber/network policy evidence for status/diagnostics',
  },
  simPCRProfileUpdate: {
    exposure: 'IMPLEMENTED_NOT_EXPOSED',
    provenance: ['SOURCE_PROVEN'],
    method: 'PUT', path: '/v2.1/pcr/sim-pcr-profiles/{iccid}', auth: 'PCR', mutation: true,
    entitlement: 'ACCOUNT_GATED', module: 'PCR', use: 'provider method; suspend/resume/throttle mapping ONLY if docs prove exact fields',
  },

  // â”€â”€ PCR â€” wallets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  wallets: {
    exposure: 'USED',
    provenance: ['LIVE_PROVEN', 'SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/pcr/wallets', auth: 'PCR', mutation: false,
    entitlement: 'ACCOUNT_GATED', module: 'PCR', use: 'listWallets â€” staging account currently 403 (account entitlement, not absence)',
  },
  wallet: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/pcr/wallets/{wallet_id}', auth: 'PCR', mutation: false,
    entitlement: 'ACCOUNT_GATED', module: 'PCR', use: 'getWallet â€” balance/identity',
  },
  walletUpdate: {
    exposure: 'IMPLEMENTED_NOT_EXPOSED',
    provenance: ['SOURCE_PROVEN'],
    method: 'PATCH', path: '/v2.1/pcr/wallets/{wallet_id}', auth: 'PCR', mutation: true,
    entitlement: 'ACCOUNT_GATED', module: 'PCR', use: 'wallet PATCH â€” mapped, provider method available, NOT a normal OneSIM capability',
  },

  // â”€â”€ PCR â€” traffic / route policies â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  trafficPolicies: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/pcr/traffic-policies', auth: 'PCR', mutation: false,
    entitlement: 'STANDARD', module: 'PCR', use: 'listTrafficPolicies discovery + custom-template input (paged)',
  },
  trafficPolicy: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/pcr/traffic-policies/{traffic_policy_id}', auth: 'PCR', mutation: false,
    entitlement: 'STANDARD', module: 'PCR', use: 'getTrafficPolicy detail',
  },
  routePolicies: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/pcr/route-policies', auth: 'PCR', mutation: false,
    entitlement: 'STANDARD', module: 'PCR', use: 'listRoutePolicies discovery (inventory REQUIRED) â€” provider config, NOT OneSIM routing',
  },

  // â”€â”€ USAGE reads (legacy helpers; canonical usage via /v2.1/pcr/packages) â”€
  simUsage: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN', 'EXISTING_CODE_PROVEN'],
    method: 'GET', path: '/v2.1/usage/{iccid}', auth: 'USAGE', mutation: false,
    entitlement: 'STANDARD', module: 'USAGE', use: 'getSimUsage read helper',
  },
  simSessions: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN', 'EXISTING_CODE_PROVEN'],
    method: 'GET', path: '/v2.1/usage/sessions/{iccid}', auth: 'USAGE', mutation: false,
    entitlement: 'STANDARD', module: 'USAGE', use: 'session history read helper',
  },
  simBalances: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN', 'EXISTING_CODE_PROVEN'],
    method: 'GET', path: '/v2.1/usage/balances/{iccid}', auth: 'USAGE', mutation: false,
    entitlement: 'STANDARD', module: 'USAGE', use: 'balance read helper',
  },
  consumption: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN', 'EXISTING_CODE_PROVEN'],
    method: 'GET', path: '/v2.1/usage/consumption', auth: 'USAGE', mutation: false,
    entitlement: 'STANDARD', module: 'USAGE', use: 'aggregate consumption read helper',
  },

  // â”€â”€ ESIM RSP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  euiccProfile: {
    exposure: 'USED',
    provenance: ['SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/esim-rsp/euicc-profiles/{iccid}', auth: 'ESIM_RSP', mutation: false,
    entitlement: 'STANDARD', module: 'ESIM_RSP', use: 'installation metadata (activation_code/state/cc_required/reuse_enabled) â€” never logs activation_code/ICCID/IMSI/EID',
  },

  // â”€â”€ SESSION MANAGEMENT (paid add-on) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  openDataSessions: {
    exposure: 'DISABLED',
    provenance: ['SOURCE_PROVEN'],
    method: 'GET', path: '/v2.1/session-management/open-data-sessions', auth: 'SESSION', mutation: false,
    entitlement: 'PAID_ADDON', module: 'SESSION', use: 'open data sessions â€” PAID ADD-ON; never called as ordinary operation',
  },

  // â”€â”€ SMS (paid add-on) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  smsSend: {
    exposure: 'DISABLED',
    provenance: ['UNVERIFIED'],
    method: 'POST', path: '/v2.1/sms/send', auth: 'UNVERIFIED', mutation: true,
    entitlement: 'PAID_ADDON', module: 'SMS', use: 'SMS outbound â€” PAID ADD-ON; path not yet vendor-confirmed, never called',
  },
} as const satisfies Record<string, TelnaEndpointDef>

export type TelnaEndpoint = keyof typeof TELNA_ENDPOINTS

export function telnaEndpointDef(endpoint: TelnaEndpoint): TelnaEndpointDef {
  return TELNA_ENDPOINTS[endpoint]
}

/** True when an endpoint is safe to call: proven auth family AND non-UNVERIFIED provenance. */
export function isTelnaEndpointProven(endpoint: TelnaEndpoint): boolean {
  const d = TELNA_ENDPOINTS[endpoint]
  if (d.auth === 'UNVERIFIED') return false
  if (d.provenance.some(p => p === 'UNVERIFIED')) return false
  return true
}

/** HTTP method for an endpoint, from the registry (single source of truth). */
export function telnaEndpointMethod(endpoint: TelnaEndpoint): TelnaHttpMethod {
  return TELNA_ENDPOINTS[endpoint].method
}

/**
 * Single source of truth for a Telna endpoint PATH (relative). Every Telna
 * request resolves its path through this getter so there is exactly one
 * canonical path per endpoint.
 */
export function telnaEndpointPath(endpoint: TelnaEndpoint): string {
  return TELNA_ENDPOINTS[endpoint].path
}

export function telnaEndpointAuthFamily(endpoint: TelnaEndpoint): TelnaAuthFamily {
  return TELNA_ENDPOINTS[endpoint].auth
}

export function telnaEndpointMutation(endpoint: TelnaEndpoint): boolean {
  return TELNA_ENDPOINTS[endpoint].mutation
}

export function telnaEndpointEntitlement(endpoint: TelnaEndpoint): TelnaEntitlement {
  return TELNA_ENDPOINTS[endpoint].entitlement
}

/** Canonical derived READ/MUTATION operation type (from mutation flag). */
export function telnaEndpointOperationType(endpoint: TelnaEndpoint): TelnaOperationType {
  return TELNA_ENDPOINTS[endpoint].mutation ? 'MUTATION' : 'READ'
}

/** Canonical OneSIM exposure for an endpoint (stored on the registry entry). */
export function telnaEndpointOneSimExposure(endpoint: TelnaEndpoint): TelnaOneSimExposure {
  return TELNA_ENDPOINTS[endpoint].exposure
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
  let path: string = TELNA_ENDPOINTS[endpoint].path
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

// â”€â”€ Package Template DTOs (Telna Phase 2A) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Package DTOs (Telna Phase 2B) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ SIM Registry DTOs (Telna Phase 3) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ PCR Profile DTOs (Telna Phase 4) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Usage DTOs (Telna Phase 5) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Phase 1 documented contract DTOs (v2 package / sim / euicc surface) â”€â”€

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

/**
 * POST /v2.1/pcr/package-templates â€” create a NEW package OFFERING/TEMPLATE
 * (distinct from POST /packages which assigns a package instance to a SIM).
 * Documented fields per the V2.1 collection. All identifiers are provider-owned.
 */
export interface TelnaCreatePackageTemplateRequest {
  name: string
  traffic_policy?: string | number
  supported_countries?: string[]
  voice_usage_allowance?: number       // minutes
  data_usage_allowance?: number        // BYTES
  sms_usage_allowance?: number         // messages
  activation_time_allowance?: number   // seconds
  activation_type?: 'AUTO' | 'MANUAL' | string
  earliest_activation_date?: string
  earliest_available_date?: string
  latest_available_date?: string
  notes?: string
  /** Documented validity/time allowance OBJECT { duration, unit } (unit: CALENDAR_MONTH | SECOND). */
  time_allowance?: { duration: number; unit: 'CALENDAR_MONTH' | 'SECOND' }
  inventory?: string | number
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

// â”€â”€ Company / Inventory write DTOs (NOT_STANDARD_PLAN; never enabled) â”€â”€â”€â”€

/** Documented create-company body (excluded from standard plan â€” gated only). */
export interface TelnaCreateCompanyRequest {
  name: string
  code?: string
  type?: string
  country_id?: number
  tax_id?: string
  address?: string
  phone?: string
  email?: string
  [key: string]: unknown
}

/** Documented update-company body (excluded from standard plan â€” gated only). */
export interface TelnaUpdateCompanyRequest {
  name?: string
  type?: string
  country_id?: number
  tax_id?: string
  address?: string
  phone?: string
  email?: string
  [key: string]: unknown
}

/** Documented create-inventory body (excluded from standard plan â€” gated only). */
export interface TelnaCreateInventoryRequest {
  name: string
  company_id: number
  type?: string
  [key: string]: unknown
}

/** Documented update-inventory body (excluded from standard plan â€” gated only). */
export interface TelnaUpdateInventoryRequest {
  name?: string
  type?: string
  [key: string]: unknown
}

// â”€â”€ Wallet / package mutation bodies â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** PATCH /v2.1/pcr/wallets/{wallet_id} â€” mapped, provider method available, NOT a normal OneSIM capability. */
export interface TelnaWalletPatchRequest {
  name?: string
  minimum_balance?: number
  maximum_balance?: number
  [key: string]: unknown
}

/** PUT /v2.1/pcr/packages/{package_id} â€” provider method exists; no OneSIM lifecycle clearly maps. */
export interface TelnaPackageUpdateRequest {
  package_template?: number
  time_allowance?: number
  [key: string]: unknown
}
