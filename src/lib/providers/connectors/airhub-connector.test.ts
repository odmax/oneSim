import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Provider } from '@prisma/client'
import type { ActivateESIMParams } from './connector-interface'
import { DEFAULT_PROVIDER_CAPABILITIES } from '../capabilities/defaults'
import { ProviderCapability } from '../capabilities/types'

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
import { AirHubConnector } from './airhub-connector'

const mockPrisma = vi.mocked(prisma)

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'airhub-1',
    name: 'AirHub',
    code: 'AIRHUB',
    type: 'CUSTOM',
    adapterStrategy: 'CUSTOM',
    authType: 'bearer_token',
    tokenPlacement: 'BEARER_HEADER',
    apiVersion: '1.0',
    apiBaseUrl: 'https://api.airhubapp.com',
    apiToken: 'enc:encrypted-test-token',
    authUrl: null,
    environment: 'staging',
    status: 'ACTIVE',
    config: { partnerCode: 200652387, username: 'testuser', password: 'testpass', tokenExpiry: Math.floor(Date.now() / 1000) + 3600 },
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

const ACTIVATE_PARAMS: ActivateESIMParams = {
  planId: 'US-5GB-30D',
  quantity: 1,
  subscriber: { email: 'test@example.com', first_name: 'Test', last_name: 'User' },
  externalId: 'order-123',
}

let fetchSpy: ReturnType<typeof vi.fn>
const originalFetch = globalThis.fetch

beforeEach(() => {
  fetchSpy = vi.fn()
  globalThis.fetch = fetchSpy as any
  mockPrisma.provider.findUnique.mockResolvedValue(makeProvider())
  mockPrisma.provider.update.mockResolvedValue(makeProvider())
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function mockFetchSuccess(body: any, status = 200) {
  fetchSpy.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: { get: () => 'application/json' },
  })
}

function mockFetchFailure(status: number, body: any) {
  fetchSpy.mockResolvedValue({
    ok: false,
    status,
    statusText: 'Error',
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: { get: () => 'application/json' },
  })
}

function mockFetchNetworkError(causeCode: string) {
  fetchSpy.mockRejectedValue(Object.assign(new Error('fetch failed'), { cause: { code: causeCode } }))
}

