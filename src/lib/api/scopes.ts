// ─────────────────────────────────────────────
// API Key Scopes
// ─────────────────────────────────────────────

export const API_SCOPES = {
  'packages:read': 'List and view available eSIM packages',
  'quotes:write': 'Create purchase quotes',
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

export type ApiScope = keyof typeof API_SCOPES

export const ALL_SCOPES = Object.keys(API_SCOPES) as ApiScope[]

// ─────────────────────────────────────────────
// Route-to-scope mapping
// ─────────────────────────────────────────────

export const ROUTE_SCOPE_MAP: Record<string, ApiScope[]> = {
  'GET /api/v1/packages': ['packages:read'],
  'GET /api/v1/esims/order': ['orders:read'],
  'POST /api/v1/esims/order': ['orders:write'],
  'GET /api/v1/orders': ['orders:read'], 'GET /api/v1/orders/[id]': ['orders:read'],
  'GET /api/v1/esims/[id]': ['esims:read'],
  'POST /api/v1/esims/[id]/refresh-status': ['esims:write'],
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
  'GET /api/v1/auth/verify': [],
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
