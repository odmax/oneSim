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
      expect(result.data?.status).toBe('ACTIVE')
      expect(result.data?.qrCodeUrl).toBe('https://qr.airhub.com/12345')

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url, opts] = fetchSpy.mock.calls[0]
      expect(url).toContain('/api/ESIM/PurhaseSim')
      expect(opts.method).toBe('POST')
      expect(opts.headers['Authorization']).toBe('Bearer test-token')
      const body = JSON.parse(opts.body)
      expect(body.planCode).toBe('US-5GB-30D')
      expect(body.quantity).toBe(1)
      expect(body.email).toBe('test@example.com')
      expect(body.partnerCode).toBe(200652387)
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
      expect(result.data?.status).toBe('ACTIVE')
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

    it('returns AUTH_ERROR on 401 with failed refresh', async () => {
      mockFetchFailure(401, { message: 'Unauthorized' })

      mockPrisma.provider.findUnique.mockResolvedValue(
        makeProvider({ config: { partnerCode: 200652387 } })
      )

      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('AUTH_ERROR')
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

    it('returns error when token is missing', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue(
        makeProvider({ apiToken: null, config: { partnerCode: 200652387 } })
      )

      const connector = new AirHubConnector('airhub-1', null)
      const result = await connector.activateESIM(ACTIVATE_PARAMS)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NO_TOKEN')
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

    it('sends quantity > 1 correctly', async () => {
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
      expect(body.quantity).toBe(2)
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
      expect(result.data?.status).toBe('ACTIVE')
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
    it('AirHub has AUTH, CATALOG_SYNC, PURCHASE, STATUS capabilities', () => {
      const caps = DEFAULT_PROVIDER_CAPABILITIES['AIRHUB']
      expect(caps).toContain(ProviderCapability.AUTH)
      expect(caps).toContain(ProviderCapability.CATALOG_SYNC)
      expect(caps).toContain(ProviderCapability.PURCHASE)
      expect(caps).toContain(ProviderCapability.STATUS)
      expect(caps).toHaveLength(4)
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
    it('maps ACTIVATED to ACTIVE', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { orderId: 'AH1', iccids: ['8901234567890123456'], status: 'ACTIVATED' },
      })
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)
      expect(result.data?.status).toBe('ACTIVE')
    })

    it('maps COMPLETED to ACTIVE', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { orderId: 'AH2', iccids: ['8901234567890123456'], status: 'COMPLETED' },
      })
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)
      expect(result.data?.status).toBe('ACTIVE')
    })

    it('maps SUCCESS to ACTIVE', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { orderId: 'AH3', iccids: ['8901234567890123456'], status: 'SUCCESS' },
      })
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)
      expect(result.data?.status).toBe('ACTIVE')
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

    it('maps unknown status to PENDING', async () => {
      mockFetchSuccess({
        isSuccess: true,
        data: { orderId: 'AH5', iccids: ['8901234567890123456'], status: 'UNKNOWN_STATUS' },
      })
      const connector = new AirHubConnector('airhub-1', 'test-token')
      const result = await connector.activateESIM(ACTIVATE_PARAMS)
      expect(result.success).toBe(true)
      expect(result.data?.status).toBe('PENDING')
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
