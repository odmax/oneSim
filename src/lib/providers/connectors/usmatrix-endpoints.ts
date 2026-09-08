/**
 * US-Matrix eSIM API — Client Integration (OpenAPI 3.0, version 1.0.0).
 *
 * Official Swagger UI: https://api-esim.usmatrix.com/api/v1/docs-to-client/
 *
 * BASE URL COMPOSITION (canonical):
 *   Canonical host    : https://api-esim.usmatrix.com
 *   Documented paths  : /api/v1/...
 *
 * OneSIM stores `apiBaseUrl` and composes paths via `buildUsMatrixUrl` so a
 * base configured either as the host-only root OR as a versioned base
 * (…/api/v1) composes to the SAME final URL — never /api/v1/api/v1.
 *
 * AUTH (LOGIN_TOKEN runtime exchange):
 *   POST /api/v1/whitelist/signin  { email, password } → { token }
 *   Subsequent requests: Authorization: Bearer <token>
 *   No expiry field is documented → supportsRefresh=false, no expiry handling.
 *
 * READ-ONLY verification after login:
 *   GET /api/v1/clients/current
 *
 * Only documented read operations are implemented on the connector:
 *   GET /api/v1/clients/current      (connection verification)
 *   GET /api/v1/packages             (catalog discovery)
 *   GET /api/v1/esims                (eSIM inventory; EsimDTO carries
 *                                     smDpAddress + activationCode + qrcodeString)
 *
 * Mutating operations (signin is auth, not a provider mutation) are declared in
 * the endpoint map below for path-accuracy but are NOT wired:
 *   POST /esims/add-esims, POST /esims/assign-package, POST /esims/qrcode
 *   (flag-update only — never a QR generator), PUT /esims/suspend|unsuspend,
 *   PATCH /esims/transfer, POST /packages, PUT /packages/suspend|unsuspend,
 *   client create/update/delete, etc.
 */

export const USMATRIX_ENDPOINTS = {
  // Auth (login exchange — the documented auth operation).
  signin: '/api/v1/whitelist/signin',

  // Clients — read-only identity used for post-auth verification.
  currentClient: '/api/v1/clients/current',
  clients: '/api/v1/clients',

  // Packages — catalog discovery (read-only) + documented helpers.
  packages: '/api/v1/packages',
  packageUsage: '/api/v1/packages/usage',
  packageClone: '/api/v1/packages/clone/{package_id}',
  packageMetrics: '/api/v1/packages/metrics',

  // eSIMs — inventory / profiles / info (read-only) + lifecycle.
  esims: '/api/v1/esims',
  esimInfo: '/api/v1/esims/info',
  esimProfiles: '/api/v1/esims/profiles',
  esimMobileDetail: '/api/v1/esims/mobile-detail/{esim_id}',
  esimMetrics: '/api/v1/esims/metrics',
  esimFindPackages: '/api/v1/esims/find-packages',
  esimAddEsims: '/api/v1/esims/add-esims',
  esimAssignPackage: '/api/v1/esims/assign-package',
  esimAvailabilityCount: '/api/v1/esims/availability-count',
  esimAvailabilityCountForPackage: '/api/v1/esims/availability-count/{package_id}',
  esimAvailableForPackage: '/api/v1/esims/available-for-package/{package_id}',
  esimSuspend: '/api/v1/esims/suspend',
  esimUnsuspend: '/api/v1/esims/unsuspend',
  esimRemovePackages: '/api/v1/esims/remove-packages',
  esimTransfer: '/api/v1/esims/transfer',
  esimQrcode: '/api/v1/esims/qrcode',
  // Network telemetry (read-only, per-eSIM evidence).
  esimEventLogs: '/api/v1/esims/event-logs',
  esimLocationEventLogs: '/api/v1/esims/location-event-logs',
  esimRawLocation: '/api/v1/esims/raw-location',

  // Dashboard (read-only, diagnostic).
  dashboard: '/api/v1/dashboard',
  dashboardMetrics: '/api/v1/dashboard/metrics',

  // Countries (read-only coverage).
  countries: '/api/v1/countries',
} as const

export type UsMatrixEndpoint = keyof typeof USMATRIX_ENDPOINTS

