import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Provider } from '@prisma/client'
import type { ConnectorResult } from './connector-interface'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    providerPackage: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
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
import { TelnaSeamlessConnector } from './telna-seamless-connector'

const mockPrisma = vi.mocked(prisma)

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'telna-seamless-1',
    name: 'Telna SeamlessOS',
    code: 'TELNA',
    type: 'CUSTOM',
    adapterStrategy: 'TELNA_SEAMLESS',
    authType: 'bearer_token',
    tokenPlacement: 'BEARER_HEADER',
    apiVersion: '1.0',
    apiBaseUrl: 'https://api.telna.com',
    apiToken: 'enc:sls-api-key-123',
    authUrl: null,
    environment: 'production',
    status: 'ACTIVE',
    config: { environment: 'production', timeoutMs: 15000, maxRetries: 1, backoffMs: 500 },
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

describe('TelnaSeamlessConnector', () => {
  let connector: TelnaSeamlessConnector

  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.provider.findUnique.mockResolvedValue(makeProvider())
    mockPrisma.provider.update.mockResolvedValue({} as any)
    connector = new TelnaSeamlessConnector('telna-seamless-1')
  })

  describe('constructor', () => {
    it('sets providerId and name', () => {
      expect(connector.providerId).toBe('telna-seamless-1')
      expect(connector.name).toBe('Telna SeamlessOS')
    })
  })

  describe('authenticate', () => {
    it('returns UNSUPPORTED — SeamlessOS uses static API key', async () => {
      const result = await connector.authenticate({})
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('UNSUPPORTED')
    })
  })

  describe('getTokenState', () => {
    it('returns tokenPresent when API key is configured', async () => {
      const state = await connector.getTokenState()
      expect(state.tokenPresent).toBe(true)
      expect(state.expiryPresent).toBe(false)
      expect(state.expired).toBe(false)
    })

    it('returns tokenPresent=false when no API key', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(makeProvider({ apiToken: null }))
      const state = await connector.getTokenState()
      expect(state.tokenPresent).toBe(false)
    })
  })

  describe('ensureAuthenticated', () => {
    it('returns success when config is valid', async () => {
      const result = await connector.ensureAuthenticated()
      expect(result.success).toBe(true)
    })

    it('returns error when provider not found', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(null)
      const result = await connector.ensureAuthenticated()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_CONFIGURED')
    })

    it('returns error when API token is missing', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(makeProvider({ apiToken: null }))
      const result = await connector.ensureAuthenticated()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_CONFIGURED')
    })
  })

  describe('refreshAuthentication', () => {
    it('returns false — no refresh needed for static API key', async () => {
      const result = await connector.refreshAuthentication()
      expect(result).toBe(false)
    })
  })

  describe('testConnection', () => {
    it('returns success when all endpoints respond', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ items: [], pagination: {} })),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.testConnection()
      expect(result.success).toBe(true)
      expect(result.data?.health).toBeDefined()
      expect(Object.keys(result.data!.health!)).toHaveLength(3)

      vi.unstubAllGlobals()
    })

    it('returns failure when some endpoints fail', async () => {
      let callCount = 0
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount <= 1) {
          return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ items: [] })) }
        }
        return { ok: false, status: 500, text: () => Promise.resolve(JSON.stringify({ message: 'Internal error' })) }
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.testConnection()
      expect(result.success).toBe(false)
      expect(result.data?.health).toBeDefined()

      vi.unstubAllGlobals()
    })

    it('returns error when provider not configured', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(null)
      const result = await connector.testConnection()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_CONFIGURED')
    })

    it('updates provider health on success', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ items: [], pagination: {} })),
      })
      vi.stubGlobal('fetch', mockFetch)

      await connector.testConnection()
      expect(mockPrisma.provider.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'telna-seamless-1' }, data: expect.objectContaining({ lastSuccessfulConnection: expect.any(Date) }) })
      )

      vi.unstubAllGlobals()
    })

    it('updates provider error count on partial failure', async () => {
      let callCount = 0
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount <= 1) {
          return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ items: [] })) }
        }
        return { ok: false, status: 500, text: () => Promise.resolve(JSON.stringify({ message: 'Server Error' })) }
      })
      vi.stubGlobal('fetch', mockFetch)

      await connector.testConnection()
      expect(mockPrisma.provider.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'telna-seamless-1' }, data: expect.objectContaining({ errorCount: { increment: 1 } }) })
      )

      vi.unstubAllGlobals()
    })
  })

  describe('diagnoseConnection', () => {
    it('returns diagnostic info on success', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ items: [] })),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.diagnoseConnection()
      expect(result.success).toBe(true)
      expect(result.data?.connectorClass).toBe('TelnaSeamlessConnector')
      expect(result.data?.authType).toBe('API_KEY')
      expect(result.data?.tokenPlacement).toBe('HEADER')

      vi.unstubAllGlobals()
    })

    it('returns diagnostic info on failure with error', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'))
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.diagnoseConnection()
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error?.code).toBe('NETWORK_ERROR')

      vi.unstubAllGlobals()
    })
  })

  describe('syncPlans', () => {
    it('returns plans from API', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          items: [
            {
              productOfferingId: 'po-1',
              name: 'Global Data 1GB',
              status: 'ACTIVE',
              description: '1GB global data plan',
              product: {
                productId: 'p-1',
                internalName: 'GLOBAL-1GB',
                type: 'MOBILE_DATA',
                features: { dataMb: 1024 },
              },
              price: { netPrice: 9.99, currency: 'USD', priceType: 'RECURRING', billingCycle: { period: 'MONTHLY', interval: 1 } },
            },
            {
              productOfferingId: 'po-2',
              name: 'EU Data 500MB',
              status: 'ACTIVE',
              product: {
                productId: 'p-2',
                internalName: 'EU-500MB',
                type: 'MOBILE_DATA',
                features: { dataMb: 500 },
              },
              price: { netPrice: 4.99, currency: 'EUR' },
            },
          ],
          pagination: { nextCursor: null },
        })),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.syncPlans()
      expect(result.success).toBe(true)
      expect(result.data).toHaveLength(2)
      expect(result.data![0].id).toBe('po-1')
      expect(result.data![0].name).toBe('Global Data 1GB')
      expect(result.data![0].data_gb).toBe(1)
      expect(result.data![0].price_usd).toBe(9.99)
      expect(result.data![1].id).toBe('po-2')
      expect(result.data![1].data_gb).toBeCloseTo(0.488, 1)

      vi.unstubAllGlobals()
    })

    it('handles pagination', async () => {
      let callCount = 0
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return {
            ok: true, status: 200,
            text: () => Promise.resolve(JSON.stringify({
              items: [{ productOfferingId: 'po-1', name: 'Plan 1', product: { productId: 'p1', internalName: 'P1', type: 'DATA', features: { dataMb: 1024 } }, price: { netPrice: 9.99, currency: 'USD' } }],
              pagination: { nextCursor: 'cursor-abc' },
            })),
          }
        }
        return {
          ok: true, status: 200,
          text: () => Promise.resolve(JSON.stringify({
            items: [{ productOfferingId: 'po-2', name: 'Plan 2', product: { productId: 'p2', internalName: 'P2', type: 'DATA', features: { dataMb: 2048 } }, price: { netPrice: 19.99, currency: 'USD' } }],
            pagination: { nextCursor: null },
          })),
        }
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.syncPlans()
      expect(result.success).toBe(true)
      expect(result.data).toHaveLength(2)
      expect(callCount).toBe(2)

      vi.unstubAllGlobals()
    })

    it('returns error on API failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 500,
        text: () => Promise.resolve(JSON.stringify({ message: 'Internal Server Error', code: 'INTERNAL_ERROR' })),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.syncPlans()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('INTERNAL_ERROR')

      vi.unstubAllGlobals()
    })

    it('returns error when not configured', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(null)
      const result = await connector.syncPlans()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_CONFIGURED')
    })
  })

  describe('NOT_IMPLEMENTED stubs', () => {
    it('getUsage returns NOT_IMPLEMENTED', async () => {
      const result = await connector.getUsage('iccid-123')
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_IMPLEMENTED')
    })

    it('suspendESIM returns NOT_IMPLEMENTED', async () => {
      const result = await connector.suspendESIM('sub-123')
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_IMPLEMENTED')
    })

    it('resumeESIM returns NOT_IMPLEMENTED', async () => {
      const result = await connector.resumeESIM('sub-123')
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_IMPLEMENTED')
    })

    it('topUpESIM returns NOT_IMPLEMENTED', async () => {
      const result = await connector.topUpESIM({ iccid: 'iccid-123', planId: 'x', quantity: 1 })
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_IMPLEMENTED')
    })
  })

  describe('UNSUPPORTED stubs', () => {
    it('getRates returns UNSUPPORTED', async () => {
      const result = await connector.getRates()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('UNSUPPORTED')
    })
  })

  describe('HTTP error handling', () => {
    it('returns HTTP_400 for 400 responses', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 400,
        text: () => Promise.resolve(JSON.stringify({ message: 'Bad Request', code: 'INVALID_INPUT' })),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.syncPlans()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('INVALID_INPUT')

      vi.unstubAllGlobals()
    })

    it('retries on 429 and returns failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 429,
        text: () => Promise.resolve(JSON.stringify({ message: 'Rate Limited' })),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.syncPlans()
      expect(result.success).toBe(false)

      vi.unstubAllGlobals()
    })

    it('retries on 5xx and returns failure after max retries', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 502,
        text: () => Promise.resolve(JSON.stringify({ message: 'Bad Gateway' })),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.syncPlans()
      expect(result.success).toBe(false)

      vi.unstubAllGlobals()
    })

    it('handles non-JSON response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        text: () => Promise.resolve('not json at all'),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.testConnection()
      expect(result.data?.health).toBeDefined()

      vi.unstubAllGlobals()
    })

    it('handles network errors', async () => {
      const mockFetch = vi.fn().mockRejectedValue({ name: 'TypeError', message: 'fetch failed', cause: { code: 'ENOTFOUND' } })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.syncPlans()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NETWORK_ERROR')

      vi.unstubAllGlobals()
    })

    it('handles timeout errors', async () => {
      const abortError = new DOMException('Aborted', 'AbortError')
      const mockFetch = vi.fn().mockRejectedValue(abortError)
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.syncPlans()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NETWORK_ERROR')
      expect(result.error?.message).toContain('timed out')

      vi.unstubAllGlobals()
    })
  })

  describe('request configuration', () => {
    it('sends X-API-Key header and X-Idempotency-Key when provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({ items: [] })),
      })
      vi.stubGlobal('fetch', mockFetch)

      await connector.syncPlans()

      const [, options] = mockFetch.mock.calls[0]
      expect(options.headers['X-API-Key']).toBe('sls-api-key-123')
      expect(options.headers['Content-Type']).toBe('application/json')
      expect(options.headers['Accept']).toBe('application/json')

      vi.unstubAllGlobals()
    })

    it('builds URL with query params for pagination', async () => {
      let callCount = 0
      const mockFetch = vi.fn().mockImplementation((_url: string) => {
        callCount++
        if (callCount === 1) {
          return {
            ok: true, status: 200,
            text: () => Promise.resolve(JSON.stringify({
              items: [{ productOfferingId: 'po-1', name: 'P1', product: { productId: 'p1', internalName: 'P1', type: 'D', features: { dataMb: 1024 } }, price: { netPrice: 9.99, currency: 'USD' } }],
              pagination: { nextCursor: 'cursor-xyz' },
            })),
          }
        }
        return {
          ok: true, status: 200,
          text: () => Promise.resolve(JSON.stringify({ items: [], pagination: { nextCursor: null } })),
        }
      })
      vi.stubGlobal('fetch', mockFetch)

      await connector.syncPlans()

      expect(mockFetch).toHaveBeenCalledTimes(2)
      const [firstUrl] = mockFetch.mock.calls[0]
      expect(firstUrl).toContain('limit=50')
      const [secondUrl] = mockFetch.mock.calls[1]
      expect(secondUrl).toContain('cursor=cursor-xyz')

      vi.unstubAllGlobals()
    })
  })

  describe('non-JSON response in connection test', () => {
    it('still returns health check data for non-JSON responses', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        text: () => Promise.resolve(''),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.testConnection()
      expect(result.data?.health).toBeDefined()

      vi.unstubAllGlobals()
    })
  })

  describe('error logging', () => {
    it('logs request details with correlationId', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 404,
        text: () => Promise.resolve(JSON.stringify({ message: 'Not Found' })),
      })
      vi.stubGlobal('fetch', mockFetch)

      await connector.syncPlans()

      const logCalls = consoleSpy.mock.calls.map(c => String(c[0]))
      expect(logCalls.some(l => l.includes('SEAMLESS_REQUEST'))).toBe(true)

      consoleSpy.mockRestore()
      vi.unstubAllGlobals()
    })
  })

  describe('activateESIM', () => {
    const validParams = { planId: 'po-123', quantity: 1, subscriber: { email: 'test@test.com', first_name: 'Test', last_name: 'User' }, externalId: 'order-abc' }

    function makeOrderResponse(overrides: any = {}) {
      return {
        orderId: overrides.orderId || 'order-xyz',
        state: overrides.state || 'PENDING',
        lineItems: [{ type: 'SUBSCRIPTION', lineItemId: 'li-1', productOfferingId: 'po-123' }],
        ...overrides,
      }
    }

    function makeSubscriptionResponse(overrides: any = {}) {
      return {
        subscriptionId: overrides.subscriptionId || 'sub-abc',
        status: overrides.status || 'ACTIVE',
        iccid: overrides.iccid || '89012345678901234567',
        ...overrides,
      }
    }

    function makeQRResponse(overrides: any = {}) {
      return {
        qrCodeUrl: overrides.qrCodeUrl || 'https://qr.example.com/code',
        activationCode: overrides.activationCode || 'LPA:1$smdp.example.com$CODE123',
        smdpAddress: overrides.smdpAddress || 'smdp.example.com',
        matchingId: overrides.matchingId || 'MATCH-456',
        ...overrides,
      }
    }

    function okResolve(data: any) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(data)) })
    }

    it('completes full purchase flow with activation data', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'PENDING' }))) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ orderId: 'order-xyz', state: 'SUBMITTED' })) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'PROCESSING' }))) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'COMPLETED', createdEntities: { subscriptions: [{ subscriptionId: 'sub-abc', status: 'PENDING' }] } }))) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeSubscriptionResponse({ status: 'ACTIVE' }))) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeQRResponse())) })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.activateESIM(validParams)
      expect(result.success).toBe(true)
      expect(result.data?.activationId).toBe('sub-abc')
      expect(result.data?.iccids).toEqual(['89012345678901234567'])
      expect(result.data?.qrCodeUrl).toBe('https://qr.example.com/code')
      expect(result.data?.matchingId).toBe('MATCH-456')
      expect(result.data?.smdpAddress).toBe('smdp.example.com')
      expect(result.data?.activationCodes).toEqual(['LPA:1$smdp.example.com$CODE123'])
      expect(result.data?.status).toBe('ACTIVE')

      vi.unstubAllGlobals()
    })

    it('includes subscriber name from first_name + last_name', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'PENDING' }))) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ orderId: 'order-xyz', state: 'SUBMITTED' })) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'COMPLETED', createdEntities: { subscriptions: [{ subscriptionId: 'sub-abc' }] } }))) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeSubscriptionResponse())) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeQRResponse())) })
      vi.stubGlobal('fetch', mockFetch)

      await connector.activateESIM(validParams)

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.customer.name).toBe('Test User')
      expect(body.customer.email).toBe('test@test.com')

      vi.unstubAllGlobals()
    })

    it('sends idempotency key on create and submit', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'PENDING' }))) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ orderId: 'order-xyz', state: 'SUBMITTED' })) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'COMPLETED', createdEntities: { subscriptions: [{ subscriptionId: 'sub-abc' }] } }))) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeSubscriptionResponse())) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeQRResponse())) })
      vi.stubGlobal('fetch', mockFetch)

      await connector.activateESIM(validParams)

      const createHeaders = mockFetch.mock.calls[0][1].headers
      expect(createHeaders['X-Idempotency-Key']).toBe('onesim-order-abc-create-order')
      const submitHeaders = mockFetch.mock.calls[1][1].headers
      expect(submitHeaders['X-Idempotency-Key']).toBe('onesim-order-abc-submit-order')

      vi.unstubAllGlobals()
    })

    it('sends externalPayment with purchase reference', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'PENDING' }))) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ orderId: 'order-xyz', state: 'SUBMITTED' })) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'COMPLETED', createdEntities: { subscriptions: [{ subscriptionId: 'sub-abc' }] } }))) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeSubscriptionResponse())) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeQRResponse())) })
      vi.stubGlobal('fetch', mockFetch)

      await connector.activateESIM(validParams)

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.externalPayment).toEqual({ reference: 'order-abc', receiptDescription: 'OneSIM eSIM Purchase' })

      vi.unstubAllGlobals()
    })

    it('handles pending subscription without ICCID', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'PENDING' }))) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ orderId: 'order-xyz', state: 'SUBMITTED' })) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'COMPLETED', createdEntities: { subscriptions: [{ subscriptionId: 'sub-abc', status: 'PENDING' }] } }))) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeSubscriptionResponse({ status: 'PENDING', iccid: undefined }))) })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.activateESIM(validParams)
      expect(result.success).toBe(true)
      expect(result.data?.status).toBe('PENDING_ACTIVATION')
      expect(result.data?.iccids.length).toBeGreaterThan(0)

      vi.unstubAllGlobals()
    })

    it('handles cancelled order during polling', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'PENDING' }))) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ orderId: 'order-xyz', state: 'SUBMITTED' })) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'CANCELLED', failureReason: 'Insufficient inventory' }))) })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.activateESIM(validParams)
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('ORDER_CANCELLED')
      expect(result.error?.message).toContain('Insufficient inventory')

      vi.unstubAllGlobals()
    })

    it('handles failed order during polling', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'PENDING' }))) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ orderId: 'order-xyz', state: 'SUBMITTED' })) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'FAILED', failureReason: 'Payment rejected' }))) })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.activateESIM(validParams)
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('ORDER_FAILED')

      vi.unstubAllGlobals()
    })

    it('handles create order failure', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 400, text: () => Promise.resolve(JSON.stringify({ message: 'Invalid product offering', code: 'INVALID_INPUT' })) })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.activateESIM(validParams)
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('INVALID_INPUT')

      vi.unstubAllGlobals()
    })

    it('handles submit order failure', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'PENDING' }))) })
        .mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve(JSON.stringify({ message: 'Submit rejected', code: 'VALIDATION_FAILED' })) })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.activateESIM(validParams)
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('VALIDATION_FAILED')

      vi.unstubAllGlobals()
    })

    it('handles order not completing within max polls', async () => {
      vi.useFakeTimers()
      try {
        let callCount = 0
        const mockFetch = vi.fn().mockImplementation(() => {
          callCount++
          if (callCount === 1) return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'PENDING' }))) }
          if (callCount === 2) return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ orderId: 'order-xyz', state: 'SUBMITTED' })) }
          return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'PROCESSING' }))) }
        })
        vi.stubGlobal('fetch', mockFetch)

        const promise = connector.activateESIM(validParams)
        await vi.runAllTimersAsync()
        const result = await promise
        expect(result.success).toBe(false)
        expect(result.error?.code).toBe('ORDER_NOT_READY')
      } finally {
        vi.unstubAllGlobals()
        vi.useRealTimers()
      }
    })

    it('returns activation data without QR when QR endpoint fails', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'PENDING' }))) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ orderId: 'order-xyz', state: 'SUBMITTED' })) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeOrderResponse({ state: 'COMPLETED', createdEntities: { subscriptions: [{ subscriptionId: 'sub-abc' }] } }))) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(makeSubscriptionResponse())) })
        .mockResolvedValueOnce({ ok: false, status: 404, text: () => Promise.resolve(JSON.stringify({ message: 'Not found' })) })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.activateESIM(validParams)
      expect(result.success).toBe(true)
      expect(result.data?.activationId).toBe('sub-abc')
      expect(result.data?.iccids).toEqual(['89012345678901234567'])
      expect(result.data?.qrCodeUrl).toBeUndefined()

      vi.unstubAllGlobals()
    })

    it('returns error when not configured', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(null)
      const result = await connector.activateESIM(validParams)
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_CONFIGURED')
    })
  })

  describe('getStatus', () => {
    it('returns ACTIVE for active subscription', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({ subscriptionId: 'sub-abc', status: 'ACTIVE', iccid: '89012345678901234567' })),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getStatus('sub-abc')
      expect(result.success).toBe(true)
      expect(result.data?.status).toBe('ACTIVE')
      expect(result.data?.iccid).toBe('89012345678901234567')

      vi.unstubAllGlobals()
    })

    it('returns PENDING_ACTIVATION for pending subscription', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({ subscriptionId: 'sub-pending', status: 'PENDING' })),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getStatus('sub-pending')
      expect(result.success).toBe(true)
      expect(result.data?.status).toBe('PENDING_ACTIVATION')

      vi.unstubAllGlobals()
    })

    it('returns INACTIVE for cancelled subscription', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({ subscriptionId: 'sub-cancelled', status: 'CANCELLED' })),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getStatus('sub-cancelled')
      expect(result.success).toBe(true)
      expect(result.data?.status).toBe('INACTIVE')

      vi.unstubAllGlobals()
    })

    it('extracts ICCID from sim object', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({ subscriptionId: 'sub-abc', status: 'ACTIVE', sim: { iccid: '89012345678901234567' } })),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getStatus('sub-abc')
      expect(result.data?.iccid).toBe('89012345678901234567')

      vi.unstubAllGlobals()
    })

    it('returns error on HTTP failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 404,
        text: () => Promise.resolve(JSON.stringify({ message: 'Subscription not found' })),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getStatus('nonexistent')
      expect(result.success).toBe(false)

      vi.unstubAllGlobals()
    })

    it('returns error when not configured', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(null)
      const result = await connector.getStatus('sub-abc')
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_CONFIGURED')
    })
  })

  describe('getQRCode', () => {
    it('returns QR code URL on success', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({ qrCodeUrl: 'https://qr.example.com/sub-abc', activationCode: 'LPA:1$smdp$CODE', smdpAddress: 'smdp.example.com', matchingId: 'M-123' })),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getQRCode('sub-abc')
      expect(result.success).toBe(true)
      expect(result.data?.qrCodeUrl).toBe('https://qr.example.com/sub-abc')

      vi.unstubAllGlobals()
    })

    it('falls back to lpa field for QR URL', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({ lpa: 'LPA:1$smdp$CODE' })),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getQRCode('sub-abc')
      expect(result.data?.qrCodeUrl).toBe('LPA:1$smdp$CODE')

      vi.unstubAllGlobals()
    })

    it('returns error when no QR URL in response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({ status: 'PENDING' })),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getQRCode('sub-abc')
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('QR_NOT_FOUND')

      vi.unstubAllGlobals()
    })

    it('returns error on HTTP failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 404,
        text: () => Promise.resolve(JSON.stringify({ message: 'Subscription not found' })),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await connector.getQRCode('nonexistent')
      expect(result.success).toBe(false)

      vi.unstubAllGlobals()
    })

    it('returns error when not configured', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(null)
      const result = await connector.getQRCode('sub-abc')
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_CONFIGURED')
    })
  })
})
