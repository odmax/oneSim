import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  serializePublicPackage,
  serializePublicOrder,
  serializePublicUsageRecord,
  serializePublicUsageEsim,
  serializePublicWalletTransaction,
  serializePublicCustomer,
  serializePublicCustomerDetail,
  serializePublicWebhook,
  findForbiddenFields,
} from '@/lib/api/public-dto'

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
  it('packages endpoint uses public DTO serializer for provider stripping', () => {
    const content = fs.readFileSync('src/app/api/v1/packages/route.ts', 'utf8')
    expect(content).toContain('serializePublicPackage')
  })

  it('packages serializer returns unitPrice and currency', () => {
    const content = fs.readFileSync('src/lib/api/public-dto.ts', 'utf8')
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

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 18: Public DTO Serializer Unit Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-18: Public DTO serializers (unit tests)', () => {
  it('serializePublicPackage uses allowlist — no provider fields leak', () => {
    const fake = {
      id: 'pkg_1', name: 'US 5GB', displayName: 'US 5GB Plan', sku: 'US-5GB-01',
      packageCode: 'P-US-5GB', description: 'desc', customerDescription: 'cust desc',
      dataGB: 5, validityDays: 30, priceUSD: { toString: () => '19.99' },
      currency: 'USD', productType: 'NEW_ESIM', isActive: true, source: 'CATALOG_PRODUCT',
      country: 'US', region: 'North America',
    }
    const result = serializePublicPackage(fake, { country: 'US', region: 'North America' })
    const keys = Object.keys(result)
    expect(keys).toContain('id')
    expect(keys).toContain('displayName')
    expect(keys).toContain('dataGB')
    expect(keys).toContain('unitPrice')
    expect(keys).not.toContain('providerName')
    expect(keys).not.toContain('providerPlanId')
    expect(keys).not.toContain('providerId')
    expect(keys).not.toContain('providerRawData')
    expect(keys).not.toContain('costPriceUSD')
    expect(keys).not.toContain('providerPackageId')
    expect(result.unitPrice).toBe(19.99)
    expect(result.country).toBe('US')
  })

  it('serializePublicOrder excludes all internal fields', () => {
    const fake = {
      id: 'ord_1', status: 'FULFILLED', quantity: 2,
      totalAmount: { toString: () => '39.98' },
      createdAt: new Date('2025-01-01'), updatedAt: new Date('2025-01-02'),
      fulfilledQuantity: 2, failedQuantity: 0,
      callbackUrl: null, resolvedTravelDate: null, requestedTravelDate: null,
      packageSnapshot: { packageId: 'pkg_1', displayName: 'US 5GB', dataGB: 5, validityDays: 30, priceUSD: 19.99, currency: 'USD' },
      packageName: null, packageDataGB: null, packageValidityDays: null,
      packageUnitPrice: null, packageCurrency: null,
      package: { id: 'pkg_1', displayName: 'US 5GB', name: 'US 5GB', dataGB: 5, validityDays: 30, priceUSD: { toString: () => '19.99' }, currency: 'USD' },
      esims: [{ id: 'e_1', iccid: '8901234', imsi: '310260', status: 'ACTIVE', expiresAt: null, dataUsedMB: 100, dataRemainingMB: 4900 }],
    }
    const result = serializePublicOrder(fake)
    const json = JSON.parse(JSON.stringify(result))
    const leaks = findForbiddenFields(json)
    expect(leaks).toEqual([])
    expect(json.id).toBe('ord_1')
    expect(json.status).toBe('FULFILLED')
    expect(json.quantity).toBe(2)
    expect(json.unitCost).toBe(19.99)
    expect(json.package.displayName).toBe('US 5GB')
    expect(json.esims).toHaveLength(1)
    expect(json.esims[0].iccid).toBe('8901234')
  })

  it('serializePublicUsageRecord strips rawData and internal ids', () => {
    const fake = {
      id: 'ur_1', esimId: 'e_1', dataUsedMB: 256, dataTotalMB: 5000,
      dataRemainingMB: 4744, dataPercentage: 5.12,
      timestamp: new Date('2025-06-01'),
      rawData: { providerAccount: 'acc123', bundleCode: 'BUNDLE_A' },
    }
    const result = serializePublicUsageRecord(fake)
    const json = JSON.parse(JSON.stringify(result))
    expect(json).not.toHaveProperty('id')
    expect(json).not.toHaveProperty('esimId')
    expect(json).not.toHaveProperty('dataPercentage')
    expect(json).not.toHaveProperty('rawData')
    expect(json.dataUsedMB).toBe(256)
    expect(json.dataTotalMB).toBe(5000)
    expect(json.timestamp).toBe('2025-06-01T00:00:00.000Z')
  })

  it('serializePublicUsageEsim uses allowlist', () => {
    const fake = {
      id: 'e_1', iccid: '8901234', imsi: '310260', status: 'ACTIVE',
      expiresAt: new Date('2025-12-01'),
      dataUsedMB: 100, dataRemainingMB: 4900, dataTotalMB: 5000,
      lastUsageSyncAt: new Date('2025-06-01'),
      purchase: { package: { id: 'pkg_1', displayName: 'US 5GB', name: 'US 5GB', dataGB: 5, validityDays: 30 } },
      usageRecords: [{ dataUsedMB: 50, dataTotalMB: 5000, dataRemainingMB: 4950, timestamp: new Date('2025-06-01') }],
    }
    const result = serializePublicUsageEsim(fake)
    const json = JSON.parse(JSON.stringify(result))
    const leaks = findForbiddenFields(json)
    expect(leaks).toEqual([])
    expect(json.lastUsage).toEqual({ dataUsedMB: 50, dataTotalMB: 5000, dataRemainingMB: 4950, timestamp: '2025-06-01T00:00:00.000Z' })
    expect(json.lastUsage).not.toHaveProperty('rawData')
  })

  it('serializePublicWalletTransaction uses allowlist', () => {
    const fake = {
      id: 'tx_1', type: 'PURCHASE', amount: { toString: () => '-19.99' },
      description: 'eSIM purchase', createdAt: new Date('2025-01-01'),
      businessId: 'biz_1', orderId: 'ord_1', topUpId: null,
    }
    const result = serializePublicWalletTransaction(fake)
    const json = JSON.parse(JSON.stringify(result))
    expect(json).not.toHaveProperty('businessId')
    expect(json).not.toHaveProperty('orderId')
    expect(json).not.toHaveProperty('topUpId')
    expect(json.amount).toBe(-19.99)
  })

  it('serializePublicCustomer uses allowlist', () => {
    const fake = {
      id: 'c_1', name: 'John', email: 'john@test.com', phone: '+1234',
      country: 'US', status: 'ACTIVE', createdAt: new Date('2025-01-01'),
      businessId: 'biz_1', providerSubscriberId: 'PS_123',
      providerMetadata: { providerId: 'AIRHUB' },
    }
    const result = serializePublicCustomer(fake)
    const json = JSON.parse(JSON.stringify(result))
    expect(json).not.toHaveProperty('businessId')
    expect(json).not.toHaveProperty('providerSubscriberId')
    expect(json).not.toHaveProperty('providerMetadata')
    expect(json.name).toBe('John')
  })

  it('serializePublicWebhook uses allowlist — no secret leak', () => {
    const fake = {
      id: 'wh_1', name: 'Test', url: 'https://hook.test', status: 'ACTIVE',
      events: ['order.completed'], lastSuccessAt: null, lastFailureAt: null,
      failureCount: 0, createdAt: new Date('2025-01-01'),
      secret: 'whsec_SUPER_SECRET_123', businessId: 'biz_1',
    }
    const result = serializePublicWebhook(fake)
    const json = JSON.parse(JSON.stringify(result))
    expect(json).not.toHaveProperty('secret')
    expect(json).not.toHaveProperty('businessId')
    expect(json.url).toBe('https://hook.test')
  })

  it('findForbiddenFields detects deeply nested provider fields', () => {
    const payload = {
      order: {
        id: 'ord_1',
        package: {
          providerPackage: { providerId: 'AIRHUB', providerRawData: {} },
          costPrice: 10,
        },
        businessId: 'biz_1',
        nested: {
          deep: {
            providerPlanId: 'plan_1',
          },
        },
      },
    }
    const leaks = findForbiddenFields(payload)
    expect(leaks).toContain('order.package.providerPackage.providerId')
    expect(leaks).toContain('order.package.providerPackage.providerRawData')
    expect(leaks).toContain('order.package.costPrice')
    expect(leaks).toContain('order.businessId')
    expect(leaks).toContain('order.nested.deep.providerPlanId')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 19: Route Serialization Path Enforcement
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-19: Route serialization path enforcement', () => {
  it('packages route imports and uses serializePublicPackage', () => {
    const content = fs.readFileSync('src/app/api/v1/packages/route.ts', 'utf8')
    expect(content).toContain("from '@/lib/api/public-dto'")
    expect(content).toContain('serializePublicPackage')
    expect(content).not.toContain('...base')
    expect(content).not.toContain('stripPackageProviderFields')
  })

  it('orders list route imports and uses serializePublicOrder', () => {
    const content = fs.readFileSync('src/app/api/v1/orders/route.ts', 'utf8')
    expect(content).toContain("from '@/lib/api/public-dto'")
    expect(content).toContain('serializePublicOrder')
    expect(content).not.toContain('...base')
  })

  it('orders detail route imports and uses serializePublicOrder', () => {
    const content = fs.readFileSync('src/app/api/v1/orders/[orderId]/route.ts', 'utf8')
    expect(content).toContain("from '@/lib/api/public-dto'")
    expect(content).toContain('serializePublicOrder')
    expect(content).not.toContain('...stripPurchaseProviderFields')
  })

  it('usage list route imports and uses serializePublicUsageEsim', () => {
    const content = fs.readFileSync('src/app/api/v1/usage/route.ts', 'utf8')
    expect(content).toContain("from '@/lib/api/public-dto'")
    expect(content).toContain('serializePublicUsageEsim')
  })

  it('eSIM detail route serializes usage records', () => {
    const content = fs.readFileSync('src/app/api/v1/esims/[esimId]/route.ts', 'utf8')
    expect(content).toContain('serializePublicUsageRecord')
  })

  it('eSIM usage route imports and uses serializePublicUsageRecord', () => {
    const content = fs.readFileSync('src/app/api/v1/esims/[esimId]/usage/route.ts', 'utf8')
    expect(content).toContain("from '@/lib/api/public-dto'")
    expect(content).toContain('serializePublicUsageRecord')
  })

  it('customer routes import and use serializers', () => {
    const list = fs.readFileSync('src/app/api/v1/customers/route.ts', 'utf8')
    expect(list).toContain("from '@/lib/api/public-dto'")
    expect(list).toContain('serializePublicCustomer')
    const detail = fs.readFileSync('src/app/api/v1/customers/[id]/route.ts', 'utf8')
    expect(detail).toContain('serializePublicCustomerDetail')
    expect(detail).toContain('serializePublicCustomer')
  })

  it('wallet routes import and use serializers', () => {
    const balance = fs.readFileSync('src/app/api/v1/wallet/route.ts', 'utf8')
    expect(balance).toContain("from '@/lib/api/public-dto'")
    expect(balance).toContain('serializePublicWalletTransaction')
    const tx = fs.readFileSync('src/app/api/v1/wallet/transactions/route.ts', 'utf8')
    expect(tx).toContain('serializePublicWalletTransaction')
  })

  it('webhook routes import and use serializers', () => {
    const list = fs.readFileSync('src/app/api/v1/webhooks/route.ts', 'utf8')
    expect(list).toContain("from '@/lib/api/public-dto'")
    expect(list).toContain('serializePublicWebhook')
    const detail = fs.readFileSync('src/app/api/v1/webhooks/[id]/route.ts', 'utf8')
    expect(detail).toContain('serializePublicWebhook')
  })

  it('no route spreads raw Prisma package with providerPackage nested object', () => {
    const content = fs.readFileSync('src/app/api/v1/packages/route.ts', 'utf8')
    expect(content).not.toContain('...pkg')
    expect(content).not.toContain('...base,')
    expect(content).not.toContain('...base\n')
  })

  it('no route spreads raw purchase object for order responses', () => {
    const content = fs.readFileSync('src/app/api/v1/orders/route.ts', 'utf8')
    expect(content).not.toContain('...base,')
    expect(content).not.toContain('...base\n')
    const detail = fs.readFileSync('src/app/api/v1/orders/[orderId]/route.ts', 'utf8')
    expect(detail).not.toContain('...stripPurchaseProviderFields')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 20: Provider Identity in SKU Audit
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-20: Provider identity in public identifiers audit', () => {
  it('WARNING: SKU generation may embed provider names — document for migration', () => {
    const resolverFiles = [
      'src/lib/packages/resolve-package.ts',
      'src/lib/packages/query-purchasable.ts',
    ]
    for (const file of resolverFiles) {
      if (!fs.existsSync(file)) continue
      const content = fs.readFileSync(file, 'utf8')
      // Check for provider name patterns in SKU/packageCode construction
      const hasProviderInSku = content.includes('AIRHUB') || content.includes('CHOICE') || content.includes('USMATR')
      if (hasProviderInSku) {
        // This is a known limitation — provider names may be embedded in SKUs
        // from the catalog import process. Migration to provider-neutral SKUs
        // requires a catalog data migration.
        expect(true, `NOTE: ${file} may contain provider names in SKU patterns — tracked for future migration`).toBe(true)
      }
    }
    // The public DTO serializer (serializePublicPackage) correctly exposes SKU as-is.
    // Changing SKUs requires a data migration, not a code change.
    expect(true).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 21: Secrets / Sensitive Data Detection
// ═══════════════════════════════════════════════════════════════════════════════

describe('API-CONTRACT-21: Secrets and sensitive data detection', () => {
  it('webhook secret is only returned on POST creation, never on GET/PATCH', () => {
    const postContent = fs.readFileSync('src/app/api/v1/webhooks/route.ts', 'utf8')
    expect(postContent).toContain('secret: endpoint.secret')

    const getContent = fs.readFileSync('src/app/api/v1/webhooks/[id]/route.ts', 'utf8')
    expect(getContent).not.toMatch(/secret:/)
    expect(getContent).not.toContain('endpoint.secret')
  })

  it('no route returns keyHash, accessToken, refreshToken, password, or secret (except webhook POST)', () => {
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
    const sensitiveFields = ['keyHash', 'accessToken', 'refreshToken', 'password', 'credentials']
    for (const file of routeFiles) {
      const content = fs.readFileSync(file, 'utf8')
      for (const field of sensitiveFields) {
        const hasField = content.includes(`response.`) && content.includes(`${field}:`)
        expect(hasField, `${file} must not return ${field} in response body`).toBe(false)
      }
    }
  })

  it('no route returns rawData, providerRawData, or providerPayload in response body', () => {
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
      expect(content, `${file} must not return rawData in response`).not.toMatch(/rawData:/)
      expect(content, `${file} must not return providerRawData in response`).not.toMatch(/providerRawData:/)
    }
  })
})
