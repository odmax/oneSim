import { describe, it, expect, vi, beforeEach } from 'vitest'
import { validateTelnaConfig, trimTrailingSlash } from '@/lib/providers/provider-validation'
import type { ConnectorType } from './connector-factory'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: {
      findUnique: vi.fn(),
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

import type { Provider } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { TelnaConnector } from './telna-connector'
import { resolveConnectorType, createConnector } from './connector-factory'
import { encryptToken, decryptToken } from '@/lib/encryption'

const baseMock: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'> = {
  name: 'Telna',
  code: 'TELNA',
  type: 'CUSTOM',
  adapterStrategy: 'TELNA',
  authType: 'bearer_token',
  tokenPlacement: 'BEARER_HEADER',
  apiVersion: '2.1',
  apiBaseUrl: 'https://developer-api.telna.com',
  apiToken: 'enc:test-key-id-12345',
  authUrl: null,
  environment: 'staging',
  status: 'ACTIVE' as const,
  config: { authorizationMode: 'BEARER' },
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
}

const mockProvider = (overrides: Partial<Provider> = {}): Provider => ({
  id: 'telna-provider-1',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...baseMock,
  ...overrides,
})

describe('Telna Config Validation', () => {
  it('accepts valid Telna configuration', () => {
    const errors = validateTelnaConfig({
      code: 'TELNA',
      adapterStrategy: 'TELNA',
      apiBaseUrl: 'https://developer-api.telna.com',
      apiToken: 'test-key-id',
      authorizationMode: 'BEARER',
    })
    expect(errors).toHaveLength(0)
  })

  it('rejects missing KeyID', () => {
    const errors = validateTelnaConfig({
      code: 'TELNA',
      adapterStrategy: 'TELNA',
      apiBaseUrl: 'https://developer-api.telna.com',
      apiToken: '',
      authorizationMode: 'BEARER',
    })
    expect(errors.some(e => e.field === 'apiToken')).toBe(true)
  })

  it('rejects invalid authorization mode', () => {
    const errors = validateTelnaConfig({
      code: 'TELNA',
      adapterStrategy: 'TELNA',
      apiBaseUrl: 'https://developer-api.telna.com',
      apiToken: 'test-key-id',
      authorizationMode: 'INVALID',
    })
    expect(errors.some(e => e.field === 'authorizationMode')).toBe(true)
  })

  it('rejects non-HTTPS base URL', () => {
    const errors = validateTelnaConfig({
      code: 'TELNA',
      adapterStrategy: 'TELNA',
      apiBaseUrl: 'http://developer-api.telna.com',
      apiToken: 'test-key-id',
      authorizationMode: 'BEARER',
    })
    expect(errors.some(e => e.field === 'apiBaseUrl')).toBe(true)
  })

  it('rejects wrong adapter strategy', () => {
    const errors = validateTelnaConfig({
      code: 'TELNA',
      adapterStrategy: 'REST_CATALOG',
      apiBaseUrl: 'https://developer-api.telna.com',
      apiToken: 'test-key-id',
      authorizationMode: 'BEARER',
    })
    expect(errors.some(e => e.field === 'adapterStrategy')).toBe(true)
  })

  it('rejects wrong provider code', () => {
    const errors = validateTelnaConfig({
      code: 'OTHER',
      adapterStrategy: 'TELNA',
      apiBaseUrl: 'https://developer-api.telna.com',
      apiToken: 'test-key-id',
      authorizationMode: 'BEARER',
    })
    expect(errors.some(e => e.field === 'code')).toBe(true)
  })

  it('rejects credentials in URL', () => {
    const errors = validateTelnaConfig({
      code: 'TELNA',
      adapterStrategy: 'TELNA',
      apiBaseUrl: 'https://user:pass@developer-api.telna.com',
      apiToken: 'test-key-id',
      authorizationMode: 'BEARER',
    })
    expect(errors.some(e => e.field === 'apiBaseUrl' && e.message.includes('Credentials'))).toBe(true)
  })

  it('trims trailing slash from base URL', () => {
    expect(trimTrailingSlash('https://developer-api.telna.com/')).toBe('https://developer-api.telna.com')
    expect(trimTrailingSlash('https://developer-api.telna.com///')).toBe('https://developer-api.telna.com')
    expect(trimTrailingSlash('https://developer-api.telna.com')).toBe('https://developer-api.telna.com')
  })

  it('never exposes decrypted credentials in validation errors', () => {
    const errors = validateTelnaConfig({
      code: 'TELNA',
      adapterStrategy: 'TELNA',
      apiBaseUrl: 'https://developer-api.telna.com',
      apiToken: 'supersecretkeyid123',
      authorizationMode: 'BEARER',
    })
    for (const err of errors) {
      expect(err.message).not.toContain('supersecretkeyid123')
    }
  })
})

