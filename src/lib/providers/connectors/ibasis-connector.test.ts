import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Provider } from '@prisma/client'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))

vi.mock('@/lib/encryption', () => ({
  encryptToken: vi.fn((t: string | null | undefined) => t ? `enc:${t}` : null),
  decryptToken: vi.fn((t: string | null | undefined) => {
    if (!t) return null
    if (typeof t === 'string' && t.startsWith('enc:')) return t.slice(4)
    return t
  }),
}))

vi.mock('@/lib/services/providers/health-monitor', () => ({
  recordHealthEvent: vi.fn().mockResolvedValue(undefined),
}))

import { prisma } from '@/lib/prisma'
import { IbasisConnector, maskToken } from './ibasis-connector'
import { resolveConnectorType, createConnector } from './connector-factory'

const mockPrisma = vi.mocked(prisma)

const RAW_TOKEN = 'ibasis-token-1234567890'

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'ibasis-1',
    name: 'iBASIS',
    code: 'IBASIS',
    type: 'CUSTOM',
    adapterStrategy: 'IBASIS',
    authType: 'api_token',
    tokenPlacement: 'HEADER',
    apiVersion: 'v1',
    apiBaseUrl: 'https://api.ibasis.example.com',
    apiToken: `enc:${RAW_TOKEN}`,
    authUrl: null,
    environment: 'staging',
    status: 'ACTIVE',
    config: {
      baseUrl: 'https://api.ibasis.example.com',
      requestTimeoutMs: 15000,
      environment: 'staging',
      defaultCurrency: 'USD',
    },
    fieldMappings: null,
    endpointMappings: null,
    requestMappings: null,
    responseMappings: null,
    lastSuccessfulConnection: null,
    lastFailedConnection: null,
    errorCount: 0,
    lastError: null,
    planListPath: null,
    activationPath: null,
    statusPath: null,
    usagePath: null,
    suspendPath: null,
    resumePath: null,
    topUpPath: null,
    responseListKey: null,
    requiredConfigFields: null,
    optionalConfigFields: null,
    providerTemplateId: null,
    supportsESIM: false,
    supportsUsage: false,
    supportsTopUp: false,
    supportsSuspend: false,
    supportsQRCode: false,
    supportsPools: false,
    supportsTemplates: false,
    supportsUsageSync: false,
    supportsWebhookPush: false,
    supportsSuspendResume: false,
    isDefaultFallback: false,
    priority: 0,
    regions: null,
    certificationStatus: 'CONFIGURING',
    activationSuccessRate: null,
    averageActivationTimeMs: null,
    lastSyncAt: null,
    lastSyncResult: null,
    lastSyncCount: null,
    catalogPriority: 100,
    enabledCapabilities: null,
    certifiedAt: null,
    certificationNotes: null,
    lastCertificationRunAt: null,
    autoPublishEnabled: false,
    ...overrides,
  } as Provider
}

interface MockFetchResponse {
  ok: boolean
  status: number
  statusText: string
  text: () => Promise<string>
  headers: { get: (name: string) => string | null }
}

function mockFetchSuccess(body: unknown, status = 200): MockFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERROR',
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
  }
}