/**
 * Single source of truth for a US-Matrix endpoint PATH (relative). Every
 * US-Matrix request resolves its path through this getter.
 */
export function usMatrixEndpointPath(endpoint: UsMatrixEndpoint): string {
  return USMATRIX_ENDPOINTS[endpoint]
}

/**
 * Normalizes the configured base URL. The documented canonical host is
 * https://api-esim.usmatrix.com and paths are /api/v1/...; a base configured
 * with a trailing version segment (…/api/v1) is normalized so paths never
 * duplicate the prefix. Handles trailing slashes.
 */
export function normalizeUsMatrixBaseUrl(base: string): string {
  const cleaned = String(base || '').replace(/\/+$/, '')
  return cleaned.replace(/\/api\/v\d+$/i, '')
}

/**
 * Compose the absolute US-Matrix URL for an endpoint, preserving any path
 * prefix the configured apiBaseUrl already carries (never duplicated) and
 * tolerating a trailing slash on the base URL. Path parameters are substituted
 * last. Query parameters are appended by the caller.
 */
export function buildUsMatrixUrl(
  apiBaseUrl: string,
  endpoint: UsMatrixEndpoint,
  pathParams?: Record<string, string | number>,
): string {
  const base = normalizeUsMatrixBaseUrl(apiBaseUrl)
  let path: string = USMATRIX_ENDPOINTS[endpoint]
  if (pathParams) {
    for (const [key, value] of Object.entries(pathParams)) {
      path = path.replace(`{${key}}`, String(value))
    }
  }
  return `${base}${path}`
}

// ── Documented DTO shapes (from the official OpenAPI spec) ────────────────

/** POST /api/v1/whitelist/signin request — the ONLY documented signin fields. */
export interface UsMatrixSigninRequest {
  email: string
  password: string
}

/** POST /api/v1/whitelist/signin response — only field is `token`. No expiry. */
export interface UsMatrixSigninResponse {
  token: string
}

/** Generic paginated list envelope (data + meta). */
export interface UsMatrixPaginated<T> {
  data: T[]
  meta: {
    itemsPerPage: number
    totalItems: number
    currentPage: number
    totalPages: number
  }
}

/** Package item shape (CreatePackageResponseDTO; also returned by GET /packages). */
export interface UsMatrixPackage {
  id: string
  name: string
  code?: string
  /** Price in USD (spec has no currency field). */
  price?: number
  /** Data limit in GB. */
  dataLimit?: number
  limit?: number
  limitType?: string
  status?: 'standBy' | 'live' | 'expired' | string
  active?: boolean
  start?: string
  end?: string
  countries?: Array<{ id?: string; name?: string; iso3?: string }>
  createdAt?: string
  updatedAt?: string
}

/** eSIM inventory item (EsimDTO). */
export interface UsMatrixEsim {
  id: string
  iccid: string
  smDpAddress: string | null
  activationCode: string | null
  qrcodeString: string | null
  status: 'free' | 'assigned' | 'suspended' | string
  createdAt?: string
  updatedAt?: string
}

/**
 * GET /api/v1/esims query contract — documented Swagger filters.
 *
 * `allocated` is REQUIRED by the live provider (HTTP 400 without it):
 * "Show assigned/unassigned eSIMs". The two boolean values are intentionally
 * NOT mapped to OneSIM semantics (this code makes no claim that `true` means
 * "assigned" versus "unassigned"); callers pass the exact value they want and
 * `false` is preserved (never dropped through truthiness checks).
 *
 * `ids` is documented as "Filter by specific eSIM IDs"; it is serialized as a
 * single deterministic comma-joined query parameter (ids=a,b,c) matching the
 * documented multi-value filter representation.
 *
 * Pagination is `limit` + `offset` (NOT page/perPage).
 * `allocated` must be an explicit boolean; absence is rejected before transport.
 */
