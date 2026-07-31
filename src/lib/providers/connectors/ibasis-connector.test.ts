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
  })

  describe('Phase 2 methods', () => {
    it('returns NOT_IMPLEMENTED for syncPlans', async () => {
      const result = await connector.syncPlans()
      expect(result.error?.code).toBe('NOT_IMPLEMENTED')
    })

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