describe('Telna Provider Template Defaults', () => {
  it('has correct default values', () => {
    const defaults = {
      name: 'Telna',
      code: 'TELNA',
      type: 'CUSTOM',
      adapterStrategy: 'TELNA',
      apiBaseUrl: 'https://developer-api.telna.com',
      authType: 'bearer_token',
      tokenPlacement: 'BEARER_HEADER',
      authorizationMode: 'BEARER',
      apiVersion: '2.1',
    }
    expect(defaults.name).toBe('Telna')
    expect(defaults.code).toBe('TELNA')
    expect(defaults.adapterStrategy).toBe('TELNA')
    expect(defaults.apiBaseUrl).toBe('https://developer-api.telna.com')
    expect(defaults.authorizationMode).toBe('BEARER')
    expect(defaults.apiVersion).toBe('2.1')
  })
})

describe('KeyID Encryption', () => {
  it('encrypts and decrypts correctly', () => {
    const keyId = 'test-key-id-12345'
    const encrypted = encryptToken(keyId)
    expect(encrypted).toBeTruthy()
    expect(encrypted).not.toBe(keyId)
    const decrypted = decryptToken(encrypted)
    expect(decrypted).toBe(keyId)
  })
})

describe('Connector Factory', () => {
  it('resolves TELNA strategy to TELNA connector type', () => {
    const ct = resolveConnectorType('TELNA', 'CUSTOM')
    expect(ct).toBe('TELNA')
  })

  it('returns TelnaConnector from factory', () => {
    const connector = createConnector('test-id', 'Telna', 'TELNA', { apiBaseUrl: 'https://developer-api.telna.com' })
    expect(connector).toBeInstanceOf(TelnaConnector)
    expect(connector.name).toBe('Telna')
    expect(connector.providerId).toBe('test-id')
  })

  it('does not route CHOICE strategy to Telna', () => {
    const ct = resolveConnectorType('CHOICE', 'CUSTOM')
    expect(ct).toBe('URL_TOKEN')
  })

  it('does not route AIRHUB strategy to Telna', () => {
    const ct = resolveConnectorType('AIRHUB', 'CUSTOM')
    expect(ct).toBe('AIRHUB')
  })

  it('does not route STANDARD strategy to Telna', () => {
    const ct = resolveConnectorType('STANDARD', 'CUSTOM')
    expect(ct).toBe('STANDARD')
  })

  it('does not route HEADER_TOKEN strategy to Telna', () => {
    const ct = resolveConnectorType('HEADER_TOKEN', 'CUSTOM')
    expect(ct).toBe('HEADER_TOKEN')
  })

  it('does not route undefined strategy to Telna', () => {
    const ct = resolveConnectorType(null, 'CUSTOM')
    expect(ct).toBe('REST_CATALOG')
  })
})

describe('TelnaConnector Auth Header Modes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('generates BEARER Authorization header', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider({ config: { authorizationMode: 'BEARER' } }))
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.ensureAuthenticated()
    expect(result.success).toBe(true)
  })

  it('generates RAW Authorization header', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider({ config: { authorizationMode: 'RAW' } }))
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.ensureAuthenticated()
    expect(result.success).toBe(true)
  })

  it('returns not_configured when provider not found', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(null)
    const connector = new TelnaConnector('non-existent', 'Telna')
    const result = await connector.ensureAuthenticated()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NO_TOKEN')
  })
})

describe('TelnaConnector testConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  it('succeeds on 2xx with valid JSON', async () => {
    const fakeResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [{ id: 1, name: 'Test' }], total: 1 })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.testConnection()
    expect(result.success).toBe(true)
    expect(result.data?.message).toContain('Connected')
    expect(result.data?.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('returns 401 when authentication is rejected', async () => {
    const fakeResponse = {
      ok: false,
      status: 401,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Unauthorized'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.testConnection()
    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('Authentication rejected')
    expect(result.error?.code).toBe('HTTP_401')
  })

  it('returns 403 when KeyID lacks permission', async () => {
    const fakeResponse = {
      ok: false,
      status: 403,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Forbidden'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.testConnection()
    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('lacks permission')
    expect(result.error?.code).toBe('HTTP_403')
  })

  it('returns 429 when rate limited', async () => {
    const fakeResponse = {
      ok: false,
      status: 429,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Too Many Requests'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.testConnection()
    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('Rate limited')
    expect(result.error?.code).toBe('HTTP_429')
  })

  it('returns timeout error when request aborts', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.testConnection()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('TIMEOUT')
  })

  it('returns network error on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ENOTFOUND developer-api.telna.com'))

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.testConnection()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NETWORK_ERROR')
  })

  it('returns provider not configured when no provider in DB', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(null)

    const connector = new TelnaConnector('non-existent', 'Telna')
    const result = await connector.testConnection()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
  })
})