describe('AirHubConnector', () => {
  describe('activateESIM', () => {
    it('returns success with ICCIDs on valid purchase response', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: {
          orderId: 'AH-789',
          iccids: ['8901234567890123456'],
          qrCodeUrl: 'https://qr.airhub.com/12345',
          status: 'ACTIVATED',
        },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      expect(result.data?.activationId).toBe('AH-789')
      expect(result.data?.iccids).toEqual(['8901234567890123456'])
      expect(result.data?.status).toBe('PENDING_ACTIVATION')
      expect(result.data?.qrCodeUrl).toBe('https://qr.airhub.com/12345')
      expect(result.data?.iccidOrSimId).toBe('8901234567890123456')

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url, opts] = fetchSpy.mock.calls[0]
      expect(url).toBe('https://api.airhubapp.com/api/ESIM/PurhaseSim')
      expect(opts.method).toBe('POST')
      expect(opts.headers['Authorization']).toBe('Bearer test-token')
      expect(opts.headers['Content-Type']).toBe('application/json')
      expect(opts.headers['Accept']).toBe('application/json')
      const body = JSON.parse(opts.body)
      expect(body).toEqual({
        partnerCode: '200652387',
        planCode: 'US-5GB-30D',
        unique_order_id: 'order-123',
      })
      expect(body.quantity).toBeUndefined()
      expect(body.email).toBeUndefined()
    })

    it('handles response with ICCIDs at top level (no data wrapper)', async () => {
      mockFetchSuccess({
        isSuccess: true,
        orderId: 'AH-TOP',
        iccids: ['8901234567890999999'],
        status: 'Success',
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      expect(result.data?.iccids).toEqual(['8901234567890999999'])
      expect(result.data?.status).toBe('PENDING_ACTIVATION')
    })

    it('handles single iccid string at root level', async () => {
      mockFetchSuccess({
        isSuccess: true,
        orderId: 'AH-SINGLE',
        iccid: '8901234567890111111',
        status: 'ACTIVATED',
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      expect(result.data?.iccids).toEqual(['8901234567890111111'])
    })

    it('returns PROCESSING status when no ICCIDs but status is pending', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: {
          orderId: 'AH-PEND',
          status: 'PROCESSING',
        },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      expect(result.data?.iccids).toEqual([])
      expect(result.data?.status).toBe('PROCESSING')
    })

    it('returns PENDING status when status is INITIATED', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: {
          orderId: 'AH-INIT',
          status: 'INITIATED',
        },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      expect(result.data?.status).toBe('PENDING')
    })

    it('returns NO_ICCIDS error when response has no ICCIDs and no pending status', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: {
          orderId: 'AH-NOPE',
          status: 'FAILED',
        },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NO_ICCIDS')
    })

    it('fetches QR code separately when not in purchase response', async () => {
      const purchaseResponse = {
        isSuccess: true,
        data: {
          orderId: 'AH-QR',
          iccids: ['8901234567890123456'],
          status: 'ACTIVATED',
        },
      }
      const qrResponse = {
        isSuccess: true,
        data: { qrCodeUrl: 'https://qr.airhub.com/12345' },
      }

      fetchSpy
        .mockResolvedValueOnce({
          ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(purchaseResponse)),
          headers: { get: () => 'application/json' },
        })
        .mockResolvedValueOnce({
          ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(qrResponse)),
          headers: { get: () => 'application/json' },
        })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      expect(result.data?.qrCodeUrl).toBe('https://qr.airhub.com/12345')
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(fetchSpy.mock.calls[1][0]).toContain('/api/ESIM/GetActivationCode')
    })

    it('returns QR from purchase response when present', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: {
          orderId: 'AH-QR2',
          iccids: ['8901234567890123456'],
          qrCodeUrl: 'https://qr.airhub.com/embedded',
          status: 'ACTIVATED',
        },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      expect(result.data?.qrCodeUrl).toBe('https://qr.airhub.com/embedded')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('returns AIRHUB_AUTH_UNAUTHORIZED on purchase 401 with failed refresh', async () => {
      mockFetchFailure(401, { message: 'Unauthorized' })

      mockPrisma.provider.findUnique.mockResolvedValue(
        makeProvider({ config: { partnerCode: 200652387 } })
      )

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('AIRHUB_AUTH_UNAUTHORIZED')
      expect(result.error?.message).toContain('401')
      expect(result.error?.details?.authStage).toBe('purchase_token_rejected')
    })

    it('returns AIRHUB_AUTH_UNAUTHORIZED on purchase 401 with non-JSON body', async () => {
      fetchSpy.mockResolvedValue({
        ok: false, status: 401, text: () => Promise.resolve('<html>Unauthorized</html>'),
        headers: { get: () => 'text/html' },
      })

      mockPrisma.provider.findUnique.mockResolvedValue(
        makeProvider({ config: { partnerCode: 200652387 } })
      )

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('AIRHUB_AUTH_UNAUTHORIZED')
      expect(result.error?.message).toContain('401')
    })

    it('retries after 401 when refresh succeeds', async () => {
      const authBody = {
        isSuccess: true,
        token: 'refreshed-token-abcdef',
        partnerCode: 200652387,
      }
      const purchaseBody = {
        isSuccess: true,
        data: {
          orderId: 'AH-RETRY',
          iccids: ['8901234567890666666'],
          qrCodeUrl: 'https://qr.airhub.com/retry',
          status: 'ACTIVATED',
        },
      }

      fetchSpy
        .mockResolvedValueOnce({
          ok: false, status: 401, text: () => Promise.resolve(JSON.stringify({ message: 'Unauthorized' })),
          headers: { get: () => 'application/json' },
        })
        .mockResolvedValueOnce({
          ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(authBody)),
          headers: { get: () => 'application/json' },
        })
        .mockResolvedValueOnce({
          ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(purchaseBody)),
          headers: { get: () => 'application/json' },
        })

      mockPrisma.provider.findUnique
        .mockResolvedValueOnce(makeProvider())
        .mockResolvedValueOnce(makeProvider())
        .mockResolvedValueOnce(makeProvider())

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      expect(result.data?.iccids).toEqual(['8901234567890666666'])
      expect(fetchSpy).toHaveBeenCalledTimes(3)
    })

    it('authenticates before the first purchase call when no token exists and sends the fresh token directly', async () => {
      const authBody = {
        isSuccess: true,
        token: 'fresh-token-abcdef',
        partnerCode: 200652387,
      }
      const purchaseBody = {
        isSuccess: true,
        data: { orderId: 'AH-FRESH', iccids: ['8901234567890777777'], qrCodeUrl: 'https://qr.airhub.com/fresh', status: 'ACTIVATED' },
      }

      fetchSpy
        .mockResolvedValueOnce({
          ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(authBody)),
          headers: { get: () => 'application/json' },
        })
        .mockResolvedValueOnce({
          ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(purchaseBody)),
          headers: { get: () => 'application/json' },
        })

      mockPrisma.provider.findUnique.mockResolvedValue(makeProvider({ apiToken: null }))
      mockPrisma.provider.update.mockResolvedValue(makeProvider({ apiToken: 'enc:fresh-token-abcdef' }))

      const connector = new AirHubConnector('airhub-1')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(fetchSpy.mock.calls[0][0]).toContain('/api/Authentication/UserLogin')
      const loginBody = JSON.parse(fetchSpy.mock.calls[0][1].body)
      expect(loginBody).toEqual({ userName: 'testuser', password: 'testpass' })
      const [purchaseUrl, purchaseOpts] = fetchSpy.mock.calls[1]
      expect(purchaseUrl).toContain('/api/ESIM/PurhaseSim')
      expect(purchaseOpts.headers['Authorization']).toBe('Bearer fresh-token-abcdef')
      expect(mockPrisma.provider.update).toHaveBeenCalled()
    })

    it('reuses a valid persisted token from the DB without re-authenticating', async () => {
      mockPrisma.provider.update.mockClear()
      mockFetchSuccess({
        isSuccess: true,
        data: { orderId: 'AH-PERSIST', iccids: ['8901234567890888888'], qrCodeUrl: 'https://qr.airhub.com/persist', status: 'ACTIVATED' },
      })

      mockPrisma.provider.findUnique.mockResolvedValue(makeProvider({ apiToken: 'enc:persisted-token-xyz' }))

      const connector = new AirHubConnector('airhub-1')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url, opts] = fetchSpy.mock.calls[0]
      expect(url).toContain('/api/ESIM/PurhaseSim')
      expect(opts.headers['Authorization']).toBe('Bearer persisted-token-xyz')
      expect(mockPrisma.provider.update).not.toHaveBeenCalled()
    })

    it('logs sanitized validation field names and messages on HTTP 400', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: () => Promise.resolve(JSON.stringify({
          type: 'https://tools.ietf.org/html/rfc7231#section-6.5.1',
          title: 'One or more validation errors occurred.',
          status: 400,
          traceId: '00-abc-def-00',
          errors: { TravelDate: ['The TravelDate field is required.'] },
        })),
        headers: { get: () => 'application/json' },
      })

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)
      const logs = logSpy.mock.calls.map(c => String(c[0])).join('\n')

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('VALIDATION_ERROR')
      expect(result.error?.message).toBe('AirHub validation failed: TravelDate — The TravelDate field is required.')
      expect(logs).toContain('[AIRHUB_PURCHASE_VALIDATION]')
      expect(logs).toContain('fields=TravelDate')
      expect(logs).toContain('messages=The TravelDate field is required.')
      expect(logs).not.toContain('00-abc-def-00')
      expect(logs).not.toContain('test-token')
      logSpy.mockRestore()
    })

    it('returns INSUFFICIENT_BALANCE on 402', async () => {
      mockFetchFailure(402, { message: 'Insufficient wallet balance' })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('INSUFFICIENT_BALANCE')
    })

    it('returns VALIDATION_ERROR on 400', async () => {
      mockFetchFailure(400, { message: 'Invalid plan code' })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('VALIDATION_ERROR')
    })

    it('returns RATE_LIMITED on 429', async () => {
      mockFetchFailure(429, { message: 'Rate limit exceeded' })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('RATE_LIMITED')
    })

    it('returns PROVIDER_UNAVAILABLE on 500', async () => {
      mockFetchFailure(500, { message: 'Internal server error' })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('PROVIDER_UNAVAILABLE')
    })

    it('classifies provider-level errors from message content', async () => {
      mockFetchSuccess({
        isSuccess: false,
        message: 'Insufficient wallet balance for this order',
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('INSUFFICIENT_BALANCE')
    })

    it('classifies INVALID_PACKAGE error', async () => {
      mockFetchSuccess({
        isSuccess: false,
        message: 'Plan package not found for given SKU',
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('INVALID_PACKAGE')
    })

    it('classifies DUPLICATE_REQUEST error', async () => {
      mockFetchSuccess({
        isSuccess: false,
        message: 'Order already exists for this transaction',
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('DUPLICATE_REQUEST')
    })

    it('returns PROVIDER_RESPONSE_INVALID on non-JSON response', async () => {
      fetchSpy.mockResolvedValue({
        ok: true, status: 200, text: () => Promise.resolve('<html><body>Error</body></html>'),
        headers: { get: () => 'text/html' },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('PROVIDER_RESPONSE_INVALID')
    })

    it('returns TIMEOUT on AbortError', async () => {
      fetchSpy.mockImplementation(() => {
        const err = new DOMException('The operation was aborted', 'AbortError')
        return Promise.reject(err)
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('TIMEOUT')
    })

    it('returns NETWORK_ERROR on DNS failure', async () => {
      mockFetchNetworkError('ENOTFOUND')

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NETWORK_ERROR')
      expect(result.error?.message).toContain('host not found')
    })

    it('returns NETWORK_ERROR on connection refused', async () => {
      mockFetchNetworkError('ECONNREFUSED')

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NETWORK_ERROR')
      expect(result.error?.message).toContain('refused')
    })

    it('returns NOT_FOUND when provider does not exist', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(null)

      const connector = new AirHubConnector('missing', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_FOUND')
    })

    it('returns AIRHUB_CREDENTIALS_MISSING when no token and no stored credentials', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(
        makeProvider({ apiToken: null, config: { partnerCode: 200652387 } })
      )

      const connector = new AirHubConnector('airhub-1', null)
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('AIRHUB_CREDENTIALS_MISSING')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('extracts activation code and smdpAddress from response', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: {
          orderId: 'AH-META',
          iccids: ['8901234567890123456'],
          activationCode: '1$smdp.example.com$ACT-CODE-123',
          smdpAddress: 'smdp.example.com',
          matchingId: 'MATCH-456',
          status: 'ACTIVATED',
        },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      expect(result.data?.activationCodes).toEqual(['1$smdp.example.com$ACT-CODE-123'])
      expect(result.data?.smdpAddress).toBe('smdp.example.com')
      expect(result.data?.matchingId).toBe('MATCH-456')
    })

    it('accepts quantity internally but never serializes it to AirHub', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: {
          orderId: 'AH-MULTI',
          iccids: ['8901234567890000001', '8901234567890000002'],
          status: 'ACTIVATED',
        },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM({ ...ACTIVATE_PARAMS, quantity: 2 })

      expect(result.success).toBe(true)
      expect(result.data?.iccids).toHaveLength(2)
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
      expect(body.quantity).toBeUndefined()
      expect(Object.keys(body).sort()).toEqual(['partnerCode', 'planCode', 'unique_order_id'])
    })

    it('extracts nested data.data ICCIDs', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: {
          data: {
            iccids: ['8901234567890777777'],
            orderId: 'AH-NEST',
          },
          status: 'ACTIVATED',
        },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      expect(result.data?.iccids).toEqual(['8901234567890777777'])
    })

    it('handles response with esim.iccids path', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: {
          esim: {
            iccids: ['8901234567890888888'],
          },
          orderId: 'AH-ESIM',
          status: 'ACTIVATED',
        },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      expect(result.data?.iccids).toEqual(['8901234567890888888'])
    })

    it('includes details with retryable and providerStatus on HTTP errors', async () => {
      mockFetchFailure(503, { message: 'Service unavailable' })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.details).toBeDefined()
      expect(result.error?.details?.retryable).toBe(true)
      expect(result.error?.details?.providerStatus).toBe(503)
    })

    it('includes travelDate in the payload when a valid YYYY-MM-DD is provided', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { orderId: 'AH-DATE', iccids: ['8901234567890123456'], status: 'ACTIVATED' },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM({ ...ACTIVATE_PARAMS, travelDate: '2026-08-02' } as ActivateESIMParams & { travelDate: string })

      expect(result.success).toBe(true)
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
      expect(body.travelDate).toBe('2026-08-02')
      expect(Object.keys(body).sort()).toEqual(['partnerCode', 'planCode', 'travelDate', 'unique_order_id'])
    })

    it('sends travelDate: "2026-08-05" in the final AirHub payload when received', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { orderId: 'AH-DATE2', iccids: ['8901234567890123456'], status: 'ACTIVATED' },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM({ ...ACTIVATE_PARAMS, travelDate: '2026-08-05' } as ActivateESIMParams & { travelDate: string })

      expect(result.success).toBe(true)
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
      expect(body.travelDate).toBe('2026-08-05')
      expect(Object.keys(body).sort()).toEqual(['partnerCode', 'planCode', 'travelDate', 'unique_order_id'])
      expect(body.TravelDate).toBeUndefined()
      expect(body.travel_date).toBeUndefined()
      expect(body.quantity).toBeUndefined()
      expect(body.email).toBeUndefined()
    })

    it('omits travelDate entirely when it is undefined', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { orderId: 'AH-NODATE', iccids: ['8901234567890123456'], status: 'ACTIVATED' },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
      expect('travelDate' in body).toBe(false)
    })

    it('omits travelDate entirely when it is an empty string', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { orderId: 'AH-EMPTYDATE', iccids: ['8901234567890123456'], status: 'ACTIVATED' },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM({ ...ACTIVATE_PARAMS, travelDate: '' } as ActivateESIMParams & { travelDate: string })

      expect(result.success).toBe(true)
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
      expect('travelDate' in body).toBe(false)
    })

    it('rejects an invalid travelDate before making any HTTP request', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { orderId: 'AH-BADDATE', iccids: ['8901234567890123456'], status: 'ACTIVATED' },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM({ ...ACTIVATE_PARAMS, travelDate: '2026/08/02' } as ActivateESIMParams & { travelDate: string })

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('AIRHUB_TRAVEL_DATE_INVALID')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('rejects a locale-formatted travelDate (DD-MM-YYYY) before HTTP', async () => {
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM({ ...ACTIVATE_PARAMS, travelDate: '02-08-2026' } as ActivateESIMParams & { travelDate: string })

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('AIRHUB_TRAVEL_DATE_INVALID')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('rejects a missing planCode before making any HTTP request', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(makeProvider())

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM({ ...ACTIVATE_PARAMS, planId: '' })

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('AIRHUB_PLAN_CODE_MISSING')
      expect(result.error?.message).toContain('planCode is required')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('generates a unique_order_id fallback when none is provided', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { orderId: 'AH-OID', iccids: ['8901234567890123456'], status: 'ACTIVATED' },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM({ ...ACTIVATE_PARAMS, externalId: undefined })

      expect(result.success).toBe(true)
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
      expect(typeof body.unique_order_id).toBe('string')
      expect(body.unique_order_id).toMatch(/^onesim-/)
    })

    it('parses ASP.NET 400 validation bodies and surfaces the failing field', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: () => Promise.resolve(JSON.stringify({
          type: 'https://tools.ietf.org/html/rfc7231#section-6.5.1',
          title: 'One or more validation errors occurred.',
          status: 400,
          traceId: '00-abc-def-00',
          errors: { planCode: ['The planCode field is required.'], travelDate: ['The travelDate field is invalid.'] },
        })),
        headers: { get: () => 'application/json' },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('VALIDATION_ERROR')
      expect(result.error?.message).toBe('AirHub validation failed: planCode — The planCode field is required.')
      expect(result.error?.details?.retryable).toBe(false)
      expect(result.error?.details?.providerStatus).toBe(400)
      expect(result.error?.details?.fields).toEqual({
        planCode: ['The planCode field is required.'],
        travelDate: ['The travelDate field is invalid.'],
      })
      expect(result.error?.message).not.toContain('traceId')
      expect(result.error?.message).not.toContain('00-abc-def-00')
    })

    it('returns VALIDATION_ERROR for a non-JSON HTTP 400 response', async () => {
      fetchSpy.mockResolvedValue({
        ok: false, status: 400, statusText: 'Bad Request',
        text: () => Promise.resolve('<html>Bad Request</html>'),
        headers: { get: () => 'text/html' },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('VALIDATION_ERROR')
      expect(result.error?.message).toContain('non-JSON')
      expect(result.error?.details?.providerStatus).toBe(400)
    })

    it('never reports ACTIVE from a purchase response', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { orderId: 'AH-ACTIVE', iccids: ['8901234567890123456'], status: 'ACTIVE' },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      expect(result.data?.status).toBe('PENDING_ACTIVATION')
      expect(result.data?.status).not.toBe('ACTIVE')
    })

    it('extracts simID into iccidOrSimId and sanitized rawMetadata', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: {
          orderId: 'AH-SIM',
          iccids: ['8901234567890123456'],
          simID: 'SIM-001',
          activationCode: '1$smdp.example.com$CODE',
          apn: 'airhub.io',
          message: 'success',
          status: 'ACTIVATED',
        },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      expect(result.data?.iccidOrSimId).toBe('SIM-001')
      expect(result.data?.activationCodes).toEqual(['1$smdp.example.com$CODE'])
      expect(result.data?.rawMetadata).toEqual({
        orderId: 'AH-SIM',
        simId: 'SIM-001',
        activationCode: '1$smdp.example.com$CODE',
        apn: 'airhub.io',
        message: 'success',
      })
    })

    it('logs pre-flight diagnostics without leaking token, credentials, or payload values', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { orderId: 'AH-LOG', iccids: ['8901234567890123456'], status: 'ACTIVATED' },
      })

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      const logs = logSpy.mock.calls.map(c => String(c[0])).join('\n')
      expect(logs).toContain('[AIRHUB_PURCHASE_REQUEST]')
      expect(logs).toContain('authorizationPresent=true')
      expect(logs).not.toContain('test-token')
      expect(logs).not.toContain('testpass')
      expect(logs).not.toContain('US-5GB-30D')
      expect(logs).not.toContain('order-123')
      logSpy.mockRestore()
    })
  })

  describe('activateESIM environment guard', () => {
    it('refuses purchase when upstreamEnvironment=production but host looks staging', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(
        makeProvider({
          apiBaseUrl: 'https://staging.airhubapp.com',
          config: { partnerCode: 200652387, username: 'testuser', password: 'testpass', upstreamEnvironment: 'production' },
        })
      )

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('AIRHUB_ENV_MISMATCH')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('refuses purchase when upstreamEnvironment=staging but host is production api.airhubapp.com', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(
        makeProvider({
          apiBaseUrl: 'https://api.airhubapp.com',
          config: { partnerCode: 200652387, username: 'testuser', password: 'testpass', upstreamEnvironment: 'staging' },
        })
      )

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('AIRHUB_ENV_MISMATCH')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('allows purchase when upstreamEnvironment matches the host', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { orderId: 'AH-OK', iccids: ['8901234567890123456'], qrCodeUrl: 'https://qr.airhub.com/ok', status: 'ACTIVATED' },
      })

      mockPrisma.provider.findUnique.mockResolvedValue(
        makeProvider({
          config: { partnerCode: 200652387, username: 'testuser', password: 'testpass', upstreamEnvironment: 'production' },
        })
      )

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('authenticate', () => {
    it('returns AIRHUB_AUTH_UNAUTHORIZED on login 401', async () => {
      fetchSpy.mockResolvedValue({
        ok: false, status: 401, text: () => Promise.resolve('<html>Invalid login</html>'),
        headers: { get: () => 'text/html' },
      })

      mockPrisma.provider.findUnique.mockResolvedValue(makeProvider())

      const connector = new AirHubConnector('airhub-1', null)
      const result = await connector.authenticate({ username: 'baduser', password: 'badpass' })

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('AIRHUB_AUTH_UNAUTHORIZED')
      expect(result.error?.details?.authStage).toBe('login')
      expect(fetchSpy.mock.calls[0][0]).toContain('/api/Authentication/UserLogin')
    })

    it('returns AIRHUB_CREDENTIALS_MISSING without making an HTTP request', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(makeProvider())

      const connector = new AirHubConnector('airhub-1', null)
      const result = await connector.authenticate({ username: '', password: '' })

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('AIRHUB_CREDENTIALS_MISSING')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('refuses login when upstreamEnvironment=production but host looks staging', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(
        makeProvider({
          apiBaseUrl: 'https://staging.airhubapp.com',
          config: { upstreamEnvironment: 'production' },
        })
      )

      const connector = new AirHubConnector('airhub-1', null)
      const result = await connector.authenticate({ username: 'testuser', password: 'testpass' })

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('AIRHUB_ENV_MISMATCH')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('logs safe response metadata without leaking the token', async () => {
      mockFetchSuccess({
        isSuccess: true,
        token: 'super-secret-token-abc123',
        partnerCode: 200652387,
      })

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      mockPrisma.provider.findUnique.mockResolvedValue(makeProvider())
      mockPrisma.provider.update.mockResolvedValue(makeProvider())

      const connector = new AirHubConnector('airhub-1', null)
      const result = await connector.authenticate({ username: 'testuser', password: 'testpass' })

      expect(result.success).toBe(true)
      const logs = logSpy.mock.calls.map(c => String(c[0])).join('\n')
      expect(logs).not.toContain('super-secret-token-abc123')
      expect(logs).not.toContain('testpass')
      expect(logs).toContain('[AIRHUB_AUTH_RESULT]')
      logSpy.mockRestore()
    })

    it('persists the token and updates config after successful login', async () => {
      mockFetchSuccess({
        isSuccess: true,
        token: 'fresh-token-abcdef',
        partnerCode: 200652387,
      })

      mockPrisma.provider.findUnique.mockResolvedValue(makeProvider({ apiToken: null }))

      const connector = new AirHubConnector('airhub-1', null)
      const result = await connector.authenticate({ username: 'testuser', password: 'testpass' })

      expect(result.success).toBe(true)
      expect(result.data?.token).toBe('fresh-token-abcdef')
      expect(mockPrisma.provider.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'airhub-1' },
          data: expect.objectContaining({
            apiToken: 'enc:fresh-token-abcdef',
            tokenPlacement: 'BEARER_HEADER',
          }),
        })
      )
    })
  })

  describe('syncPlans travel-date metadata', () => {
    it('persists __requiresTravelDate=true when the plan mandates a travel date', async () => {
      mockFetchSuccess({
        isSuccess: true,
        getInformation: [
          { planCode: 'US-5GB-30D', planName: 'US 5GB', capacity: '5', capacityUnit: 'GB', validity: '30', price: 10, currency: 'USD', countryName: 'United States', isTravelDateRequired: 'Mandatory' },
        ],
      })
      mockPrisma.providerPackage.findFirst.mockResolvedValue(null)
      mockPrisma.providerPackage.findMany.mockResolvedValue([
        { id: 'pp-1', name: 'US 5GB', dataGB: 5, validityDays: 30, costPrice: 10, currency: 'USD', providerPlanCode: 'US-5GB-30D', providerRawData: { planCode: 'US-5GB-30D', isTravelDateRequired: 'Mandatory', __requiresTravelDate: true } },
      ] as any)

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.syncPlans()

      expect(result.success).toBe(true)
      const created = mockPrisma.providerPackage.create.mock.calls.at(-1)![0].data
      expect(created.providerRawData.__requiresTravelDate).toBe(true)
      expect(result.data?.[0].requiresTravelDate).toBe(true)
    })

    it('persists __requiresTravelDate=false when the plan does not require a travel date', async () => {
      mockFetchSuccess({
        isSuccess: true,
        getInformation: [
          { planCode: 'UK-3GB-7D', planName: 'UK 3GB', capacity: '3', capacityUnit: 'GB', validity: '7', price: 8, currency: 'USD', countryName: 'United Kingdom', isTravelDateRequired: 'No Need' },
        ],
      })
      mockPrisma.providerPackage.findFirst.mockResolvedValue(null)
      mockPrisma.providerPackage.findMany.mockResolvedValue([
        { id: 'pp-2', name: 'UK 3GB', dataGB: 3, validityDays: 7, costPrice: 8, currency: 'USD', providerPlanCode: 'UK-3GB-7D', providerRawData: { planCode: 'UK-3GB-7D', isTravelDateRequired: 'No Need', __requiresTravelDate: false } },
      ] as any)

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.syncPlans()

      expect(result.success).toBe(true)
      const created = mockPrisma.providerPackage.create.mock.calls.at(-1)![0].data
      expect(created.providerRawData.__requiresTravelDate).toBe(false)
      expect(result.data?.[0].requiresTravelDate).toBe(false)
    })

    it('defaults to false when the plan has no travel-date indicator (never invents a requirement)', async () => {
      mockFetchSuccess({
        isSuccess: true,
        getInformation: [
          { planCode: 'GB-1GB-7D', planName: 'GB 1GB', capacity: '1', capacityUnit: 'GB', validity: '7', price: 5, currency: 'USD', countryName: 'UK' },
        ],
      })
      mockPrisma.providerPackage.findFirst.mockResolvedValue(null)
      mockPrisma.providerPackage.findMany.mockResolvedValue([
        { id: 'pp-3', name: 'GB 1GB', dataGB: 1, validityDays: 7, costPrice: 5, currency: 'USD', providerPlanCode: 'GB-1GB-7D', providerRawData: { planCode: 'GB-1GB-7D', __requiresTravelDate: false } },
      ] as any)

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.syncPlans()

      expect(result.success).toBe(true)
      const created = mockPrisma.providerPackage.create.mock.calls.at(-1)![0].data
      expect(created.providerRawData.__requiresTravelDate).toBe(false)
      expect(result.data?.[0].requiresTravelDate).toBe(false)
    })
  })

  describe('validatePurchase', () => {
    it('passes when token is present even without credentials', async () => {      mockPrisma.provider.findUnique.mockResolvedValue(
        makeProvider({ apiToken: 'enc:existing-token', config: { partnerCode: 200652387 } })
      )

      const connector = new AirHubConnector('airhub-1', null)
      const result = await connector.validatePurchase(ACTIVATE_PARAMS)

      expect(result.valid).toBe(true)
    })

    it('fails when neither credentials nor token are present', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(
        makeProvider({ apiToken: null, config: { partnerCode: 200652387 } })
      )

      const connector = new AirHubConnector('airhub-1', null)
      const result = await connector.validatePurchase(ACTIVATE_PARAMS)

      expect(result.valid).toBe(false)
      expect(result.reason).toContain('Credentials')
    })
  })

  describe('getTokenState', () => {
    it('invalidates a token minted under a different environment', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(
        makeProvider({
          apiToken: 'enc:old-env-token',
          config: { tokenExpiry: Math.floor(Date.now() / 1000) + 3600, authEnvironmentAtAuth: 'staging', upstreamEnvironment: 'production' },
        })
      )

      const connector = new AirHubConnector('airhub-1', null)
      const state = await connector.getTokenState()

      expect(state.tokenPresent).toBe(true)
      expect(state.expired).toBe(true)
    })

    it('keeps a token valid when environment is unchanged', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(
        makeProvider({
          config: { tokenExpiry: Math.floor(Date.now() / 1000) + 3600, authEnvironmentAtAuth: 'production', upstreamEnvironment: 'production' },
        })
      )

      const connector = new AirHubConnector('airhub-1', null)
      const state = await connector.getTokenState()

      expect(state.tokenPresent).toBe(true)
      expect(state.expired).toBe(false)
      expect(state.expiresSoon).toBe(false)
    })
  })

  describe('getStatus', () => {
    it('returns ACTIVE status for activated order', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { status: 'ACTIVATED', iccid: '8901234567890123456' },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.getStatus('AH-789')

      expect(result.success).toBe(true)
      expect(result.data?.status).toBe('PENDING_ACTIVATION')
      expect(result.data?.iccid).toBe('8901234567890123456')

      const [url, opts] = fetchSpy.mock.calls[0]
      expect(url).toContain('/api/ESIM/OrderDetails')
      expect(JSON.parse(opts.body).orderId).toBe('AH-789')
    })

    it('returns PROCESSING status', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { status: 'QUEUED' },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.getStatus('AH-PEND')

      expect(result.success).toBe(true)
      expect(result.data?.status).toBe('PROCESSING')
    })

    it('returns error on HTTP failure', async () => {
      mockFetchFailure(404, { message: 'Order not found' })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.getStatus('AH-MISSING')

      expect(result.success).toBe(false)
      expect(result.error?.code).toContain('404')
    })

    it('returns error on provider rejection', async () => {
      mockFetchSuccess({
        isSuccess: false,
        message: 'Invalid order ID',
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.getStatus('AH-BAD')

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('PROVIDER_REJECTED')
    })

    it('returns TIMEOUT on abort', async () => {
      fetchSpy.mockImplementation(() => {
        return Promise.reject(new DOMException('aborted', 'AbortError'))
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.getStatus('AH-SLOW')

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('TIMEOUT')
    })

    it('returns NOT_FOUND when provider is missing', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(null)

      const connector = new AirHubConnector('missing', 'test-token')
      const result = await connector.getStatus('AH-789')

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_FOUND')
    })

    it('handles non-JSON response gracefully', async () => {
      fetchSpy.mockResolvedValue({
        ok: true, status: 200, text: () => Promise.resolve('not json at all'),
        headers: { get: () => 'text/plain' },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.getStatus('AH-789')

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('PROVIDER_RESPONSE_INVALID')
    })
  })

  describe('getQRCode', () => {
    it('returns QR code URL for valid ICCID', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { qrCodeUrl: 'https://qr.airhub.com/activation/12345' },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.getQRCode('8901234567890123456')

      expect(result.success).toBe(true)
      expect(result.data?.qrCodeUrl).toBe('https://qr.airhub.com/activation/12345')

      const [url, opts] = fetchSpy.mock.calls[0]
      expect(url).toContain('/api/ESIM/GetActivationCode')
      expect(JSON.parse(opts.body).iccid).toBe('8901234567890123456')
    })

    it('handles multiple possible QR code field names', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { qr_code_url: 'https://qr.airhub.com/alt-path' },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.getQRCode('8901234567890123456')

      expect(result.success).toBe(true)
      expect(result.data?.qrCodeUrl).toBe('https://qr.airhub.com/alt-path')
    })

    it('falls back to activationCode if no explicit QR field', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { activationCode: '1$smdp.example.com$CODE-999' },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.getQRCode('8901234567890123456')

      expect(result.success).toBe(true)
      expect(result.data?.qrCodeUrl).toBe('1$smdp.example.com$CODE-999')
    })

    it('returns NO_QR_CODE when response has no QR data', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { someOtherField: 'value' },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.getQRCode('8901234567890123456')

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NO_QR_CODE')
    })

    it('returns error on HTTP failure', async () => {
      mockFetchFailure(400, { message: 'Invalid ICCID' })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.getQRCode('8901234567890123456')

      expect(result.success).toBe(false)
      expect(result.error?.code).toContain('400')
    })

    it('returns error on provider rejection', async () => {
      mockFetchSuccess({
        isSuccess: false,
        message: 'ICCID not found in system',
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.getQRCode('8901234567890123456')

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('PROVIDER_REJECTED')
    })

    it('returns TIMEOUT on abort', async () => {
      fetchSpy.mockImplementation(() => {
        return Promise.reject(new DOMException('aborted', 'AbortError'))
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.getQRCode('8901234567890123456')

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('TIMEOUT')
    })

    it('returns NOT_FOUND when provider is missing', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(null)

      const connector = new AirHubConnector('missing', 'test-token')
      const result = await connector.getQRCode('8901234567890123456')

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_FOUND')
    })

    it('returns NO_TOKEN when token is missing', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(
        makeProvider({ apiToken: null, config: { partnerCode: 200652387 } })
      )

      const connector = new AirHubConnector('airhub-1', null)
      const result = await connector.getQRCode('8901234567890123456')

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NO_TOKEN')
    })

    it('handles nested data.data response for QR', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: {
          data: {
            qrCodeUrl: 'https://qr.airhub.com/nested-deep',
          },
        },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.getQRCode('8901234567890123456')

      expect(result.success).toBe(true)
      expect(result.data?.qrCodeUrl).toBe('https://qr.airhub.com/nested-deep')
    })
  })

  describe('unsupported operations', () => {
    it('getUsage returns NOT_SUPPORTED', async () => {
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.getUsage('8901234567890123456')
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_SUPPORTED')
    })

    it('suspendESIM returns NOT_SUPPORTED', async () => {
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.suspendESIM('AH-123')
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_SUPPORTED')
    })

    it('resumeESIM returns NOT_SUPPORTED', async () => {
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.resumeESIM('AH-123')
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_SUPPORTED')
    })

    it('getRates returns NOT_SUPPORTED', async () => {
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.getRates()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_SUPPORTED')
    })

    it('topUpESIM returns NOT_SUPPORTED', async () => {
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.topUpESIM({ iccid: '8901234567890123456', planId: 'TOP-UP', quantity: 1 })
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_SUPPORTED')
    })
  })

  describe('capability defaults', () => {
    it('AirHub has AUTH, CATALOG_SYNC, PURCHASE, STATUS, BALANCE capabilities', () => {
      const caps = DEFAULT_PROVIDER_CAPABILITIES['AIRHUB']
      expect(caps).toContain(ProviderCapability.AUTH)
      expect(caps).toContain(ProviderCapability.CATALOG_SYNC)
      expect(caps).toContain(ProviderCapability.PURCHASE)
      expect(caps).toContain(ProviderCapability.STATUS)
      expect(caps).toContain(ProviderCapability.BALANCE)
      expect(caps).toHaveLength(5)
    })
  })

  describe('extractIccids', () => {
    it('extracts from sims array', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: {
          orderId: 'AH-SIMS',
          sims: [{ iccid: '8901234567890555555' }],
          status: 'ACTIVATED',
        },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      expect(result.data?.iccids).toEqual(['8901234567890555555'])
    })

    it('extracts from result.iccids path', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: {
          result: { iccids: ['8901234567890444444'] },
          orderId: 'AH-RESULT',
          status: 'ACTIVATED',
        },
      })

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(true)
      expect(result.data?.iccids).toEqual(['8901234567890444444'])
    })
  })

  describe('normalizeStatus', () => {
    it('maps ACTIVATED to PENDING_ACTIVATION (purchase complete, not device-active)', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { orderId: 'AH1', iccids: ['8901234567890123456'], status: 'ACTIVATED' },
      })
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)
      expect(result.data?.status).toBe('PENDING_ACTIVATION')
    })

    it('maps COMPLETED to PENDING_ACTIVATION (purchase complete, not device-active)', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { orderId: 'AH2', iccids: ['8901234567890123456'], status: 'COMPLETED' },
      })
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)
      expect(result.data?.status).toBe('PENDING_ACTIVATION')
    })

    it('maps SUCCESS to PENDING_ACTIVATION (purchase complete, not device-active)', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { orderId: 'AH3', iccids: ['8901234567890123456'], status: 'SUCCESS' },
      })
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)
      expect(result.data?.status).toBe('PENDING_ACTIVATION')
    })

    it('maps IN_PROGRESS to PROCESSING', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { orderId: 'AH4', status: 'IN_PROGRESS' },
      })
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)
      expect(result.data?.status).toBe('PROCESSING')
    })

    it('maps unknown status to PENDING_ACTIVATION (purchase success never implies ACTIVE)', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { orderId: 'AH5', iccids: ['8901234567890123456'], status: 'UNKNOWN_STATUS' },
      })
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)
      expect(result.success).toBe(true)
      expect(result.data?.status).toBe('PENDING_ACTIVATION')
    })
  })

  describe('error classification from provider message', () => {
    it('classifies auth errors', async () => {
      mockFetchSuccess({ isSuccess: false, message: 'Authentication failed for this user' })
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)
      expect(result.error?.code).toBe('AUTH_ERROR')
    })

    it('classifies provider unavailable', async () => {
      mockFetchSuccess({ isSuccess: false, message: 'Service temporarily unavailable for maintenance' })
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)
      expect(result.error?.code).toBe('PROVIDER_UNAVAILABLE')
    })

    it('defaults to VALIDATION_ERROR for unrecognized messages', async () => {
      mockFetchSuccess({ isSuccess: false, message: 'Something went wrong' })
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)
      expect(result.error?.code).toBe('VALIDATION_ERROR')
    })
  })
})
