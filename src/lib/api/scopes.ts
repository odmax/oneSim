// ─────────────────────────────────────────────
// API Key Scopes + fail-closed V1 route policy
// ─────────────────────────────────────────────

export const API_SCOPES = {
  'packages:read': 'List and view available eSIM packages',
  'quotes:write': 'RESERVED — create purchase quotes (no Business V1 route currently; kept for future quote endpoints)',
  'orders:read': 'View orders and order status',
  'orders:write': 'Create and manage orders',
  'esims:read': 'View eSIM details and usage',
  'esims:write': 'Refresh status, share, and manage eSIMs',
  'wallet:read': 'View wallet balance and transactions',
  'customers:read': 'List and view customers',
  'customers:write': 'Create and update customers',
  'webhooks:read': 'View webhook endpoints and delivery history',
  'webhooks:write': 'Create, update, test and delete webhook endpoints',
} as const

/**
 * Scopes that are declared but mapped to no current Business V1 route.
 * They are intentionally RESERVED (not dead): a future matching endpoint must
 * reference them, and the route totality test will require the new route to be
 * added to ROUTE_SCOPE_MAP. Keeping the label contract explicit prevents silent
 * scope drift.
 */
export const RESERVED_SCOPES: ApiScope[] = ['quotes:write']

export type ApiScope = keyof typeof API_SCOPES

export const ALL_SCOPES = Object.keys(API_SCOPES) as ApiScope[]

// ─────────────────────────────────────────────
// Scope granularity
// ─────────────────────────────────────────────
/**
 * Documented meaning of each action authorized by `esims:write`, so it cannot
 * silently grow. Adding a new esim-* mutating Business V1 endpoint must go
 * through review here (or be assigned a dedicated scope when the product
 * architecture warrants finer granularity — it does not today).
 */
export const ESIMS_WRITE_ACTIONS = [
  'POST /api/v1/esims/[id]/refresh-status',
  'POST /api/v1/esims/[id]/refresh-qr',
  'POST /api/v1/esims/[id]/top-up',
  'POST /api/v1/esims/[id]/share',
] as const

// ─────────────────────────────────────────────
// Route-to-scope mapping (fail-closed)
// ─────────────────────────────────────────────

export const ROUTE_SCOPE_MAP: Record<string, ApiScope[]> = {
  'GET /api/v1/packages': ['packages:read'],
  'POST /api/v1/esims/order': ['orders:write'],
  'GET /api/v1/orders': ['orders:read'], 'GET /api/v1/orders/[id]': ['orders:read'],
  'GET /api/v1/esims/[id]': ['esims:read'],
  'POST /api/v1/esims/[id]/refresh-status': ['esims:write'],
  'POST /api/v1/esims/[id]/refresh-qr': ['esims:write'],
  'POST /api/v1/esims/[id]/top-up': ['esims:write'],
  'POST /api/v1/esims/[id]/share': ['esims:write'],
  'GET /api/v1/esims/[id]/usage': ['esims:read'],
  'GET /api/v1/usage': ['esims:read'],
  'GET /api/v1/wallet': ['wallet:read'], 'GET /api/v1/wallet/transactions': ['wallet:read'],
  'GET /api/v1/customers': ['customers:read'], 'POST /api/v1/customers': ['customers:write'],
  'GET /api/v1/customers/[id]': ['customers:read'], 'PATCH /api/v1/customers/[id]': ['customers:write'],
  'GET /api/v1/webhooks': ['webhooks:read'], 'POST /api/v1/webhooks': ['webhooks:write'],
  'GET /api/v1/webhooks/[id]': ['webhooks:read'], 'PATCH /api/v1/webhooks/[id]': ['webhooks:write'],
  'DELETE /api/v1/webhooks/[id]': ['webhooks:write'],
  'POST /api/v1/webhooks/[id]/test': ['webhooks:write'],
  'GET /api/v1/webhooks/[id]/deliveries': ['webhooks:read'],
  'POST /api/v1/webhooks/deliveries/[id]/retry': ['webhooks:write'],
}

/**
 * Explicitly scope-protected routes.
 * Derived from ROUTE_SCOPE_MAP at runtime so a route added to both keeps them
 * in sync. A requirement that a future route is mapped is enforced by the route
 * totality test (see assertKnownV1ScopePolicy).
 */
export const PROTECTED_V1_ROUTES = Object.keys(ROUTE_SCOPE_MAP)

/**
 * Explicitly EXEMPT bootstrap/public V1 routes — intentionally require NO
 * business scope (and, for the static service banner, no authentication).
 * Every route here must be deliberate; anything not listed in either
 * ROUTE_SCOPE_MAP or V1_BOOTSTRAP_ROUTES is a policy gap that fails closed.
 */
