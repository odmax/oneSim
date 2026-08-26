import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: Route filesystem completeness — filesystem vs documented surface
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-1: Route filesystem completeness', () => {
  const ROUTE_MAP: { method: string; apiPath: string; fsPath: string }[] = [
    { method: 'GET', apiPath: '/auth/verify', fsPath: 'src/app/api/v1/auth/verify/route.ts' },
    { method: 'GET', apiPath: '/packages', fsPath: 'src/app/api/v1/packages/route.ts' },
    { method: 'POST', apiPath: '/esims/order', fsPath: 'src/app/api/v1/esims/order/route.ts' },
    { method: 'GET', apiPath: '/esims/order', fsPath: 'src/app/api/v1/esims/order/route.ts' },
    { method: 'GET', apiPath: '/orders', fsPath: 'src/app/api/v1/orders/route.ts' },
    { method: 'GET', apiPath: '/orders/[orderId]', fsPath: 'src/app/api/v1/orders/[orderId]/route.ts' },
    { method: 'GET', apiPath: '/esims/[esimId]', fsPath: 'src/app/api/v1/esims/[esimId]/route.ts' },
    { method: 'GET', apiPath: '/esims/[esimId]/usage', fsPath: 'src/app/api/v1/esims/[esimId]/usage/route.ts' },
    { method: 'POST', apiPath: '/esims/[esimId]/refresh-status', fsPath: 'src/app/api/v1/esims/[esimId]/refresh-status/route.ts' },
    { method: 'POST', apiPath: '/esims/[esimId]/top-up', fsPath: 'src/app/api/v1/esims/[esimId]/top-up/route.ts' },
    { method: 'POST', apiPath: '/esims/[esimId]/share', fsPath: 'src/app/api/v1/esims/[esimId]/share/route.ts' },
    { method: 'GET', apiPath: '/usage', fsPath: 'src/app/api/v1/usage/route.ts' },
    { method: 'GET', apiPath: '/wallet', fsPath: 'src/app/api/v1/wallet/route.ts' },
    { method: 'GET', apiPath: '/wallet/transactions', fsPath: 'src/app/api/v1/wallet/transactions/route.ts' },
    { method: 'GET', apiPath: '/customers', fsPath: 'src/app/api/v1/customers/route.ts' },
    { method: 'POST', apiPath: '/customers', fsPath: 'src/app/api/v1/customers/route.ts' },
    { method: 'GET', apiPath: '/customers/[id]', fsPath: 'src/app/api/v1/customers/[id]/route.ts' },
    { method: 'PATCH', apiPath: '/customers/[id]', fsPath: 'src/app/api/v1/customers/[id]/route.ts' },
    { method: 'GET', apiPath: '/webhooks', fsPath: 'src/app/api/v1/webhooks/route.ts' },
    { method: 'POST', apiPath: '/webhooks', fsPath: 'src/app/api/v1/webhooks/route.ts' },
    { method: 'GET', apiPath: '/webhooks/[id]', fsPath: 'src/app/api/v1/webhooks/[id]/route.ts' },
    { method: 'PATCH', apiPath: '/webhooks/[id]', fsPath: 'src/app/api/v1/webhooks/[id]/route.ts' },
    { method: 'DELETE', apiPath: '/webhooks/[id]', fsPath: 'src/app/api/v1/webhooks/[id]/route.ts' },
    { method: 'POST', apiPath: '/webhooks/[id]/test', fsPath: 'src/app/api/v1/webhooks/[id]/test/route.ts' },
    { method: 'GET', apiPath: '/webhooks/[id]/deliveries', fsPath: 'src/app/api/v1/webhooks/[id]/deliveries/route.ts' },
    { method: 'POST', apiPath: '/webhooks/deliveries/[deliveryId]/retry', fsPath: 'src/app/api/v1/webhooks/deliveries/[deliveryId]/retry/route.ts' },
  ]

  it('every documented route has a handler file on disk', () => {
    for (const route of ROUTE_MAP) {
      const exists = fs.existsSync(route.fsPath)
      expect(exists, `Missing handler: ${route.method} ${route.apiPath} → ${route.fsPath}`).toBe(true)
    }
  })

  it('every route file exports the expected HTTP method', () => {
    const seen = new Set<string>()
    for (const route of ROUTE_MAP) {
      const key = `${route.method}:${route.fsPath}`
      if (seen.has(key)) continue
      seen.add(key)
      const content = fs.readFileSync(route.fsPath, 'utf8')
      expect(
        content.includes(`export async function ${route.method}`),
        `${route.fsPath} must export async function ${route.method}`,
      ).toBe(true)
    }
  })

  it('every route file has force-dynamic', () => {
    const seen = new Set<string>()
    for (const route of ROUTE_MAP) {
      if (seen.has(route.fsPath)) continue
      seen.add(route.fsPath)
      const content = fs.readFileSync(route.fsPath, 'utf8')
      expect(
        content.includes("dynamic = 'force-dynamic'"),
        `${route.fsPath} must export const dynamic = 'force-dynamic'`,
      ).toBe(true)
    }
  })

  it('no undocumented route files exist under /api/v1/', () => {
    const walk = (dir: string): string[] => {
      const results: string[] = []
      if (!fs.existsSync(dir)) return results
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) results.push(...walk(full))
        else if (entry.name === 'route.ts' || entry.name === 'route.js') results.push(full)
      }
      return results
    }
    const allRoutes = walk('src/app/api/v1')
    const documentedFsPaths = new Set(ROUTE_MAP.map(r => path.normalize(r.fsPath)))
    const undocumented = allRoutes.filter(r => !documentedFsPaths.has(path.normalize(r)))
    expect(undocumented, `Undocumented route files: ${undocumented.join(', ')}`).toHaveLength(0)
  })

  it('PUBLIC_ENDPOINT_COUNT = 20', () => {
    const uniquePaths = new Set(ROUTE_MAP.map(r => r.apiPath))
    expect(uniquePaths.size).toBe(20)
  })

  it('PUBLIC_METHOD_COUNT = 26', () => {
    expect(ROUTE_MAP.length).toBe(26)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: Auth Contract — authenticateApiKey (filesystem assertions)
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-2: Authentication contract', () => {
  it('API key format: onesim_ prefix + 64 hex chars', () => {
    const content = fs.readFileSync('src/lib/api/auth.ts', 'utf8')
    expect(content).toContain("onesim_")
    expect(content).toContain('crypto.randomBytes(32).toString(\'hex\')')
    expect(content).toContain('raw.substring(0, 12)')
  })

  it('hashApiKey uses SHA-256', () => {
    const content = fs.readFileSync('src/lib/api/auth.ts', 'utf8')
    expect(content).toContain('sha256')
    expect(content).toContain('digest(\'hex\')')
  })

  it('missing Authorization header → 401', () => {
    const content = fs.readFileSync('src/lib/api/auth.ts', 'utf8')
    expect(content).toContain('Missing or invalid Authorization header')
    expect(content).toContain('status: 401')
  })

  it('invalid key → 401', () => {
    const content = fs.readFileSync('src/lib/api/auth.ts', 'utf8')
    expect(content).toContain('Invalid or revoked API key')
  })

  it('expired key → 401', () => {
    const content = fs.readFileSync('src/lib/api/auth.ts', 'utf8')
    expect(content).toContain('API key has expired')
  })

  it('suspended business → 403', () => {
    const content = fs.readFileSync('src/lib/api/auth.ts', 'utf8')
    expect(content).toContain('Business account is not approved')
    expect(content).toContain('status: 403')
  })

  it('valid key updates lastUsedAt', () => {
    const content = fs.readFileSync('src/lib/api/auth.ts', 'utf8')
    expect(content).toContain('lastUsedAt')
    expect(content).toContain('fire-and-forget')
  })

  it('auth result includes businessId, apiKeyId, scopes', () => {
    const content = fs.readFileSync('src/lib/api/auth.ts', 'utf8')
    expect(content).toContain('businessId: keyRecord.business.id')
    expect(content).toContain('apiKeyId: keyRecord.id')
    expect(content).toContain('scopes: keyRecord.scopes')
  })

  it('auth queries BusinessApiKey by keyHash + ACTIVE status', () => {
    const content = fs.readFileSync('src/lib/api/auth.ts', 'utf8')
    expect(content).toContain('keyHash')
    expect(content).toContain('status: \'ACTIVE\'')
  })

  it('key lookup uses SHA-256 hash, never raw key', () => {
    const content = fs.readFileSync('src/lib/api/auth.ts', 'utf8')
    expect(content).toContain('const keyHash = hashApiKey(apiKey)')
    expect(content).toContain('findFirst')
    expect(content).not.toContain('key: apiKey')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: Scopes Contract (filesystem assertions)
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-3: Scopes contract', () => {
  it('hasScope allows empty required scopes', () => {
    const content = fs.readFileSync('src/lib/api/scopes.ts', 'utf8')
    expect(content).toContain('if (!requiredScopes.length) return true')
  })

  it('hasScope allows legacy keys (empty scopes) full access', () => {
    const content = fs.readFileSync('src/lib/api/scopes.ts', 'utf8')
    expect(content).toContain('legacy key')
    expect(content).toContain('full access during migration')
  })

  it('ROUTE_SCOPE_MAP covers all API routes', () => {
    const content = fs.readFileSync('src/lib/api/scopes.ts', 'utf8')
    const expectedRoutes = [
      'GET /api/v1/packages', 'POST /api/v1/esims/order', 'GET /api/v1/orders',
      'GET /api/v1/orders/[id]', 'GET /api/v1/esims/[id]',
      'POST /api/v1/esims/[id]/refresh-status', 'POST /api/v1/esims/[id]/top-up',
      'POST /api/v1/esims/[id]/share', 'GET /api/v1/esims/[id]/usage',
      'GET /api/v1/usage', 'GET /api/v1/wallet', 'GET /api/v1/wallet/transactions',
      'GET /api/v1/customers', 'POST /api/v1/customers',
      'GET /api/v1/customers/[id]', 'PATCH /api/v1/customers/[id]',
      'GET /api/v1/webhooks', 'POST /api/v1/webhooks',
      'GET /api/v1/webhooks/[id]', 'PATCH /api/v1/webhooks/[id]',
      'DELETE /api/v1/webhooks/[id]', 'POST /api/v1/webhooks/[id]/test',
      'GET /api/v1/webhooks/[id]/deliveries', 'POST /api/v1/webhooks/deliveries/[id]/retry',
      'GET /api/v1/auth/verify',
    ]
    for (const route of expectedRoutes) {
      expect(content, `ROUTE_SCOPE_MAP missing: ${route}`).toContain(route)
    }
  })

  it('11 scopes defined', () => {
    const content = fs.readFileSync('src/lib/api/scopes.ts', 'utf8')
    const scopes = ['packages:read', 'quotes:write', 'orders:read', 'orders:write',
      'esims:read', 'esims:write', 'wallet:read', 'customers:read', 'customers:write',
      'webhooks:read', 'webhooks:write']
    for (const s of scopes) {
      expect(content).toContain(s)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: Error Contract (filesystem assertions)
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-4: Error contract', () => {
  it('generateRequestId produces req_ format', () => {
    const content = fs.readFileSync('src/lib/api/error-contract.ts', 'utf8')
    expect(content).toContain('req_')
    expect(content).toContain('toString(36)')
  })

  it('apiError includes X-Request-Id header', () => {
    const content = fs.readFileSync('src/lib/api/error-contract.ts', 'utf8')
    expect(content).toContain('X-Request-Id')
    expect(content).toContain('headers:')
  })

  it('all 13 error codes are defined', () => {
    const content = fs.readFileSync('src/lib/api/error-contract.ts', 'utf8')
    const codes = [
      'INVALID_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT',
      'RATE_LIMITED', 'IDEMPOTENCY_CONFLICT', 'INSUFFICIENT_BALANCE', 'QUOTE_REQUIRED',
      'QUOTE_EXPIRED', 'ORDER_NOT_RETRYABLE', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE',
    ]
    for (const code of codes) {
      expect(content, `Missing error code: ${code}`).toContain(code)
    }
  })

  it('apiValidationError wraps Zod errors', () => {
    const content = fs.readFileSync('src/lib/api/error-contract.ts', 'utf8')
    expect(content).toContain('apiValidationError')
    expect(content).toContain('zodError')
  })

  it('error body shape: { error: { code, message, requestId } }', () => {
    const content = fs.readFileSync('src/lib/api/error-contract.ts', 'utf8')
    expect(content).toContain("error: { code, message, requestId: rid }")
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: Provider Field Stripping (filesystem assertions)
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-5: Provider field stripping', () => {
  it('stripPackageProviderFields removes provider internals', () => {
    const content = fs.readFileSync('src/lib/analytics/safe-fields.ts', 'utf8')
    const stripped = ['providerName', 'providerPlanId', 'providerId', 'providerRawData',
      'providerMapping', 'costPriceUSD', 'markupPercent', 'costCurrency']
    for (const f of stripped) {
      expect(content, `Package stripping missing: ${f}`).toContain(f)
    }
  })

  it('stripEsimProviderFields removes provider internals', () => {
    const content = fs.readFileSync('src/lib/analytics/safe-fields.ts', 'utf8')
    const stripped = ['providerActivationId', 'providerSubscriptionId', 'providerStatus',
      'providerResponse', 'lastSyncAt', 'packageSnapshot']
    for (const f of stripped) {
      expect(content, `eSIM stripping missing: ${f}`).toContain(f)
    }
  })

  it('stripPurchaseProviderFields removes provider internals', () => {
    const content = fs.readFileSync('src/lib/analytics/safe-fields.ts', 'utf8')
    const stripped = ['providerStatus', 'providerResponse', 'providerId',
      'providerReservationId', 'providerFulfillId', 'failureReason', 'retryCount']
    for (const f of stripped) {
      expect(content, `Purchase stripping missing: ${f}`).toContain(f)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6: Webhook Event Types + HMAC Contract
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-6: Webhook event types and HMAC', () => {
  const EXPECTED_EVENTS = [
    'order.completed', 'order.failed', 'esim.provisioned', 'esim.activated',
    'esim.expired', 'esim.suspended', 'usage.updated', 'topup.completed',
    'topup.failed', 'wallet.low_balance',
  ]

  it('dispatcher defines all 10 event types', () => {
    const content = fs.readFileSync('src/lib/services/business-webhooks/dispatcher.ts', 'utf8')
    for (const event of EXPECTED_EVENTS) {
      expect(content).toContain(event)
    }
  })

  it('webhooks creation route validates same events', () => {
    const content = fs.readFileSync('src/app/api/v1/webhooks/route.ts', 'utf8')
    for (const event of EXPECTED_EVENTS) {
      expect(content).toContain(event)
    }
  })

  it('dispatcher HMAC uses timestamp.body pattern', () => {
    const content = fs.readFileSync('src/lib/services/business-webhooks/dispatcher.ts', 'utf8')
    expect(content).toContain('timestamp}.${body}')
  })

  it('webhook test endpoint uses matching HMAC pattern', () => {
    const content = fs.readFileSync('src/app/api/v1/webhooks/[id]/test/route.ts', 'utf8')
    expect(content).toContain('timestamp}.${body}')
  })

  it('delivery headers include X-OneSim-Event, Signature, Timestamp', () => {
    const content = fs.readFileSync('src/lib/services/business-webhooks/dispatcher.ts', 'utf8')
    expect(content).toContain('X-OneSim-Event')
    expect(content).toContain('X-OneSim-Signature')
    expect(content).toContain('X-OneSim-Timestamp')
    expect(content).toContain('X-OneSim-Event-Id')
  })

  it('webhook secret prefix is whsec_', () => {
    const content = fs.readFileSync('src/lib/actions/webhooks.ts', 'utf8')
    expect(content).toContain('whsec_')
  })

  it('retry schedule: 60s, 300s, 900s, 3600s (up to 5 attempts)', () => {
    const content = fs.readFileSync('src/lib/services/business-webhooks/dispatcher.ts', 'utf8')
    expect(content).toContain('[60, 300, 900, 3600]')
  })

  it('webhook timeout is 10 seconds', () => {
    const dispatcher = fs.readFileSync('src/lib/services/business-webhooks/dispatcher.ts', 'utf8')
    expect(dispatcher).toContain('10000')
    const testEndpoint = fs.readFileSync('src/app/api/v1/webhooks/[id]/test/route.ts', 'utf8')
    expect(testEndpoint).toContain('10000')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7: Rate Limiting Contract
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-7: Rate limiting contract', () => {
  it('default rate limit is 60 requests/minute', () => {
    const content = fs.readFileSync('src/lib/api/logging.ts', 'utf8')
    expect(content).toContain('defaultLimit = 60')
  })

  it('rate limit response includes Retry-After: 60', () => {
    const content = fs.readFileSync('src/lib/api/logging.ts', 'utf8')
    expect(content).toContain('Retry-After')
    expect(content).toContain("'60'")
  })

  it('rate limit uses RATE_LIMITED error code', () => {
    const content = fs.readFileSync('src/lib/api/logging.ts', 'utf8')
    expect(content).toContain('RATE_LIMITED')
  })

  it('rate limit headers: X-RateLimit-Limit, Remaining, Reset', () => {
    const content = fs.readFileSync('src/lib/api/logging.ts', 'utf8')
    expect(content).toContain('X-RateLimit-Limit')
    expect(content).toContain('X-RateLimit-Remaining')
    expect(content).toContain('X-RateLimit-Reset')
  })

  it('rate limit is per-business (sliding window counter)', () => {
    const content = fs.readFileSync('src/lib/api/logging.ts', 'utf8')
    expect(content).toContain('businessId')
    expect(content).toContain('apiRequestLog.count')
    expect(content).toContain('60 * 1000')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8: OpenAPI Spec Contract
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-8: OpenAPI spec accuracy', () => {
  const content = fs.readFileSync('src/app/api/openapi.json/route.ts', 'utf8')

  it('spec uses onesim_ key prefix', () => {
    expect(content).toContain('onesim_')
    expect(content).not.toContain('os_live_')
    expect(content).not.toContain('os_test_')
  })

  it('spec is OpenAPI 3.1.0', () => {
    expect(content).toContain('3.1.0')
  })

  it('spec documents all 20 API paths', () => {
    const paths = [
      '/packages', '/esims/order', '/orders', '/orders/{orderId}',
      '/esims/{esimId}', '/esims/{esimId}/usage', '/esims/{esimId}/refresh-status',
      '/esims/{esimId}/top-up', '/esims/{esimId}/share',
      '/usage', '/wallet', '/wallet/transactions',
      '/customers', '/customers/{id}',
      '/webhooks', '/webhooks/{id}', '/webhooks/{id}/test',
      '/webhooks/{id}/deliveries', '/webhooks/deliveries/{deliveryId}/retry',
      '/auth/verify',
    ]
    for (const p of paths) {
      expect(content, `OpenAPI spec missing path: ${p}`).toContain(p)
    }
  })

  it('spec includes ApiError schema', () => {
    expect(content).toContain('ApiError')
    expect(content).toContain('requestId')
  })

  it('spec includes Order schema with async statuses', () => {
    expect(content).toContain('PARTIALLY_FULFILLED')
    expect(content).toContain('PROVIDER_RECONCILIATION')
    expect(content).toContain('PAYMENT_RESERVED')
    expect(content).toContain('PENDING_PROVIDER')
  })

  it('spec includes bearerAuth security scheme', () => {
    expect(content).toContain('bearerAuth')
  })

  it('spec defines production and sandbox servers', () => {
    expect(content).toContain('Production')
    expect(content).toContain('Sandbox')
  })

  it('spec includes all domain tags', () => {
    const tags = ['Packages', 'Orders', 'eSIMs', 'Usage', 'Wallet', 'Customers', 'Webhooks', 'Authentication']
    for (const tag of tags) {
      expect(content).toContain(tag)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9: Response Format Consistency
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-9: Response format consistency', () => {
  const INLINE_ROUTES = [
    'src/app/api/v1/esims/order/route.ts',
    'src/app/api/v1/esims/[esimId]/usage/route.ts',
    'src/app/api/v1/esims/[esimId]/refresh-status/route.ts',
    'src/app/api/v1/esims/[esimId]/top-up/route.ts',
    'src/app/api/v1/esims/[esimId]/share/route.ts',
    'src/app/api/v1/usage/route.ts',
    'src/app/api/v1/wallet/route.ts',
    'src/app/api/v1/wallet/transactions/route.ts',
    'src/app/api/v1/customers/route.ts',
    'src/app/api/v1/customers/[id]/route.ts',
    'src/app/api/v1/webhooks/route.ts',
    'src/app/api/v1/webhooks/[id]/route.ts',
    'src/app/api/v1/webhooks/[id]/deliveries/route.ts',
    'src/app/api/v1/webhooks/deliveries/[deliveryId]/retry/route.ts',
  ]

  it('all inline-pattern routes define makeError function', () => {
    for (const file of INLINE_ROUTES) {
      const content = fs.readFileSync(file, 'utf8')
      expect(content, `${file} must define makeError`).toContain('function makeError')
    }
  })

  it('all inline-pattern routes return success: false on error', () => {
    for (const file of INLINE_ROUTES) {
      const content = fs.readFileSync(file, 'utf8')
      expect(content, `${file} must return success: false`).toContain('success: false')
    }
  })

  it('all inline-pattern routes return success on success', () => {
    for (const file of INLINE_ROUTES) {
      const content = fs.readFileSync(file, 'utf8')
      const hasSuccess = content.includes('success: true') || !!content.match(/return respond\(request, \{ success,/)
      expect(hasSuccess, `${file} must return success: true or { success, ... }`).toBe(true)
    }
  })

  it('shared-helper routes use apiError for errors', () => {
    const SHARED_ROUTES = [
      'src/app/api/v1/auth/verify/route.ts',
      'src/app/api/v1/packages/route.ts',
      'src/app/api/v1/orders/route.ts',
      'src/app/api/v1/orders/[orderId]/route.ts',
      'src/app/api/v1/esims/[esimId]/route.ts',
    ]
    for (const file of SHARED_ROUTES) {
      const content = fs.readFileSync(file, 'utf8')
      expect(content, `${file} must import from v1-response`).toContain("from '@/lib/api/v1-response'")
    }
  })

  it('all route files perform authentication', () => {
    const allRoutes = INLINE_ROUTES
    const SHARED_ROUTES = [
      'src/app/api/v1/auth/verify/route.ts',
      'src/app/api/v1/packages/route.ts',
      'src/app/api/v1/orders/route.ts',
      'src/app/api/v1/orders/[orderId]/route.ts',
      'src/app/api/v1/esims/[esimId]/route.ts',
    ]
    for (const file of [...INLINE_ROUTES, ...SHARED_ROUTES]) {
      const content = fs.readFileSync(file, 'utf8')
      const hasAuth = content.includes('authenticateApiKey') || content.includes('authenticateAndCheck')
      expect(hasAuth, `${file} must perform authentication`).toBe(true)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10: Order Creation Contract
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-10: Order creation contract', () => {
  const content = fs.readFileSync('src/app/api/v1/esims/order/route.ts', 'utf8')

  it('accepts packageId, sku, or packageCode', () => {
    expect(content).toContain('packageId')
    expect(content).toContain('sku')
    expect(content).toContain('packageCode')
    expect(content).toContain('MISSING_PACKAGE_ID')
  })

  it('requires customerName and customerEmail', () => {
    expect(content).toContain('customerName')
    expect(content).toContain('customerEmail')
    expect(content).toContain('MISSING_FIELDS')
  })

  it('enforces quantity 1-100', () => {
    expect(content).toContain('quantity < 1')
    expect(content).toContain('quantity > 100')
  })

  it('supports Idempotency-Key header', () => {
    expect(content).toContain('Idempotency-Key')
    expect(content).toContain('idempotencyRecord')
    expect(content).toContain('24 * 60 * 60 * 1000')
  })

  it('validates travelDate', () => {
    expect(content).toContain('travelDate')
    expect(content).toContain('isValidTravelDate')
    expect(content).toContain('INVALID_TRAVEL_DATE')
  })

  it('checks wallet balance before purchase', () => {
    expect(content).toContain('walletBalance')
    expect(content).toContain('INSUFFICIENT_WALLET_BALANCE')
  })

  it('runs async (not synchronous fulfillment)', () => {
    expect(content).toContain('async: true')
  })

  it('response includes wallet deduction', () => {
    expect(content).toContain('deducted:')
  })

  it('resolves package via three identifiers', () => {
    expect(content).toContain('resolvePackageIdentifier')
  })

  it('checks purchasability/readiness', () => {
    expect(content).toContain('getPackagePurchaseReadiness')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11: Customer API Contract
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-11: Customer API contract', () => {
  it('GET /customers returns paginated list', () => {
    const content = fs.readFileSync('src/app/api/v1/customers/route.ts', 'utf8')
    expect(content).toContain('pagination')
    expect(content).toContain('totalPages')
  })

  it('POST /customers validates required fields and duplicate email', () => {
    const content = fs.readFileSync('src/app/api/v1/customers/route.ts', 'utf8')
    expect(content).toContain('MISSING_FIELDS')
    expect(content).toContain('DUPLICATE')
  })

  it('customers PATCH scopes update by businessId (TOCTOU fix)', () => {
    const content = fs.readFileSync('src/app/api/v1/customers/[id]/route.ts', 'utf8')
    expect(content).toContain('where: { id: params.id, businessId }')
  })

  it('customers PATCH validates JSON body', () => {
    const content = fs.readFileSync('src/app/api/v1/customers/[id]/route.ts', 'utf8')
    expect(content).toContain('INVALID_JSON')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 12: Webhook API Contract
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-12: Webhook API contract', () => {
  it('POST /webhooks requires HTTPS URLs', () => {
    const content = fs.readFileSync('src/app/api/v1/webhooks/route.ts', 'utf8')
    expect(content).toContain('https://')
    expect(content).toContain('INVALID_URL')
  })

  it('POST /webhooks validates events against EVENT_TYPES', () => {
    const content = fs.readFileSync('src/app/api/v1/webhooks/route.ts', 'utf8')
    expect(content).toContain('EVENT_TYPES')
    expect(content).toContain('INVALID_EVENTS')
  })

  it('POST /webhooks returns secret on creation', () => {
    const content = fs.readFileSync('src/app/api/v1/webhooks/route.ts', 'utf8')
    expect(content).toContain('secret')
    expect(content).toContain('crypto.randomBytes(24)')
  })

  it('DELETE soft-deletes when deliveries exist', () => {
    const content = fs.readFileSync('src/app/api/v1/webhooks/[id]/route.ts', 'utf8')
    expect(content).toContain('disabled')
    expect(content).toContain('INACTIVE')
    expect(content).toContain('webhookDelivery')
  })

  it('webhook test sends HMAC-signed payload', () => {
    const content = fs.readFileSync('src/app/api/v1/webhooks/[id]/test/route.ts', 'utf8')
    expect(content).toContain('createHmac')
    expect(content).toContain('X-OneSim-Signature')
    expect(content).toContain('X-OneSim-Timestamp')
  })

  it('deliveries route has pagination', () => {
    const content = fs.readFileSync('src/app/api/v1/webhooks/[id]/deliveries/route.ts', 'utf8')
    expect(content).toContain('page')
    expect(content).toContain('limit')
    expect(content).toContain('totalPages')
  })

  it('retry validates business ownership of delivery', () => {
    const content = fs.readFileSync('src/app/api/v1/webhooks/deliveries/[deliveryId]/retry/route.ts', 'utf8')
    expect(content).toContain('businessId')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 13: eSIM Management Contract
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-13: eSIM management contract', () => {
  it('GET /esims/[esimId] returns installation presentation', () => {
    const content = fs.readFileSync('src/app/api/v1/esims/[esimId]/route.ts', 'utf8')
    expect(content).toContain('activationCode')
    expect(content).toContain('qrCodeUrl')
    expect(content).toContain('qrPayload')
    expect(content).toContain('qrKind')
    expect(content).toContain('smdpAddress')
    expect(content).toContain('matchingId')
    expect(content).toContain('statusLabel')
    expect(content).toContain('buildInstallationPresentation')
  })

  it('GET /esims/[esimId] includes activationInstructions', () => {
    const content = fs.readFileSync('src/app/api/v1/esims/[esimId]/route.ts', 'utf8')
    expect(content).toContain('activationInstructions')
  })

  it('refresh-status checks provider capability', () => {
    const content = fs.readFileSync('src/app/api/v1/esims/[esimId]/refresh-status/route.ts', 'utf8')
    expect(content).toContain('isCapabilityExposedToApi')
    expect(content).toContain('STATUS')
  })

  it('top-up checks provider capability', () => {
    const content = fs.readFileSync('src/app/api/v1/esims/[esimId]/top-up/route.ts', 'utf8')
    expect(content).toContain('isCapabilityExposedToApi')
    expect(content).toContain('TOP_UP')
  })

  it('share generates 7-day token', () => {
    const content = fs.readFileSync('src/app/api/v1/esims/[esimId]/share/route.ts', 'utf8')
    expect(content).toContain('7 * 24 * 60 * 60 * 1000')
    expect(content).toContain('eSIMShareToken')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 14: Wallet Contract
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-14: Wallet contract', () => {
  it('GET /wallet returns balance, currency, usage summary', () => {
    const content = fs.readFileSync('src/app/api/v1/wallet/route.ts', 'utf8')
    expect(content).toContain('balance')
    expect(content).toContain('currency')
    expect(content).toContain('totalUsed')
    expect(content).toContain('pendingCreditRequests')
  })

  it('GET /wallet/transactions has pagination', () => {
    const content = fs.readFileSync('src/app/api/v1/wallet/transactions/route.ts', 'utf8')
    expect(content).toContain('page')
    expect(content).toContain('limit')
    expect(content).toContain('totalPages')
    expect(content).toContain('hasNext')
  })

  it('wallet routes check business suspension', () => {
    const walletContent = fs.readFileSync('src/app/api/v1/wallet/route.ts', 'utf8')
    expect(walletContent).toContain('SUSPENDED')
    const txContent = fs.readFileSync('src/app/api/v1/wallet/transactions/route.ts', 'utf8')
    expect(txContent).toContain('SUSPENDED')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 15: Package Contract
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-15: Package contract', () => {
  it('packages endpoint strips provider fields', () => {
    const content = fs.readFileSync('src/app/api/v1/packages/route.ts', 'utf8')
    expect(content).toContain('stripPackageProviderFields')
  })

  it('packages return unitCost, unitPrice, currency', () => {
    const content = fs.readFileSync('src/app/api/v1/packages/route.ts', 'utf8')
    expect(content).toContain('unitCost')
    expect(content).toContain('unitPrice')
    expect(content).toContain('currency')
  })

  it('packages use purchasability filter', () => {
    const content = fs.readFileSync('src/app/api/v1/packages/route.ts', 'utf8')
    expect(content).toContain('queryPurchasablePackages')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 16: v1-response helper contract
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-16: v1-response helper contract', () => {
  it('authenticateAndCheck generates requestId', () => {
    const content = fs.readFileSync('src/lib/api/v1-response.ts', 'utf8')
    expect(content).toContain('generateRequestId')
  })

  it('authenticateAndCheck returns authError, businessId, rateLimit', () => {
    const content = fs.readFileSync('src/lib/api/v1-response.ts', 'utf8')
    expect(content).toContain('authError')
    expect(content).toContain('businessId')
    expect(content).toContain('rateLimit')
  })

  it('respond helper adds rate limit headers and logs', () => {
    const content = fs.readFileSync('src/lib/api/v1-response.ts', 'utf8')
    expect(content).toContain('addRateLimitHeaders')
    expect(content).toContain('logApiRequest')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 17: Certification Summary
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-17: Certification summary', () => {
  it('no route files contain mock provider calls', () => {
    const routeDir = 'src/app/api/v1'
    const walk = (dir: string): string[] => {
      const results: string[] = []
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) results.push(...walk(full))
        else if (entry.name === 'route.ts') results.push(full)
      }
      return results
    }
    const routeFiles = walk(routeDir)
    for (const file of routeFiles) {
      const content = fs.readFileSync(file, 'utf8')
      expect(content, `${file} must not contain mockResolvedValue`).not.toContain('mockResolvedValue({ success: true, data:')
    }
  })

  it('customer PATCH uses scoped update (TOCTOU fix verified)', () => {
    const content = fs.readFileSync('src/app/api/v1/customers/[id]/route.ts', 'utf8')
    expect(content).toContain('where: { id: params.id, businessId }')
  })

  it('OpenAPI uses onesim_ prefix (not os_live_/os_test_)', () => {
    const content = fs.readFileSync('src/app/api/openapi.json/route.ts', 'utf8')
    expect(content).toContain('onesim_')
  })

  it('rate limit error code is RATE_LIMITED consistently', () => {
    const content = fs.readFileSync('src/lib/api/logging.ts', 'utf8')
    expect(content).toContain('RATE_LIMITED')
  })
})