describe('IbasisConnector', () => {
  let connector: IbasisConnector
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.provider.findUnique.mockResolvedValue(makeProvider())
    mockPrisma.provider.update.mockResolvedValue({} as any)
    fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as any
    connector = new IbasisConnector('ibasis-1')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('constructor', () => {
    it('sets providerId and name', () => {
      expect(connector.providerId).toBe('ibasis-1')
      expect(connector.name).toBe('iBASIS')
    })
  })

  describe('authenticate', () => {
    it('returns UNSUPPORTED — iBASIS uses a static API token', async () => {
      const result = await connector.authenticate({})
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('UNSUPPORTED')
    })
  })

  describe('getTokenState', () => {
    it('returns tokenPresent when token is configured', async () => {
      const state = await connector.getTokenState()
      expect(state.tokenPresent).toBe(true)
    })

    it('returns tokenPresent false when no token', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(makeProvider({ apiToken: null, config: { baseUrl: 'https://api.ibasis.example.com' } }))
      const state = await connector.getTokenState()
      expect(state.tokenPresent).toBe(false)
    })
  })

  describe('ensureAuthenticated', () => {
    it('succeeds when baseUrl and token are configured', async () => {
      const result = await connector.ensureAuthenticated()
      expect(result.success).toBe(true)
    })

    it('fails when token missing', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(makeProvider({ apiToken: null, config: { baseUrl: 'https://api.ibasis.example.com' } }))
      const result = await connector.ensureAuthenticated()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_CONFIGURED')
    })
  })

  describe('refreshAuthentication', () => {
    it('returns false — static token, no refresh flow', async () => {
      expect(await connector.refreshAuthentication()).toBe(false)
    })
  })

  describe('testConnection', () => {
    it('sends Authorization: Token <token> header (never Bearer)', async () => {
      fetchSpy.mockResolvedValue(mockFetchSuccess({ data: [] }, 200))
      const result = await connector.testConnection()
      expect(result.success).toBe(true)
      const [, init] = fetchSpy.mock.calls[0]
      const authHeader = (init as any).headers['Authorization']
      expect(authHeader).toBe(`Token ${RAW_TOKEN}`)
      expect(authHeader).not.toContain('Bearer')
    })

    it('uses the configured base URL and inventory path', async () => {
      fetchSpy.mockResolvedValue(mockFetchSuccess({ data: [] }, 200))
      await connector.testConnection()
      const url = fetchSpy.mock.calls[0][0]
      expect(String(url)).toContain('https://api.ibasis.example.com/api/v1/inventory/sims')
    })

    it('limits the request with page size query param', async () => {
      fetchSpy.mockResolvedValue(mockFetchSuccess({ data: [] }, 200))
      await connector.testConnection()
      const url = String(fetchSpy.mock.calls[0][0])
      expect(url).toContain('limit=1')
    })

    it('uses configured inventoryPath override when provided', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(makeProvider({ config: { baseUrl: 'https://api.ibasis.example.com', inventoryPath: '/custom/inventory', requestTimeoutMs: 15000 } }))
      fetchSpy.mockResolvedValue(mockFetchSuccess({ data: [] }, 200))
      await connector.testConnection()
      const url = String(fetchSpy.mock.calls[0][0])
      expect(url).toContain('/custom/inventory')
    })

    it('succeeds on valid JSON response', async () => {
      fetchSpy.mockResolvedValue(mockFetchSuccess({ data: [{ iccid: '8931000' }] }, 200))
      const result = await connector.testConnection()
      expect(result.success).toBe(true)
      expect(result.data?.message).toContain('Connected')
    })

    it('succeeds on authenticated empty result', async () => {
      fetchSpy.mockResolvedValue(mockFetchSuccess([], 200))
      const result = await connector.testConnection()
      expect(result.success).toBe(true)
    })

    it('succeeds on empty body with 200', async () => {
      fetchSpy.mockResolvedValue(mockFetchSuccess('', 200))
      const result = await connector.testConnection()
      expect(result.success).toBe(true)
    })

    it('fails with AUTH_ERROR on HTTP 401', async () => {
      fetchSpy.mockResolvedValue(mockFetchSuccess({ detail: 'Invalid token' }, 401))
      const result = await connector.testConnection()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('AUTH_ERROR')
      expect(result.error?.message).toContain('401')
    })

    it('fails with AUTH_ERROR on HTTP 403', async () => {
      fetchSpy.mockResolvedValue(mockFetchSuccess({ detail: 'Forbidden' }, 403))
      const result = await connector.testConnection()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('AUTH_ERROR')
      expect(result.error?.message).toContain('403')
    })

    it('fails clearly on HTML response', async () => {
      fetchSpy.mockResolvedValue(mockFetchSuccess('<!DOCTYPE html><html><body>Gateway</body></html>', 200))
      const result = await connector.testConnection()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NON_JSON_RESPONSE')
      expect(result.error?.message).toContain('HTML')
    })

    it('fails clearly on malformed JSON', async () => {
      fetchSpy.mockResolvedValue(mockFetchSuccess('{not json', 200))
      const result = await connector.testConnection()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NON_JSON_RESPONSE')
    })

    it('fails with NOT_CONFIGURED when baseUrl missing', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(makeProvider({ apiBaseUrl: null, config: { requestTimeoutMs: 15000 } }))
      const result = await connector.testConnection()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_CONFIGURED')
    })

    it('fails with NOT_CONFIGURED when token missing', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(makeProvider({ apiToken: null, config: { baseUrl: 'https://api.ibasis.example.com' } }))
      const result = await connector.testConnection()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_CONFIGURED')
    })

    it('fails with NETWORK_ERROR on DNS failure', async () => {
      fetchSpy.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }))
      const result = await connector.testConnection()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NETWORK_ERROR')
      expect(result.error?.message).toContain('DNS')
    })

    it('fails with TIMEOUT when request exceeds configured timeout', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(makeProvider({ config: { baseUrl: 'https://api.ibasis.example.com', requestTimeoutMs: 50 } }))
      fetchSpy.mockImplementation((_url: string, init: any) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
      }))
      const result = await connector.testConnection()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('TIMEOUT')
      expect(result.error?.message).toContain('50ms')
    })

    it('updates lastSuccessfulConnection on success', async () => {
      fetchSpy.mockResolvedValue(mockFetchSuccess({ data: [] }, 200))
      await connector.testConnection()
      expect(mockPrisma.provider.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ errorCount: 0 }),
      }))
    })

    it('updates lastFailedConnection and increments errorCount on failure', async () => {
      fetchSpy.mockResolvedValue(mockFetchSuccess({ detail: 'Forbidden' }, 403))
      await connector.testConnection()
      expect(mockPrisma.provider.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ errorCount: { increment: 1 } }),
      }))
    })
  })

  describe('diagnoseConnection', () => {
    it('returns diagnostic info with API_TOKEN auth type and header placement', async () => {
      fetchSpy.mockResolvedValue(mockFetchSuccess({ data: [] }, 200))
      const result = await connector.diagnoseConnection()
      expect(result.success).toBe(true)
      expect(result.data?.connectorClass).toBe('IbasisConnector')
      expect(result.data?.authType).toBe('API_TOKEN')
      expect(result.data?.tokenPlacement).toBe('HEADER')
      expect(result.data?.finalUrl).toContain('/api/v1/inventory/sims')
    })

    it('redacts activation codes from the diagnostic response body', async () => {
      const activationCode = 'FKE: 0$CUST-111-V4-FAKE-ATL2.GDSB.NET$555'
      fetchSpy.mockResolvedValue(mockFetchSuccess({
        count: 1,
        next: null,
        previous: null,
        results: [{ iccid: '89975111967191511974', type: 'esim', carrier: 'AT&T', status: 'Inventory', activation_code: activationCode }],
      }, 200))
      const result = await connector.diagnoseConnection()
      const body = result.data?.responseBody || ''
      expect(body).not.toContain(activationCode)
      expect(body).not.toContain('GDSB.NET')
    })
  })

  describe('Phase 2 methods', () => {
    it('returns NOT_IMPLEMENTED for activateESIM', async () => {
      const result = await connector.activateESIM({ planId: 'p1', quantity: 1, subscriber: { email: 'a@b.com' } })
      expect(result.error?.code).toBe('NOT_IMPLEMENTED')
    })

    it('returns NOT_IMPLEMENTED for getStatus', async () => {
      const result = await connector.getStatus('s1')
      expect(result.error?.code).toBe('NOT_IMPLEMENTED')
    })

    it('returns NOT_IMPLEMENTED for suspendESIM and resumeESIM', async () => {
      const suspend = await connector.suspendESIM('s1')
      const resume = await connector.resumeESIM('s1')
      expect(suspend.error?.code).toBe('NOT_IMPLEMENTED')
      expect(resume.error?.code).toBe('NOT_IMPLEMENTED')
    })
  })

  describe('listInventorySims', () => {
    it('requests the inventory path with limit and Token auth header', async () => {
      fetchSpy.mockResolvedValue(mockFetchSuccess({ count: 1, next: null, previous: null, results: [] }, 200))
      const result = await connector.listInventorySims({ limit: 100 })
      expect(result.success).toBe(true)
      const [url, init] = fetchSpy.mock.calls[0]
      expect(String(url)).toContain('/api/v1/inventory/sims')
      expect(String(url)).toContain('limit=100')
      expect((init as any).headers['Authorization']).toBe(`Token ${RAW_TOKEN}`)
    })

    it('applies optional type and status filters', async () => {
      fetchSpy.mockResolvedValue(mockFetchSuccess({ count: 0, next: null, previous: null, results: [] }, 200))
      await connector.listInventorySims({ type: 'esim', status: 'inventory' })
      const url = String(fetchSpy.mock.calls[0][0])
      expect(url).toContain('type=esim')
      expect(url).toContain('status=inventory')
    })

    it('parses count/next/previous/results into a page', async () => {
      const raw = {
        count: 3,
        next: 'https://api.ibasis.example.com/api/v1/inventory/sims?limit=1&offset=1',
        previous: null,
        results: [
          { iccid: '894050371760699199511', type: 'physical', carrier: 'TMO', status: 'Inventory' },
          { iccid: '89975111967191511974', type: 'esim', carrier: 'AT&T', status: 'Inventory', activation_code: 'FKE: 0$CUST-111-V4-FAKE-ATL2.GDSB.NET$555' },
        ],
      }
      fetchSpy.mockResolvedValue(mockFetchSuccess(raw, 200))
      const result = await connector.listInventorySims()
      expect(result.success).toBe(true)
      expect(result.data?.total).toBe(3)
      expect(result.data?.next).toBe(raw.next)
      expect(result.data?.previous).toBeNull()
      expect(result.data?.items).toHaveLength(2)
      expect(result.data?.items[0].iccid).toBe('894050371760699199511')
      expect(result.data?.items[1].activation_code).toContain('GDSB.NET')
    })

    it('follows an absolute nextUrl directly', async () => {
      fetchSpy.mockResolvedValue(mockFetchSuccess({ count: 0, next: null, previous: null, results: [] }, 200))
      const next = 'https://api.ibasis.example.com/api/v1/inventory/sims?limit=1&offset=1'
      await connector.listInventorySims({ nextUrl: next })
      expect(String(fetchSpy.mock.calls[0][0])).toBe(next)
    })

    it('fails with INVALID_RESPONSE when results array is missing', async () => {
      fetchSpy.mockResolvedValue(mockFetchSuccess({ count: 0 }, 200))
      const result = await connector.listInventorySims()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('INVALID_RESPONSE')
    })

    it('propagates upstream errors', async () => {
      fetchSpy.mockResolvedValue(mockFetchSuccess({ detail: 'Invalid token' }, 401))
      const result = await connector.listInventorySims()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('AUTH_ERROR')
    })

    it('fails with NOT_CONFIGURED when baseUrl is missing', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(makeProvider({ apiBaseUrl: null, config: { requestTimeoutMs: 15000 } }))
      const result = await connector.listInventorySims()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_CONFIGURED')
    })
  })

  describe('syncPlans', () => {
    const PLAN_DETAIL = {
      id: '1GB_TEST_PLAN',
      name: '1GB data-only test plan',
      quota: { messages: 0, 'unlimited messages': false, voice: 0, 'unlimited minutes': false, credit: 0.0, data: 1073741824 },
      currency: 'GBP',
      duration: 30,
      duration_type: 0,
    }

    it('fetches the retail plan list then each plan detail', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockFetchSuccess({ plans: ['1GB_TEST_PLAN'] }, 200))
        .mockResolvedValueOnce(mockFetchSuccess(PLAN_DETAIL, 200))
      const result = await connector.syncPlans()
      expect(result.success).toBe(true)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/v1/plans?limit=50')
      expect(String(fetchSpy.mock.calls[1][0])).toContain('/api/v1/plans/1GB_TEST_PLAN')
      const plan = result.data?.[0]
      expect(plan?.id).toBe('1GB_TEST_PLAN')
      expect(plan?.name).toBe('1GB data-only test plan')
      expect(plan?.data_gb).toBe(1)
      expect(plan?.validity_days).toBe(30)
      expect(plan?.currency).toBe('GBP')
      expect(plan?.sku).toBe('1GB_TEST_PLAN')
    })

    it('normalizes quota data bytes into whole GB', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockFetchSuccess({ plans: ['p1'] }, 200))
        .mockResolvedValueOnce(mockFetchSuccess({ id: 'p1', name: 'Big', quota: { data: '5368709120' }, currency: 'USD', duration: 7, duration_type: 0 }, 200))
      const result = await connector.syncPlans()
      expect(result.data?.[0].data_gb).toBe(5)
      expect(result.data?.[0].validity_days).toBe(7)
    })

    it('defaults validity to 30 days for monthly duration types', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockFetchSuccess({ plans: ['p1'] }, 200))
        .mockResolvedValueOnce(mockFetchSuccess({ id: 'p1', name: 'Monthly', quota: { data: 1073741824 }, currency: 'USD', duration: 1, duration_type: 1 }, 200))
      const result = await connector.syncPlans()
      expect(result.data?.[0].validity_days).toBe(30)
    })

    it('leaves price_usd at 0 so costStatus stays MISSING', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockFetchSuccess({ plans: ['p1'] }, 200))
        .mockResolvedValueOnce(mockFetchSuccess({ id: 'p1', name: 'No Price', quota: { data: 1073741824 }, currency: 'EUR', duration: 10, duration_type: 0 }, 200))
      const result = await connector.syncPlans()
      expect(result.data?.[0].price_usd).toBe(0)
      expect(result.data?.[0].currency).toBe('EUR')
    })

    it('falls back to defaultCurrency when plan currency is missing or invalid', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockFetchSuccess({ plans: ['p1', 'p2'] }, 200))
        .mockResolvedValueOnce(mockFetchSuccess({ id: 'p1', name: 'A', quota: { data: 1073741824 }, duration: 3, duration_type: 0 }, 200))
        .mockResolvedValueOnce(mockFetchSuccess({ id: 'p2', name: 'B', quota: { data: 1073741824 }, currency: 'not-a-currency', duration: 3, duration_type: 0 }, 200))
      const result = await connector.syncPlans()
      expect(result.data?.[0].currency).toBe('USD')
      expect(result.data?.[1].currency).toBe('USD')
    })

    it('skips plans without a usable id or name', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockFetchSuccess({ plans: ['p1'] }, 200))
        .mockResolvedValueOnce(mockFetchSuccess({ name: 'no id' }, 200))
      const result = await connector.syncPlans()
      expect(result.success).toBe(true)
      expect(result.data).toHaveLength(0)
    })

    it('fails with INVALID_RESPONSE when the plans array is missing', async () => {
      fetchSpy.mockResolvedValue(mockFetchSuccess({ detail: 'nope' }, 200))
      const result = await connector.syncPlans()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('INVALID_RESPONSE')
    })

    it('returns partial success when some plan details fail', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockFetchSuccess({ plans: ['good', 'bad'] }, 200))
        .mockResolvedValueOnce(mockFetchSuccess(PLAN_DETAIL, 200))
        .mockResolvedValueOnce(mockFetchSuccess({ detail: 'Not found' }, 404))
      const result = await connector.syncPlans()
      expect(result.success).toBe(true)
      expect(result.data).toHaveLength(1)
      expect(result.data?.[0].id).toBe('1GB_TEST_PLAN')
    })

    it('fails with PARTIAL_FAILURE when every plan detail fails', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockFetchSuccess({ plans: ['a', 'b'] }, 200))
        .mockResolvedValueOnce(mockFetchSuccess({ detail: 'Not found' }, 404))
        .mockResolvedValueOnce(mockFetchSuccess({ detail: 'Not found' }, 404))
      const result = await connector.syncPlans()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('PARTIAL_FAILURE')
    })

    it('uses configured retail plan paths when provided', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(makeProvider({
        config: {
          baseUrl: 'https://api.ibasis.example.com',
          retailPlansPath: '/api/v2/catalog/plans',
          retailPlanDetailPath: '/api/v2/catalog/plans/{plan id}',
          retailPlansPageSize: 100,
          requestTimeoutMs: 15000,
        },
      }))
      fetchSpy
        .mockResolvedValueOnce(mockFetchSuccess({ plans: ['p1'] }, 200))
        .mockResolvedValueOnce(mockFetchSuccess({ id: 'p1', name: 'Custom', quota: { data: 1073741824 }, currency: 'USD', duration: 1, duration_type: 0 }, 200))
      const result = await connector.syncPlans()
      expect(result.success).toBe(true)
      expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/v2/catalog/plans?limit=100')
      expect(String(fetchSpy.mock.calls[1][0])).toContain('/api/v2/catalog/plans/p1')
    })

    it('fails with NOT_CONFIGURED when baseUrl is missing', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(makeProvider({ apiBaseUrl: null, config: { requestTimeoutMs: 15000 } }))
      const result = await connector.syncPlans()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_CONFIGURED')
    })

    it('never logs raw plan details or tokens', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      fetchSpy
        .mockResolvedValueOnce(mockFetchSuccess({ plans: ['p1'] }, 200))
        .mockResolvedValueOnce(mockFetchSuccess({ id: 'p1', name: 'No Price', quota: { data: 1073741824 }, currency: 'USD', duration: 1, duration_type: 0 }, 200))
      await connector.syncPlans()
      for (const [args] of logSpy.mock.calls as Array<[string]>) {
        const line = String(args)
        expect(line).not.toContain(RAW_TOKEN)
        expect(line).not.toContain('1GB_TEST_PLAN')
      }
      logSpy.mockRestore()
    })
  })

  describe('token masking', () => {
    it('masks tokens for safe logging', () => {
      const masked = maskToken(RAW_TOKEN)
      expect(masked).not.toContain(RAW_TOKEN)
      expect(masked.length).toBeLessThan(RAW_TOKEN.length)
    })

    it('never logs the raw token during testConnection', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      fetchSpy.mockResolvedValue(mockFetchSuccess({ data: [] }, 200))
      await connector.testConnection()
      for (const [args] of logSpy.mock.calls as Array<[string]>) {
        expect(String(args)).not.toContain(RAW_TOKEN)
      }
      logSpy.mockRestore()
    })
  })
})