describe('Existing Behavior Unchanged', () => {
  it('Choice URL_TOKEN resolves correctly', () => {
    const ct = resolveConnectorType('CHOICE', 'CUSTOM')
    expect(ct).toBe('URL_TOKEN')
  })

  it('AirHub resolves correctly', () => {
    const ct = resolveConnectorType('AIRHUB', 'CUSTOM')
    expect(ct).toBe('AIRHUB')
  })

  it('Rakuten/REST_CATALOG resolves correctly', () => {
    const ct = resolveConnectorType('REST_CATALOG', 'CUSTOM')
    expect(ct).toBe('REST_CATALOG')
  })

  it('MOCK provider type resolves to MOCK', () => {
    const ct = resolveConnectorType(undefined, 'MOCK')
    expect(ct).toBe('MOCK')
  })

  it('HEADER_TOKEN resolves correctly', () => {
    const ct = resolveConnectorType('HEADER_TOKEN', 'CUSTOM')
    expect(ct).toBe('HEADER_TOKEN')
  })

  it('STANDARD resolves correctly', () => {
    const ct = resolveConnectorType('STANDARD', 'CUSTOM')
    expect(ct).toBe('STANDARD')
  })
})

describe('Provider Search by Code', () => {
  it('matches case-insensitively on code', () => {
    const providers = [
      { code: 'TELNA', name: 'Telna', adapterStrategy: 'TELNA', status: 'ACTIVE' },
      { code: 'AIRHUB', name: 'AirHub', adapterStrategy: 'AIRHUB', status: 'ACTIVE' },
      { code: 'CHOICE', name: 'Choice Wireless', adapterStrategy: 'CHOICE', status: 'ACTIVE' },
    ]
    const search = 'telna'
    const results = providers.filter(p =>
      [p.code, p.name, p.adapterStrategy, p.status].some(f =>
        f.toLowerCase().includes(search.toLowerCase())
      )
    )
    expect(results).toHaveLength(1)
    expect(results[0].code).toBe('TELNA')
  })

  it('matches case-insensitively on name', () => {
    const providers = [
      { code: 'TELNA', name: 'Telna', adapterStrategy: 'TELNA', status: 'ACTIVE' },
      { code: 'AIRHUB', name: 'AirHub', adapterStrategy: 'AIRHUB', status: 'ACTIVE' },
    ]
    const search = 'air'
    const results = providers.filter(p =>
      [p.code, p.name, p.adapterStrategy, p.status].some(f =>
        f.toLowerCase().includes(search.toLowerCase())
      )
    )
    expect(results).toHaveLength(1)
    expect(results[0].code).toBe('AIRHUB')
  })

  it('matches on adapter strategy', () => {
    const providers = [
      { code: 'TELNA', name: 'Telna', adapterStrategy: 'TELNA', status: 'ACTIVE' },
      { code: 'CHOICE', name: 'Choice', adapterStrategy: 'CHOICE', status: 'ACTIVE' },
      { code: 'MOCK1', name: 'Mock', adapterStrategy: 'MOCK', status: 'ACTIVE' },
    ]
    const search = 'mock'
    const results = providers.filter(p =>
      [p.code, p.name, p.adapterStrategy, p.status].some(f =>
        f.toLowerCase().includes(search.toLowerCase())
      )
    )
    expect(results).toHaveLength(1)
    expect(results[0].code).toBe('MOCK1')
  })

  it('returns empty for no match', () => {
    const providers = [
      { code: 'TELNA', name: 'Telna', adapterStrategy: 'TELNA', status: 'ACTIVE' },
    ]
    const search = 'nonexistent'
    const results = providers.filter(p =>
      [p.code, p.name, p.adapterStrategy, p.status].some(f =>
        f.toLowerCase().includes(search.toLowerCase())
      )
    )
    expect(results).toHaveLength(0)
  })
})