export interface UsMatrixEsimsQuery {
  /** REQUIRED. The exact boolean filter value to send (false preserved). */
  allocated: boolean
  /** Filter by vendor profile. */
  profile?: string
  /** Filter by specific eSIM IDs (comma-joined, deterministic). */
  ids?: string[]
  /** Filter by package assignment status. */
  hasPackage?: boolean
  /** Search by ICCID. */
  iccid?: string
  /** Filter by client name. */
  client?: string
  /** Filter by activation date. */
  activationDate?: string
  /** Filter by last update date. */
  updatedAt?: string
  /** Filter by eSIM status. */
  status?: string
  /** Filter by data limit. */
  dataLimit?: number
  /** Filter by package name. */
  packageName?: string
  /** Pagination limit (bounded conservatively before transport). */
  limit?: number
  /** Pagination offset. */
  offset?: number
}

/** Default and maximum page size for GET /esims (bound limit conservatively). */
export const DEFAULT_ESIMS_PAGE_SIZE = 100
export const MAX_ESIMS_PAGE_SIZE = 200

/**
 * POST /api/v1/esims/find-packages request body — documented
 * FindPackagesForEsimsRequestDTO. `esims` is the REQUIRED array of provider
 * eSIM UUIDs to find compatible packages for. NEVER a local OneSIM id.
 */
export interface FindPackagesForEsimsRequestDTO {
  esims: string[]
}

/**
 * POST /api/v1/esims/find-packages query parameters. Only the documented
 * query params are supported; the method is a READ-ONLY discovery operation
 * (POST transport only). Pagination uses page/perPage per the provider
 * contract, with a conservative bounded maximum applied before transport.
 */
export interface FindPackagesForEsimsQuery {
  /** Optional search filter. */
  search?: string
  /** Page number (1-based; bounded). */
  page?: number
  /** Items per page (bounded conservatively; provider allows up to 10000 but OneSIM caps). */
  perPage?: number
  /** Optional order-by field. */
  orderBy?: string
  /** Optional sort direction (default asc). */
  orderDirection?: 'asc' | 'desc'
  /** Filter packages by end year (YYYY). */
  end?: string
}

/** Conservative page size bounds for POST /esims/find-packages. */
export const DEFAULT_FIND_PACKAGES_PAGE_SIZE = 25
export const MAX_FIND_PACKAGES_PAGE_SIZE = 100

/** Conservative maximum provider eSIM UUIDs accepted per find-packages request. */
export const MAX_FIND_PACKAGES_ESIM_IDS = 20

/**
 * POST /api/v1/esims/find-packages response envelope. The provider Swagger
 * example is structurally unusual (a top-level array wrapping a single
 * `{ data, meta }` object, with `data` entries potentially null). The parser
 * is conservative: it tolerates the documented paginated envelope and a bare
 * array, and treats HTTP 204 as an authoritative empty success. It DOES NOT
 * invent a strict per-item DTO beyond the existing UsMatrixPackage.
 */
export interface FindPackagesForEsimsEnvelope {
  data?: UsMatrixPackage[] | null
  meta?: {
    itemsPerPage?: number
    totalItems?: number
    currentPage?: number
    totalPages?: number
  }
}

/**
 * POST /api/v1/esims/assign-package request — documented AssignPackageRequestDTO.
 * `package` (required) is the US-Matrix package UUID; `client` (optional) is the
 * client UUID for whitelisted backend integrations. NEVER a local OneSIM id.
 */
export interface AssignPackageRequestDTO {
  package: string
  client?: string
}

/**
 * POST /api/v1/esims/assign-package response — documented AssignPackageResponseDTO
 * (all fields required; smDpAddress/activationCode/qrcodeString/profile nullable).
 * Success status is 201.
 */
export interface AssignPackageResponseDTO {
  id: string
  iccid: string
  smDpAddress: string | null
  activationCode: string | null
  qrcodeString: string | null
  profile: string | null
}

/**
 * POST /api/v1/esims/add-esims request — documented AddEsimInPackagesRequestDTO.
 *
 * The provider explicitly documents a CARTESIAN PRODUCT: every eSIM in
 * `esims` is associated with every package in `packages`
 * (unique esims × unique packages associations).
 *
 * `esims`   : REQUIRED array of eSIM UUIDs to assign packages to.
 *             All eSIMs must be active and accessible by the authenticated user.
 * `packages`: REQUIRED array of package UUIDs to assign to the eSIMs. All
 *             packages must be within their validity period (start to end dates).
 * `client`  : OPTIONAL client UUID for additional permission validation; the
 *             provider verifies the eSIMs belong to this client.
 *
 * NEVER a local OneSIM id. Do NOT add undocumented fields.
 */