describe('connector-factory registration', () => {
  it('resolves IBASIS strategy to IBASIS connector type', () => {
    expect(resolveConnectorType('IBASIS', 'CUSTOM')).toBe('IBASIS')
  })

  it('does not hijack other providers', () => {
    expect(resolveConnectorType('AIRHUB', 'CUSTOM')).toBe('AIRHUB')
    expect(resolveConnectorType('TELNA', 'CUSTOM')).toBe('TELNA')
    expect(resolveConnectorType('TELNA_SEAMLESS', 'CUSTOM')).toBe('TELNA_SEAMLESS')
    expect(resolveConnectorType('CHOICE', 'CUSTOM')).toBe('URL_TOKEN')
    expect(resolveConnectorType(null, 'MOCK')).toBe('MOCK')
  })

  it('creates an IbasisConnector for IBASIS type', () => {
    const connector = createConnector('ibasis-1', 'iBASIS', 'IBASIS', { apiBaseUrl: 'https://api.ibasis.example.com' })
    expect(connector).toBeInstanceOf(IbasisConnector)
    expect(connector.name).toBe('iBASIS')
  })
})

describe('IbasisConnector Phase 3 — subscribers', () => {
  let connector: IbasisConnector
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.provider.findUnique.mockResolvedValue(makeProvider())
    fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as any
    connector = new IbasisConnector('ibasis-1')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('createSubscriber POSTs the provider payload and returns the subscriber id', async () => {
    fetchSpy.mockResolvedValue(mockFetchSuccess({ id: 'sub-42' }, 201))
    const result = await connector.createSubscriber({ username: 'jane.doe', email: 'jane@example.com' })
    expect(result.success).toBe(true)
    expect(result.data?.providerSubscriberId).toBe('sub-42')
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/api/v1/subscribers')
    expect((init as any).method).toBe('POST')
    expect((init as any).headers['Authorization']).toBe(`Token ${RAW_TOKEN}`)
    expect(JSON.parse((init as any).body)).toEqual({ username: 'jane.doe', email: 'jane@example.com' })
  })

  it('createSubscriber fails with VALIDATION_ERROR on HTTP 400', async () => {
    fetchSpy.mockResolvedValue(mockFetchSuccess({ detail: 'invalid' }, 400))
    const result = await connector.createSubscriber({ username: 'u1' })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('VALIDATION_ERROR')
  })

  it('createSubscriber fails when id is missing from response', async () => {
    fetchSpy.mockResolvedValue(mockFetchSuccess({ ok: true }, 201))
    const result = await connector.createSubscriber({ username: 'u1' })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('PROVIDER_ERROR')
  })

  it('getSubscriber fetches and maps the subscriber', async () => {
    fetchSpy.mockResolvedValue(mockFetchSuccess({ id: 'sub-42', username: 'jane.doe', first_name: 'Jane', email: 'jane@example.com' }, 200))
    const result = await connector.getSubscriber('sub-42')
    expect(result.success).toBe(true)
    expect(result.data?.providerSubscriberId).toBe('sub-42')
    expect(result.data?.firstName).toBe('Jane')
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/v1/subscribers/sub-42')
  })

  it('getSubscriber maps HTTP 404 to NOT_FOUND', async () => {
    fetchSpy.mockResolvedValue(mockFetchSuccess({ detail: 'not found' }, 404))
    const result = await connector.getSubscriber('missing')
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_FOUND')
  })

  it('updateSubscriber PATCHes without username', async () => {
    fetchSpy.mockResolvedValue(mockFetchSuccess({ id: 'sub-42', username: 'jane.doe', email: 'new@example.com' }, 200))
    const result = await connector.updateSubscriber('sub-42', { username: 'jane.doe', email: 'new@example.com' })
    expect(result.success).toBe(true)
    const [, init] = fetchSpy.mock.calls[0]
    expect((init as any).method).toBe('PATCH')
    expect(JSON.parse((init as any).body)).toEqual({ email: 'new@example.com' })
  })

  it('searchSubscribers sends filters and parses the results page', async () => {
    fetchSpy.mockResolvedValue(mockFetchSuccess({ count: 2, next: null, previous: null, results: ['sub-1', 'sub-2'] }, 200))
    const result = await connector.searchSubscribers({ username: 'jane' })
    expect(result.success).toBe(true)
    expect(result.data?.items).toEqual(['sub-1', 'sub-2'])
    expect(result.data?.total).toBe(2)
    const url = String(fetchSpy.mock.calls[0][0])
    expect(url).toContain('/api/v1/subscribers')
    expect(url).toContain('username=jane')
  })

  it('searchSubscribers uses provider field names for filters', async () => {
    fetchSpy.mockResolvedValue(mockFetchSuccess({ count: 0, next: null, previous: null, results: [] }, 200))
    await connector.searchSubscribers({ firstName: 'Jane', lastName: 'Doe' })
    const url = String(fetchSpy.mock.calls[0][0])
    expect(url).toContain('first_name=Jane')
    expect(url).toContain('last_name=Doe')
  })

  it('searchSubscribers follows an absolute nextUrl directly', async () => {
    fetchSpy.mockResolvedValue(mockFetchSuccess({ count: 0, next: null, previous: null, results: [] }, 200))
    const next = 'https://api.ibasis.example.com/api/v1/subscribers?limit=50&offset=50'
    await connector.searchSubscribers({ nextUrl: next })
    expect(String(fetchSpy.mock.calls[0][0])).toBe(next)
  })

  it('searchSubscribers fails with normalized error on HTTP 429', async () => {
    fetchSpy.mockResolvedValue(mockFetchSuccess({ detail: 'rate limited' }, 429))
    const result = await connector.searchSubscribers({})
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('RATE_LIMIT')
  })
})