export const V1_BOOTSTRAP_ROUTES: Record<string, 'AUTH' | 'PUBLIC'> = {
  // Returns the OneSIM external API service banner; has no business payload.
  'GET /api/v1/esims/order': 'PUBLIC',
  // Verifies the caller's API key and echoes businessId — authenticated but
  // requires no additional business scope.
  'GET /api/v1/auth/verify': 'AUTH',
}

/** Every V1 route must be either PROTECTED or explicitly BOOTSTRAP/EXEMPT. */
export const TOTAL_V1_POLICY = {
  ...Object.fromEntries(PROTECTED_V1_ROUTES.map(k => [k, 'PROTECTED'] as [string, string])),
  ...V1_BOOTSTRAP_ROUTES,
} as Record<string, string>

/**
 * Convert a ROUTE_SCOPE_MAP / policy key path containing `[param]` into a RegExp
 * over the real incoming pathname.
 */
export function routeKeyToRegex(keyPath: string): RegExp {
  return new RegExp(`^${keyPath.replace(/\[[^\]]+\]/g, '[^/]+')}$`)
}

export type V1RouteClassification =
  | { kind: 'PROTECTED'; scopes: ApiScope[] }
  | { kind: 'BOOTSTRAP'; auth: 'AUTH' | 'PUBLIC' }
  | { kind: 'UNREGISTERED' }

/**
 * Classify a Business V1 route against the canonical scope registry.
 *
 * FAIL-CLOSED: a `/api/v1/*` route that is neither protected (in ROUTE_SCOPE_MAP)
 * nor explicitly bootstrap-exempt (in V1_BOOTSTRAP_ROUTES) is classified
 * UNREGISTERED. The caller MUST treat UNREGISTERED as a hard failure — never as
 * an implicit all-access fallback. A future route added without a policy will
 * therefore be rejected, and the route totality test fails.
 */
export function classifyV1Route(method: string, path: string): V1RouteClassification {
  const normalizedMethod = (method || 'GET').toUpperCase()
  const pathname = String(path).split('?')[0]

  const bootstrapMatch = Object.entries(V1_BOOTSTRAP_ROUTES).find(([key]) => {
    const [keyMethod, keyPath] = key.split(' ')
    if (keyMethod !== normalizedMethod) return false
    return routeKeyToRegex(keyPath).test(pathname)
  })
  if (bootstrapMatch) {
    return { kind: 'BOOTSTRAP', auth: bootstrapMatch[1] }
  }

  const protectedMatch = Object.entries(ROUTE_SCOPE_MAP).find(([key]) => {
    const [keyMethod, keyPath] = key.split(' ')
    if (keyMethod !== normalizedMethod) return false
    return routeKeyToRegex(keyPath).test(pathname)
  })
  if (protectedMatch) return { kind: 'PROTECTED', scopes: protectedMatch[1] }

  // Any /api/v1 path that reaches here is a policy gap → fail closed.
  if (pathname.startsWith('/api/v1')) {
    return { kind: 'UNREGISTERED' }
  }
  // Non-business paths (e.g. /api/providers/webhooks/*) are outside this policy.
  return { kind: 'UNREGISTERED' }
}

/**
 * Look up the scopes required for a Business API route (method + path).
 * Returns [] for bootstrap routes and UNREGISTERED routes — callers must use
 * classifyV1Route / requireRouteScopes, NOT this, to enforce fail-closed.
 */
export function scopesForRoute(method: string, path: string): ApiScope[] {
  const classified = classifyV1Route(method, path)
  return classified.kind === 'PROTECTED' ? classified.scopes : []
}

/**
 * Assert that a Business V1 route has a known scope policy.
 * Throws (fail-closed) when a /api/v1 route is neither protected nor explicitly
 * exempt. Used by the route totality test AND defensively at request time.
 */
export function assertKnownV1ScopePolicy(method: string, path: string): void {
  const classified = classifyV1Route(method, path)
  if (classified.kind === 'UNREGISTERED') {
    throw new Error(`No API scope policy registered for Business route ${method.toUpperCase()} ${String(path).split('?')[0]}. Every /api/v1 route must be in ROUTE_SCOPE_MAP or explicitly exempt in V1_BOOTSTRAP_ROUTES.`)
  }
}

/** True when the route has a registered policy (protected or bootstrap-exempt). */
export function isKnownV1Route(method: string, path: string): boolean {
  const classified = classifyV1Route(method, path)
  return classified.kind !== 'UNREGISTERED'
}

/**
 * Check whether a key's scopes satisfy the required route scopes.
 * Legacy keys with empty scopes array get full access during migration.
 */
export function hasScope(keyScopes: ApiScope[] | undefined | null, requiredScopes: ApiScope[]): boolean {
  if (!requiredScopes.length) return true
  if (!keyScopes || !keyScopes.length) return true // legacy key — full access during migration
  return requiredScopes.every(s => keyScopes.includes(s))
}