export interface AddEsimInPackagesRequestDTO {
  esims: string[]
  packages: string[]
  client?: string
}

/**
 * Conservative envelope for POST /api/v1/esims/add-esims.
 *
 * The provider has NOT supplied an exact response schema for add-esims.
 * Per the integration contract, we do NOT fabricate a strict response DTO.
 * This type is a defensive provider-envelope parser: HTTP 2xx means the
 * association request was ACCEPTED (associations created / queued), NOT proof
 * that any asynchronous vendor dispatch completed. Unknown fields are ignored;
 * success is never inferred from arbitrary JSON contents.
 */
export interface AddEsimInPackagesResponseEnvelope {
  success?: boolean
  errmsg?: string
  data?: unknown
  [key: string]: unknown
}

/**
 * OneSIM-side conservative ceiling for a single add-esims operation, expressed
 * as the Cartesian association count (unique esims × unique packages).
 * This is OPERATOR PROTECTION, not a provider-documented maximum. The admin
 * layer must require explicit confirmation (echo of the count) for operations
 * above the default; the connector refuses to dispatch above the enforced
 * ceiling unless a caller explicitly raises it via a bounded override.
 */
export const DEFAULT_MAX_ADD_ESIMS_ASSOCIATIONS = 25

/**
 * Absolute OneSIM-side hard cap for a single add-esims operation. Changes the
 * default ceiling alone can only be lifted by an explicit per-call override up
 * to — never beyond — this absolute safe bound. This is OneSIM operator
 * protection (a silently-huge Cartesian product must never run), NOT a claim
 * that USMatrix documents any maximum.
 */
export const ABSOLUTE_MAX_ADD_ESIMS_ASSOCIATIONS = 200

/**
 * POST /api/v1/packages/usage request — documented GetPackageUsageRequestDTO.
 * `packageEsimId` is the package-eSIM association UUID (NOT the package id, NOT
 * a local OneSIM id, NOT an ICCID).
 */
export interface GetPackageUsageRequestDTO {
  packageEsimId: string
}

/** POST /api/v1/packages/usage response — documented GetPackageUsageResponseDTO. */
export interface GetPackageUsageResponseDTO {
  success: boolean
  errmsg: string
  package: PackageDetailDTO
}

/** Documented PackageDetailDTO. */
export interface PackageDetailDTO {
  package_status: string
  status: string
  rate_groups: RateGroupDTO[]
}

/** Documented RateGroupDTO (allowance/usage normalized to the quantity type). */
export interface RateGroupDTO {
  rate_group_id: string
  rate_group_allowance: number
  rate_group_allow_qtyp: string
  rate_group_usage: number
  rate_group_total_qty: number
  rate_group_throttle_usage: number
  rate_group_throttle_qtyp: string
  rate_group_starttime: string
  rate_group_expire: string
  rate_group_days_used: number
}

/**
 * PUT /api/v1/esims/suspend request — documented SuspendEsimRequestDTO.
 * `esims` accepts eSIM UUIDs OR ICCIDs. Same shape as UnsuspendEsimRequestDTO.
 */
export interface SuspendEsimRequestDTO {
  esims: string[]
}

/** PUT /api/v1/esims/unsuspend request — documented UnsuspendEsimRequestDTO. */
export interface UnsuspendEsimRequestDTO {
  esims: string[]
}

/**
 * DELETE /api/v1/esims/remove-packages request — documented
 * RemoveEsimFromPackageRequestDTO. Exactly one of packageEsimIds / combinations /
 * (esims+packages) must be provided. packageEsimIds is the RECOMMENDED method.
 */
export interface RemoveEsimFromPackageRequestDTO {
  packageEsimIds?: string[]
  combinations?: Array<{ esimId: string; packageId: string }>
  esims?: string[]
  packages?: string[]
}

/** POST /api/v1/esims/availability-count request — documented AvailabilityCountRequestDTO. */
export interface AvailabilityCountRequestDTO {
  packageIds: string[]
  clientId?: string
}