describe('IbasisConnector Phase 3 — subscriptions', () => {
  let connector: IbasisConnector
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.provider.findUnique.mockResolvedValue(makeProvider())
    fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as any
    connector = new IbasisConnector('ibasis-1')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('createSubscription POSTs subscriber/retail_plan/activation_type/devices', async () => {
    fetchSpy.mockResolvedValue(mockFetchSuccess({ id: 'act-1' }, 201))
    const result = await connector.createSubscription({
      subscriberId: 'sub-42',
      retailPlanId: '1GB_TEST_PLAN',
      devices: [{ device: '89975111967191511974', type: 'iccid' }],
    })
    expect(result.success).toBe(true)
    expect(result.data?.activationId).toBe('act-1')
    expect(result.data?.status).toBe('PENDING')
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/api/v1/subscriptions/activations')
    expect((init as any).method).toBe('POST')
    expect((init as any).headers['Authorization']).toBe(`Token ${RAW_TOKEN}`)
    expect(JSON.parse((init as any).body)).toEqual({
      subscriber: 'sub-42',
      retail_plan: '1GB_TEST_PLAN',
      activation_type: 'immediate',
      devices: [{ device: '89975111967191511974', type: 'iccid' }],
    })
  })

  it('createSubscription fails with VALIDATION_ERROR when devices are missing', async () => {
    const result = await connector.createSubscription({ subscriberId: 's1', retailPlanId: 'p1', devices: [] })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('VALIDATION_ERROR')
  })

  it('createSubscription includes service_address when provided', async () => {
    fetchSpy.mockResolvedValue(mockFetchSuccess({ id: 'act-2' }, 201))
    await connector.createSubscription({
      subscriberId: 's1',
      retailPlanId: 'p1',
      devices: [{ device: 'iccid-x', type: 'imei' }],
      serviceAddressId: 'addr-9',
    })
    const [, init] = fetchSpy.mock.calls[0]
    expect(JSON.parse((init as any).body).service_address).toBe('addr-9')
  })

  it('getSubscription maps provider status into the lifecycle', async () => {
    fetchSpy.mockResolvedValue(mockFetchSuccess({
      id: 'sub-1',
      subscriber: '42',
      plan: '1GB_TEST_PLAN',
      status: 'active',
      devices: [{ device: '89975111967191511974', type: 'iccid' }],
    }, 200))
    const result = await connector.getSubscription('sub-1')
    expect(result.success).toBe(true)
    expect(result.data?.providerSubscriptionId).toBe('sub-1')
    expect(result.data?.status).toBe('ACTIVE')
    expect(result.data?.iccid).toBe('89975111967191511974')
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/v1/subscriptions/sub-1')
  })

  it('getSubscription maps HTTP 404 to NOT_FOUND', async () => {
    fetchSpy.mockResolvedValue(mockFetchSuccess({ detail: 'not found' }, 404))
    const result = await connector.getSubscription('missing')
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_FOUND')
  })

  it('getSubscriptionStatus returns the normalized status plus linkage', async () => {
    fetchSpy.mockResolvedValue(mockFetchSuccess({
      id: 'sub-1',
      subscriber: '42',
      status: 'suspended',
      devices: [{ device: '89975111967191511974', type: 'iccid' }],
    }, 200))
    const result = await connector.getSubscriptionStatus('sub-1')
    expect(result.success).toBe(true)
    expect(result.data?.status).toBe('SUSPENDED')
    expect(result.data?.providerStatus).toBe('suspended')
    expect(result.data?.iccid).toBe('89975111967191511974')
    expect(result.data?.subscriberId).toBe('42')
  })

  it('getActivationStatus polls the activation endpoint and returns the subscription id once complete', async () => {
    fetchSpy.mockResolvedValue(mockFetchSuccess({ status: 'completed', subscription_id: 'sub-7' }, 200))
    const result = await connector.getActivationStatus('act-1')
    expect(result.success).toBe(true)
    expect(result.data?.status).toBe('READY_TO_INSTALL')
    expect(result.data?.providerSubscriptionId).toBe('sub-7')
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/v1/subscriptions/activations/act-1')
  })

  it('getActivationStatus leaves subscription id null while processing', async () => {
    fetchSpy.mockResolvedValue(mockFetchSuccess({ status: 'processing' }, 200))
    const result = await connector.getActivationStatus('act-2')
    expect(result.data?.status).toBe('PROVISIONING')
    expect(result.data?.providerSubscriptionId).toBeNull()
  })

  it('uses configured subscriber/subscription paths when provided', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(makeProvider({
      config: {
        baseUrl: 'https://api.ibasis.example.com',
        subscribersPath: '/api/v2/subscribers',
        subscriptionsPath: '/api/v2/subscriptions',
        subscriptionActivationsPath: '/api/v2/subscriptions/activations',
        requestTimeoutMs: 15000,
      },
    }))
    fetchSpy.mockResolvedValue(mockFetchSuccess({ id: 'sub-1', status: 'active' }, 200))
    await connector.getSubscription('sub-1')
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/v2/subscriptions/sub-1')
    fetchSpy.mockResolvedValue(mockFetchSuccess({ id: 'sub-1' }, 200))
    await connector.getSubscriber('sub-1')
    expect(String(fetchSpy.mock.calls[1][0])).toContain('/api/v2/subscribers/sub-1')
  })
})
