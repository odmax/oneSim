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

  // Packages — catalog discovery (read-only).
  packages: '/api/v1/packages',
  packageClone: '/api/v1/packages/clone/{package_id}',

  // eSIMs — inventory / profiles / info (read-only).
  esims: '/api/v1/esims',
  esimInfo: '/api/v1/esims/info',
  esimProfiles: '/api/v1/esims/profiles',
  esimMobileDetail: '/api/v1/esims/mobile-detail/{esim_id}',
  availableForPackage: '/api/v1/esims/available-for-package/{package_id}',
  availabilityCount: '/api/v1/esims/availability-count',

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