/** POST /api/v1/esims/availability-count response — { counts: { [packageId]: number } }. */
export interface AvailabilityCountResponseDTO {
  counts: Record<string, number>
}

/**
 * Canonical US-Matrix package inventory status (read-only, derived from the
 * authoritative availability-count read endpoint). Provider-generic — every
 * US-Matrix package uses the same status vocabulary; NO package/country/plan
 * is special-cased.
 *
 *  - AVAILABLE    : the availability endpoint returned an authoritative count > 0
 *  - OUT_OF_STOCK : the availability endpoint returned an authoritative count === 0
 *  - UNKNOWN      : the availability endpoint failed / timed out / returned a
 *                   malformed response — NEVER converted to OUT_OF_STOCK (a
 *                   provider/API error must not fabricate zero inventory).
 *
 * `PREPARING` / `ERROR` are reserved for a future administrative inventory
 * preparation operation; they are NOT derivable from the current documented
 * read-only endpoints and are therefore never produced by the connector.
 */
export type UsMatrixPackageInventoryStatus = 'AVAILABLE' | 'OUT_OF_STOCK' | 'UNKNOWN'

/** Result of a read-only per-package inventory status look (US-Matrix). */
export interface PackageInventoryStatusResult {
  /** US-Matrix provider package UUID (never a local OneSIM id). */
  packageId: string
  status: UsMatrixPackageInventoryStatus
  /** Authoritative assignable eSIM count when the endpoint returned one. */
  count?: number
  /** UNKNOWN reason (endpoint failure / timeout / malformed response). */
  reason?: string
  /** ISO timestamp of the read (the check is instantaneous). */
  checkedAt: string
}

/** CountryDTO (GET /api/v1/countries). */
export interface CountryDTO {
  id: string
  name: string
  region: string
  iso3: string
  imagePath?: string | null
  createdAt?: string
  updatedAt?: string
}

/** ListCountriesResponseDTO (GET /api/v1/countries). */
export interface ListCountriesResponseDTO {
  data: CountryDTO[]
  count: number
}

/**
 * POST /api/v1/esims/info request — documented GetEsimInfoRequestDTO.
 * `esimId` is the US-Matrix provider eSIM UUID (from AssignPackageResponseDTO.id /
 * providerActivationId). Never a local OneSIM id.
 */
export interface GetEsimInfoRequestDTO {
  esimId: string
}

/** POST /api/v1/esims/info response — documented GetEsimInfoResponseDTO. */
export interface GetEsimInfoResponseDTO {
  activationProfile: ActivationProfileDTO
  profileLogs: ProfileLogDTO[]
}

/** Documented ActivationProfileDTO (vendor profile state). */
export interface ActivationProfileDTO {
  iccid?: string | null
  eid?: string | null
  imsi?: string | null
  status?: string | null
}

/** Documented ProfileLogDTO. */
export interface ProfileLogDTO {
  status?: string | null
  type?: string | null
  eventName?: string | null
  createdAt?: string | null
  result?: string | null
  state?: string | null
}

/**
 * POST /api/v1/esims/location-event-logs request — documented LocationLogsRequestDTO.
 * The exact documented shape is per the current Swagger; keep it minimal and
 * provider-scoped (the eSIM UUID or ICCID) — never a local OneSIM id.
 */
export interface LocationLogsRequestDTO {
  esimId?: string
  iccid?: string
  page?: number
  pageSize?: number
}

/** A network/location event entry (documented event-logs / location-event-logs). */
export interface NetworkEventLogDTO {
  event_time?: string | null
  request_type?: string | null
  request_status?: string | null
  imsi?: string | null
  iccid?: string | null
  serving_network?: string | null
  network_type?: string | null
  country_network?: string | null
  apn?: string | null
  volume_used?: number | null
}

/**
 * A package↔eSIM association from mobile-detail.
 *
 * `id` is the packageEsimId — the association UUID accepted by POST
 * /packages/usage. `package.id` is the separate package UUID and must NEVER be
 * used as the association identifier. Proven by live staging evidence.
 */
export interface MobileDetailPackageEsimDTO {
  id: string
  status?: string
  usageValue?: number
  package?: {
    id?: string
    name?: string
    dataLimit?: number
    dataType?: string
    limit?: number
    limitType?: string
  }
}


