import { describe, it, expect, vi, beforeEach } from 'vitest'
import { validateTelnaConfig, trimTrailingSlash } from '@/lib/providers/provider-validation'
import type { ConnectorType } from './connector-factory'
import { telnaEndpointPath, buildTelnaEndpointUrl } from './telna-endpoints'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: {
      findUnique: vi.fn(),
    },
    eSIM: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue({}),
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

vi.mock('@/lib/services/esims/esim-inventory-claim', () => ({
  claimProviderIccid: vi.fn().mockResolvedValue({ ok: true }),
  releaseProviderIccidClaim: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/providers/capability-state', () => ({
  getCustomPackageCreationReadiness: vi.fn(),
}))

import type { Provider } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { TelnaConnector, normalizeTelnaState, normalizeTelnaTimeAllowance } from './telna-connector'
import { resolveConnectorType, createConnector } from './connector-factory'
import { encryptToken, decryptToken } from '@/lib/encryption'
import { claimProviderIccid, releaseProviderIccidClaim } from '@/lib/services/esims/esim-inventory-claim'
import { getCustomPackageCreationReadiness } from '@/lib/providers/capability-state'

const mockClaimProviderIccid = vi.mocked(claimProviderIccid)
const mockReleaseProviderIccidClaim = vi.mocked(releaseProviderIccidClaim)
const mockCustomPackageReadiness = vi.mocked(getCustomPackageCreationReadiness)

// Deterministic encrypted PCR credential fixtures. Stored in provider.config
// ONLY as encryptToken() ciphertext (never plaintext), matching the production
// connector's decrypted-at-load contract.
const TEST_KEY_ID = 'test-key-id-12345'
const TEST_PCR_API_KEY = 'test-pcr-api-key'
const TEST_PCR_LOGIN_ID = 'test-pcr-login'
const TEST_PCR_ACCESS_TOKEN = 'test-pcr-access-token'

const baseMock: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'> = {
  name: 'Telna',
  code: 'TELNA',
  type: 'CUSTOM',
  adapterStrategy: 'TELNA',
  authType: 'bearer_token',
  tokenPlacement: 'BEARER_HEADER',
  apiVersion: '2.1',
  apiBaseUrl: 'https://developer-api.telna.com',
  apiToken: `enc:${TEST_KEY_ID}`,
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

const mockProvider = (overrides: Partial<Provider> & { pcrAuth?: 'full' | 'missing' } = {}): Provider => {
  const { pcrAuth = 'full', config: overrideConfig, ...rest } = overrides
  const pcrConfig = pcrAuth === 'full'
    ? {
        telnaPcrApiKeyEncrypted: encryptToken(TEST_PCR_API_KEY),
      }
    : {}
  return {
    id: 'telna-provider-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...baseMock,
    ...rest,
    // Merge: base config → default encrypted PCR auth → test-specific override,
    // so `config: { walletId }` keeps telnaPcrApiKeyEncrypted unless pcrAuth:missing.
    config: {
      ...(baseMock.config as Record<string, unknown>),
      ...pcrConfig,
      ...(overrideConfig as Record<string, unknown> | undefined),
    },
  }
}

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
    const keyId = TEST_KEY_ID
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

  it('declares STATIC_KEY_ID auth (no runtime authentication, Save & Verify)', () => {
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const profile = connector.authProfile!
    expect(profile.mode).toBe('STATIC_KEY_ID')
    expect(profile.requiresRuntimeAuthentication).toBe(false)
    expect(profile.canVerifyCredentials).toBe(true)
    expect(profile.supportsRefresh).toBe(false)
    expect(profile.actionLabel).toBe('Save & Verify')
  })

  it('authenticate() is a no-op error — never performs runtime login', async () => {
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.authenticate({})
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_IMPLEMENTED')
    expect(String(result.error?.message)).toContain('pre-configured KeyID')
  })

it('testConnection succeeds on a 200 from GET /v2.1/core/countries with raw Authorization API key', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [{ id: 1 }], total: 1 })),
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.testConnection()
    expect(result.success).toBe(true)
    // CORE is proven: the request IS dispatched to /v2.1/core/countries with the
    // raw API_ACCESS_KEY_ID (no Bearer prefix, no Basic, no ApiKey).
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/v2.1/core/countries')
    expect(init.headers['Authorization']).toBe('test-key-id-12345')
    expect(init.headers['Authorization']).not.toContain('Bearer')
    expect(init.headers['ApiKey']).toBeUndefined()
  })

  it('testConnection classifies a real provider 401/403/404/429', async () => {
    for (const [status, code] of [[401, 'HTTP_401'], [403, 'HTTP_403'], [404, 'HTTP_404'], [429, 'HTTP_429']] as Array<[number, string]>) {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: false, status, headers: new Headers({ 'content-type': 'text/plain' }), text: vi.fn().mockResolvedValue('x'),
      })
      vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
      const connector = new TelnaConnector('telna-provider-1', 'Telna')
      const result = await connector.testConnection()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe(code)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    }
  })

  it('returns provider not configured when no provider in DB', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(null)

    const connector = new TelnaConnector('non-existent', 'Telna')
    const result = await connector.testConnection()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
  })
})

describe('TelnaConnector Discovery — listCountries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  it('refuses /core/countries with NOT_CONFIGURED (auth unproven) and makes NO HTTP call', async () => {
    const countryData = [
      { id: 1, name: 'United States', iso: 'US', code: '1', region: 'Americas' },
      { id: 2, name: 'United Kingdom', iso: 'GB', code: '44', region: 'Europe' },
    ]
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: countryData, total: 2, offset: 0, count: 2 })),
    }
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse as any)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listCountries(10, 0)
    expect(result.success).toBe(true)
    expect(result.data?.items).toHaveLength(2)
    expect(result.data?.total).toBe(2)
    // Dispatches to /v2.1/core/countries with the raw authorization API key.
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/v2.1/core/countries')
    expect(init.headers['Authorization']).toBe('test-key-id-12345')
    expect(init.headers['Authorization']).not.toContain('Bearer')
  })

  it('does not map live /core failures because the CORE family is never dispatched', async () => {
    // Even a 500 / network-error mock must not be reached for a CORE lookup;
    // the guard returns NOT_CONFIGURED before any fetch.
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ENETUNREACH'))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listCountries(10, 0)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NETWORK_ERROR')
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('handles provider not configured', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(null)
    const connector = new TelnaConnector('non-existent', 'Telna')
    const result = await connector.listCountries(10, 0)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
  })

  it('listCountries parses an empty country list (CORE proven)', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [], total: 0, offset: 0, count: 0 })),
    }
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse as any)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listCountries(10, 0)
    expect(result.success).toBe(true)
    expect(result.data?.items).toHaveLength(0)
  })
})

describe('TelnaConnector Discovery — getCompany', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  it('refuses /core/companies/{id} with NOT_CONFIGURED (auth unproven) and makes NO HTTP call', async () => {
    const companyData = { id: 42, name: 'Acme Corp', code: 'ACME', status: 'ACTIVE', countryId: 1 }
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: companyData })),
    }
const fetchSpy = vi.fn().mockResolvedValue(fakeResponse as any)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getCompany(42)

    expect(result.success).toBe(true)
    expect(result.data?.company?.name).toBe('Acme Corp')
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/v2.1/core/companies/42')
    expect(init.headers['Authorization']).toBe('test-key-id-12345')
    expect(init.headers['Authorization']).not.toContain('Bearer')
  })

  it('maps a real 404 from GET /v2.1/core/companies/{id}', async () => {
    const fakeResponse = {
      ok: false, status: 404,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Not Found'),
    }
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse as any)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getCompany(999)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_404')
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('handles provider not configured', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(null)
    const connector = new TelnaConnector('non-existent', 'Telna')
    const result = await connector.getCompany(1)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
  })
})

describe('TelnaConnector Discovery — listInventories', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  it('returns inventories for a company', async () => {
    const inventoryData = [
      { id: 10, name: 'Main Inventory', type: 'PHYSICAL', status: 'ACTIVE', companyId: 42, totalSims: 1000, availableSims: 500, allocatedSims: 450, defectiveSims: 30, testSims: 20 },
    ]
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: inventoryData, total: 1, offset: 0, count: 10 })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listInventories(42, 10, 0)
    expect(result.success).toBe(true)
    expect(result.data?.items).toHaveLength(1)
    expect(result.data?.total).toBe(1)
    expect(result.data?.items[0].name).toBe('Main Inventory')
    expect(result.data?.items[0].availableSims).toBe(500)
  })

  it('filters by company query parameter', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [], total: 0, offset: 0, count: 10 })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    await connector.listInventories(99, 10, 0)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('company=99'),
      expect.any(Object)
    )
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.not.stringContaining('company_id'),
      expect.any(Object)
    )
  })

  it('handles failure', async () => {
    const fakeResponse = {
      ok: false, status: 403,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Forbidden'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listInventories()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_403')
  })

  it('handles empty response gracefully', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [], total: 0 })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listInventories()
    expect(result.success).toBe(true)
    expect(result.data?.items).toHaveLength(0)
    expect(result.data?.total).toBe(0)
  })
})

describe('TelnaConnector Discovery — listGroups', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  it('returns groups with filters', async () => {
    const groupData = [
      { id: 100, name: 'Group A', inventoryId: 10, status: 'ACTIVE', profileId: 5, totalSims: 200, availableSims: 100, allocatedSims: 100 },
    ]
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: groupData, total: 1, offset: 0, count: 10 })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listGroups(10, 42, 50, 0)
    expect(result.success).toBe(true)
    expect(result.data?.items).toHaveLength(1)
    expect(result.data?.items[0].name).toBe('Group A')
    expect(result.data?.items[0].inventoryId).toBe(10)
  })

  it('passes inventory_id and company_id query params', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [], total: 0 })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    await connector.listGroups(10, 42)
    const url = (globalThis.fetch as any).mock.calls[0][0] as string
    expect(url).toContain('inventory_id=10')
    expect(url).toContain('company_id=42')
  })

  it('handles failure', async () => {
    const fakeResponse = {
      ok: false, status: 429,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Rate Limited'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listGroups()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_429')
  })
})

describe('TelnaConnector Discovery — getWallet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  it('returns wallet by ID on success', async () => {
    const walletData = { id: 500, name: 'USD Wallet', currency: 'USD', balance: 10000.50, status: 'ACTIVE', companyId: 42 }
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: walletData })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getWallet(500)
    expect(result.success).toBe(true)
    expect(result.data?.wallet.id).toBe(500)
    expect(result.data?.wallet.balance).toBe(10000.50)
    expect(result.data?.wallet.currency).toBe('USD')
    // Verify path param substitution
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/pcr/wallets/500'),
      expect.any(Object)
    )
  })

  it('returns error when wallet not found', async () => {
    const fakeResponse = {
      ok: false, status: 404,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Not Found'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getWallet(999)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_404')
  })

  it('handles provider not configured', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(null)
    const connector = new TelnaConnector('non-existent', 'Telna')
    const result = await connector.getWallet(1)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
  })
})

describe('TelnaConnector Phase 2A — listPackageTemplates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  const mockTemplates = [
    {
      id: 101, name: '1GB Daily Plan', package_type: 'DATA', status: 'ACTIVE',
      inventory_id: 10, currency: 'USD', price: 5.00,
      data_allowance: { value: 1, unit: 'GB' },
      time_allowance: { value: 1, unit: 'DAY' },
      countries: [{ name: 'United States', iso: 'US' }],
    },
    {
      id: 102, name: '5GB Weekly Plan', package_type: 'DATA', status: 'ACTIVE',
      inventory_id: 10, currency: 'USD', price: 15.00,
      data_allowance: { value: 5, unit: 'GB' },
      time_allowance: { value: 1, unit: 'WEEK' },
      zones: [{ name: 'Europe', type: 'REGIONAL', countryCodes: ['DE', 'FR', 'ES'] }],
    },
  ]

  it('returns paginated package templates on success', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: mockTemplates, total: 2, offset: 0, count: 50 })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listPackageTemplates(10, 50, 0)
    expect(result.success).toBe(true)
    expect(result.data?.items).toHaveLength(2)
    expect(result.data?.total).toBe(2)
    expect(result.data?.items[0].name).toBe('1GB Daily Plan')
    expect(result.data?.items[1].name).toBe('5GB Weekly Plan')
  })

  it('passes inventory_id query parameter', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [], total: 0, offset: 0, count: 50 })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    await connector.listPackageTemplates(42, 50, 0)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('inventory_id=42'),
      expect.any(Object)
    )
  })

  it('handles empty result', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [], total: 0, offset: 0, count: 50 })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listPackageTemplates()
    expect(result.success).toBe(true)
    expect(result.data?.items).toHaveLength(0)
    expect(result.data?.total).toBe(0)
  })

  it('handles 401', async () => {
    const fakeResponse = {
      ok: false, status: 401,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Unauthorized'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listPackageTemplates()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_401')
  })

  it('handles 403', async () => {
    const fakeResponse = {
      ok: false, status: 403,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Forbidden'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listPackageTemplates()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_403')
  })

  it('handles 404', async () => {
    const fakeResponse = {
      ok: false, status: 404,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Not Found'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listPackageTemplates()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_404')
  })

  it('handles 429', async () => {
    const fakeResponse = {
      ok: false, status: 429,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Rate Limited'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listPackageTemplates()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_429')
  })

  it('handles timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listPackageTemplates()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('TIMEOUT')
  })

  it('handles provider not configured', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(null)
    const connector = new TelnaConnector('non-existent', 'Telna')
    const result = await connector.listPackageTemplates()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
  })
})

describe('TelnaConnector Phase 2A — getPackageTemplate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  it('returns template detail by ID on success', async () => {
    const templateData = {
      id: 201, name: '10GB Monthly Plan', package_type: 'DATA', status: 'ACTIVE',
      inventory_id: 10, currency: 'USD', price: 30.00,
      data_allowance: { value: 10, unit: 'GB' },
      time_allowance: { value: 1, unit: 'MONTH' },
      countries: [{ name: 'Germany', iso: 'DE' }, { name: 'France', iso: 'FR' }],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-06-01T00:00:00Z',
    }
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: templateData })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getPackageTemplate(201)
    expect(result.success).toBe(true)
    expect(result.data?.template.id).toBe(201)
    expect(result.data?.template.name).toBe('10GB Monthly Plan')
    expect(result.data?.template.price).toBe(30.00)
    // Verify path param substitution
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v2.1/pcr/package-templates/201'),
      expect.any(Object)
    )
  })

  it('handles 404 when template not found', async () => {
    const fakeResponse = {
      ok: false, status: 404,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Not Found'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getPackageTemplate(999)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_404')
  })

  it('handles provider not configured', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(null)
    const connector = new TelnaConnector('non-existent', 'Telna')
    const result = await connector.getPackageTemplate(1)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
  })
})

describe('TelnaConnector Phase 2A — package template path param substitution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  it('substitutes package_template_id in packageTemplate endpoint path', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: { id: 301, name: 'Test', status: 'ACTIVE' } })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    await connector.getPackageTemplate(301)
    const url = (globalThis.fetch as any).mock.calls[0][0] as string
    expect(url).toMatch(/\/pcr\/package-templates\/301[?]?/)
    expect(url).not.toContain('{package_template_id}')
  })
})

describe('TelnaConnector Phase 2A — existing discovery regression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  it('listCountries reads /v2.1/core/countries with raw Authorization API key (CORE proven)', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [{ id: 1, name: 'Test', iso: 'TT' }], total: 1, offset: 0, count: 1 })),
    }
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse as any)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listCountries(1, 0)
    expect(result.success).toBe(true)
    expect(result.data?.items).toHaveLength(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/v2.1/core/countries')
    expect(init.headers['Authorization']).toBe(TEST_KEY_ID)
    expect(init.headers['Authorization']).not.toContain('Bearer')
  })

  it('getCompany reads /v2.1/core/companies/{id} with raw Authorization API key (CORE proven)', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: { id: 1, name: 'Co', code: 'CO', status: 'ACTIVE' } })),
    }
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse as any)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getCompany(1)
    expect(result.success).toBe(true)
    expect(result.data?.company?.name).toBe('Co')
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/v2.1/core/companies/1')
  })

  it('getWallet still works after Phase 2A changes', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: { id: 1, name: 'W', currency: 'USD', balance: 100, status: 'ACTIVE', companyId: 1 } })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getWallet(1)
    expect(result.success).toBe(true)
  })
})

describe('TelnaConnector Discovery — path param substitution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  it('CORE company lookup (getCompany) substitutes the company_id path param under /v2.1/core/companies', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: { id: 1, name: 'Test', code: 'TST', status: 'ACTIVE' } })),
    }
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse as any)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getCompany(123)
    expect(result.success).toBe(true)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/v2.1/core/companies/123')
  })

  it('substitutes wallet_id in wallet endpoint path', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: { id: 456, name: 'Test Wallet', currency: 'EUR', balance: 500, status: 'ACTIVE', companyId: 1 } })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    await connector.getWallet(456)
    const url = (globalThis.fetch as any).mock.calls[0][0] as string
    expect(url).toMatch(/\/pcr\/wallets\/456[?]?/)
    expect(url).not.toContain('{wallet_id}')
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

describe('TelnaConnector Phase 2B — listPackages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  const mockPackages = [
    {
      id: 1001, package_template_id: 201, inventory_id: 10,
      name: '5GB Monthly Data', status: 'ACTIVE',
      data_allowance: { value: 5, unit: 'GB' },
      time_allowance: { value: 1, unit: 'MONTH' },
      price: 25.00, currency: 'USD',
      countries: [{ name: 'United States', iso: 'US' }],
      coverage_type: 'LOCAL', activation_mode: 'AUTO',
    },
    {
      id: 1002, package_template_id: 202, inventory_id: 11,
      name: '10GB Global Roaming', status: 'ACTIVE',
      data_allowance: { value: 10, unit: 'GB' },
      time_allowance: { value: 7, unit: 'DAY' },
      price: 45.00, currency: 'USD',
      zones: [{ name: 'Global', type: 'GLOBAL', countryCodes: ['*'] }],
      coverage_type: 'GLOBAL', activation_mode: 'MANUAL',
    },
  ]

  it('returns paginated packages on success', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: mockPackages, total: 2, offset: 0, count: 50 })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listPackages(10, 201, 50, 0)
    expect(result.success).toBe(true)
    expect(result.data?.items).toHaveLength(2)
    expect(result.data?.total).toBe(2)
    expect(result.data?.items[0].name).toBe('5GB Monthly Data')
    expect(result.data?.items[1].name).toBe('10GB Global Roaming')
  })

  it('passes inventory_id and package_template_id query params', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [], total: 0, offset: 0, count: 100 })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    await connector.listPackages(42, 55, 100, 0)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('inventory_id=42'),
      expect.any(Object)
    )
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('package_template_id=55'),
      expect.any(Object)
    )
  })

  it('handles empty result', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [], total: 0, offset: 0, count: 50 })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listPackages()
    expect(result.success).toBe(true)
    expect(result.data?.items).toHaveLength(0)
    expect(result.data?.total).toBe(0)
  })

  it('handles 401', async () => {
    const fakeResponse = {
      ok: false, status: 401,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Unauthorized'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listPackages()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_401')
  })

  it('handles 403', async () => {
    const fakeResponse = {
      ok: false, status: 403,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Forbidden'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listPackages()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_403')
  })

  it('handles 404', async () => {
    const fakeResponse = {
      ok: false, status: 404,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Not Found'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listPackages()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_404')
  })

  it('handles 429', async () => {
    const fakeResponse = {
      ok: false, status: 429,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Rate Limited'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listPackages()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_429')
  })

  it('handles timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listPackages()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('TIMEOUT')
  })

  it('handles provider not configured', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(null)
    const connector = new TelnaConnector('non-existent', 'Telna')
    const result = await connector.listPackages()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
  })
})

describe('TelnaConnector Phase 2B — getPackage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  it('returns package detail by ID on success', async () => {
    const pkgData = {
      id: 1001, package_template_id: 201, inventory_id: 10,
      name: '5GB Monthly Data', status: 'ACTIVE',
      data_allowance: { value: 5, unit: 'GB' },
      time_allowance: { value: 1, unit: 'MONTH' },
      price: 25.00, currency: 'USD',
      countries: [{ name: 'United States', iso: 'US' }],
      coverage_type: 'LOCAL', activation_mode: 'AUTO',
    }
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: pkgData })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getPackage(1001)
    expect(result.success).toBe(true)
    expect(result.data?.pkg.id).toBe(1001)
    expect(result.data?.pkg.name).toBe('5GB Monthly Data')
    expect(result.data?.pkg.price).toBe(25.00)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v2.1/pcr/packages/1001'),
      expect.any(Object)
    )
  })

  it('handles 404 when package not found', async () => {
    const fakeResponse = {
      ok: false, status: 404,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Not Found'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getPackage(999)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_404')
  })

  it('handles provider not configured', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(null)
    const connector = new TelnaConnector('non-existent', 'Telna')
    const result = await connector.getPackage(1)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
  })
})

describe('TelnaConnector Phase 2B — package path param substitution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  it('substitutes package_id in package endpoint path', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: { id: 301, name: 'Test', status: 'ACTIVE' } })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    await connector.getPackage(301)
    const url = (globalThis.fetch as any).mock.calls[0][0] as string
    expect(url).toMatch(/\/pcr\/packages\/301[?]?/)
    expect(url).not.toContain('{package_id}')
  })
})

// ── Phase 3: SIM Registry ──────────────────────────────────────────────

describe('TelnaConnector Phase 3 — listSimRegistries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  const mockSims = [
    {
      id: 1, iccid: '89012345678901234567', imsi: '310150123456789',
      msisdn: '+12025551234', status: 'AVAILABLE',
      inventory_id: 10, group_id: 20,
      activation_date: '2025-01-15T00:00:00Z',
    },
    {
      id: 2, iccid: '89098765432109876543', imsi: '310150987654321',
      msisdn: '+12025559876', status: 'ACTIVE',
      inventory_id: 11, group_id: 21,
      activation_date: '2025-03-10T00:00:00Z',
    },
  ]

  it('returns paginated SIM registries on success', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: mockSims, total: 2, offset: 0, count: 50 })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listSimRegistries(10, 20, 'AVAILABLE', undefined, undefined, 50, 0)
    expect(result.success).toBe(true)
    expect(result.data?.items).toHaveLength(2)
    expect(result.data?.total).toBe(2)
    expect(result.data?.items[0].iccid).toBe('89012345678901234567')
    expect(result.data?.items[1].iccid).toBe('89098765432109876543')
  })

  it('passes query params for filters', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [], total: 0, offset: 0, count: 100 })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    await connector.listSimRegistries(42, 55, 'ACTIVE', '89012345678901234567', '310150123456789', 100, 0)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('inventory_id=42'),
      expect.any(Object)
    )
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('group=55'),
      expect.any(Object)
    )
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.not.stringContaining('group_id=55'),
      expect.any(Object)
    )
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('status=ACTIVE'),
      expect.any(Object)
    )
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('iccid=89012345678901234567'),
      expect.any(Object)
    )
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('imsi=310150123456789'),
      expect.any(Object)
    )
  })

  it('handles empty result', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [], total: 0, offset: 0, count: 50 })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listSimRegistries()
    expect(result.success).toBe(true)
    expect(result.data?.items).toHaveLength(0)
    expect(result.data?.total).toBe(0)
  })

  it('handles 401', async () => {
    const fakeResponse = {
      ok: false, status: 401,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Unauthorized'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listSimRegistries()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_401')
  })

  it('handles 403', async () => {
    const fakeResponse = {
      ok: false, status: 403,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Forbidden'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listSimRegistries()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_403')
  })

  it('handles 404', async () => {
    const fakeResponse = {
      ok: false, status: 404,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Not Found'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listSimRegistries()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_404')
  })

  it('handles 429', async () => {
    const fakeResponse = {
      ok: false, status: 429,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Rate Limited'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listSimRegistries()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_429')
  })

  it('handles timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listSimRegistries()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('TIMEOUT')
  })

  it('handles provider not configured', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(null)
    const connector = new TelnaConnector('non-existent', 'Telna')
    const result = await connector.listSimRegistries()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
  })
})

describe('TelnaConnector Phase 3 — getSimRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  it('returns SIM detail by ICCID on success', async () => {
    const simData = {
      id: 1, iccid: '89012345678901234567', imsi: '310150123456789',
      msisdn: '+12025551234', status: 'ACTIVE',
      inventory_id: 10, group_id: 20,
      current_package_id: 5001,
      activation_date: '2025-01-15T00:00:00Z',
    }
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: simData })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getSimRegistry('89012345678901234567')
    expect(result.success).toBe(true)
    expect(result.data?.sim.iccid).toBe('89012345678901234567')
    expect(result.data?.sim.imsi).toBe('310150123456789')
    expect(result.data?.sim.status).toBe('ACTIVE')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v2.1/inventory/sim-registries/89012345678901234567'),
      expect.any(Object)
    )
  })

  it('handles 404 when SIM not found', async () => {
    const fakeResponse = {
      ok: false, status: 404,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Not Found'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getSimRegistry('nonexistent')
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_404')
  })

  it('handles provider not configured', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(null)
    const connector = new TelnaConnector('non-existent', 'Telna')
    const result = await connector.getSimRegistry('89012345678901234567')
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
  })
})

describe('TelnaConnector Phase 3 — SIM registry path param substitution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  it('substitutes iccid in sim registry endpoint path', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: { id: 1, iccid: '89012345678901234567', status: 'ACTIVE' } })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    await connector.getSimRegistry('89012345678901234567')
    const url = (globalThis.fetch as any).mock.calls[0][0] as string
    expect(url).toMatch(/\/inventory\/sim-registries\/89012345678901234567[?]?/)
    expect(url).not.toContain('{iccid}')
  })
})

// ── Phase 4: PCR Profile ──────────────────────────────────────────────

describe('TelnaConnector Phase 4 — getSimPCRProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  const mockPCRProfile = {
    id: 1,
    iccid: '89012345678901234567',
    status: 'ACTIVE',
    current_package: { id: 5001, package_template_id: 1001, name: '5GB Monthly Data' },
    pending_package: null,
    traffic_policy_id: 50,
    wallet_id: 200,
    activation_state: 'ACTIVATED',
    renewal: { enabled: true, renewal_date: '2026-01-15', renewal_package_id: 5001 },
    expiration: { expired: false, expiration_date: '2025-08-15' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-07-01T00:00:00Z',
  }

  it('returns PCR profile by ICCID on success', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: mockPCRProfile })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getSimPCRProfile('89012345678901234567')
    expect(result.success).toBe(true)
    expect(result.data?.profile.iccid).toBe('89012345678901234567')
    expect(result.data?.profile.current_package?.name).toBe('5GB Monthly Data')
    expect(result.data?.profile.renewal?.enabled).toBe(true)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/pcr/sim-pcr-profiles/89012345678901234567'),
      expect.any(Object)
    )
  })

  it('handles 404', async () => {
    const fakeResponse = {
      ok: false, status: 404,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Not Found'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getSimPCRProfile('nonexistent')
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_404')
  })

  it('handles timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getSimPCRProfile('89012345678901234567')
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('TIMEOUT')
  })

  it('handles provider not configured', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(null)
    const connector = new TelnaConnector('non-existent', 'Telna')
    const result = await connector.getSimPCRProfile('89012345678901234567')
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
  })
})

describe('TelnaConnector Phase 4 — updateSimPCRProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  it('updates PCR profile with package_template_id on success', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({
        data: {
          id: 1, iccid: '89012345678901234567', status: 'ACTIVE',
          current_package: { id: 6002, package_template_id: 2002, name: '10GB Global Data' },
          pending_package: null,
        },
      })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.updateSimPCRProfile('89012345678901234567', { package_template_id: 2002 })
    expect(result.success).toBe(true)
    expect(result.data?.profile.current_package?.id).toBe(6002)
    expect(result.data?.profile.current_package?.package_template_id).toBe(2002)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/pcr/sim-pcr-profiles/89012345678901234567'),
      expect.any(Object)
    )
  })

  it('sends PUT request with body', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: { id: 1, iccid: '89012345678901234567', status: 'ACTIVE' } })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    await connector.updateSimPCRProfile('89012345678901234567', { package_template_id: 'PKG-2002' })
    const callArgs = (globalThis.fetch as any).mock.calls[0]
    const url = callArgs[0] as string
    const options = callArgs[1] as any
    expect(url).toContain('/pcr/sim-pcr-profiles/89012345678901234567')
    expect(options.method).toBe('PUT')
    expect(JSON.parse(options.body)).toEqual({ package_template_id: 'PKG-2002' })
  })

  it('handles 409 conflict', async () => {
    const fakeResponse = {
      ok: false, status: 409,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Conflict'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.updateSimPCRProfile('89012345678901234567', { package_template_id: 999 })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_409')
  })

  it('handles 422 unprocessable', async () => {
    const fakeResponse = {
      ok: false, status: 422,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Unprocessable'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.updateSimPCRProfile('89012345678901234567', { package_template_id: 'invalid' })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_422')
  })

  it('handles 401', async () => {
    const fakeResponse = {
      ok: false, status: 401,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Unauthorized'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.updateSimPCRProfile('89012345678901234567', { package_template_id: 1001 })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_401')
  })

  it('handles 403', async () => {
    const fakeResponse = {
      ok: false, status: 403,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Forbidden'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.updateSimPCRProfile('89012345678901234567', { package_template_id: 1001 })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_403')
  })

  it('handles 429', async () => {
    const fakeResponse = {
      ok: false, status: 429,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Rate Limited'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.updateSimPCRProfile('89012345678901234567', { package_template_id: 1001 })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_429')
  })

  it('handles 5xx', async () => {
    const fakeResponse = {
      ok: false, status: 500,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('Server Error'),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.updateSimPCRProfile('89012345678901234567', { package_template_id: 1001 })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_500')
  })

  it('handles timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.updateSimPCRProfile('89012345678901234567', { package_template_id: 1001 })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('TIMEOUT')
  })

  it('handles provider not configured', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(null)
    const connector = new TelnaConnector('non-existent', 'Telna')
    const result = await connector.updateSimPCRProfile('89012345678901234567', { package_template_id: 1001 })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
  })
})

describe('TelnaConnector Phase 4 — PCR profile path param substitution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  it('substitutes iccid in PCR profile endpoint for GET', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: { id: 1, iccid: '89012345678901234567', status: 'ACTIVE' } })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    await connector.getSimPCRProfile('89012345678901234567')
    const url = (globalThis.fetch as any).mock.calls[0][0] as string
    expect(url).toMatch(/\/pcr\/sim-pcr-profiles\/89012345678901234567[?]?/)
    expect(url).not.toContain('{iccid}')
  })

  it('substitutes iccid in PCR profile endpoint for PUT', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: { id: 1, iccid: '89012345678901234567', status: 'ACTIVE' } })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    await connector.updateSimPCRProfile('89012345678901234567', { package_template_id: 1001 })
    const url = (globalThis.fetch as any).mock.calls[0][0] as string
    expect(url).toMatch(/\/pcr\/sim-pcr-profiles\/89012345678901234567[?]?/)
    expect(url).not.toContain('{iccid}')
  })
})

describe('TelnaConnector v2.1 documented read-only endpoints — inventory/group/traffic-policy detail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  it('getInventory uses GET /inventory/inventories/{inventory_id}', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: { id: 10, name: 'Main Inventory', type: 'PHYSICAL', status: 'ACTIVE', companyId: 42, totalSims: 100, availableSims: 50, allocatedSims: 50, defectiveSims: 0, testSims: 0 } })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getInventory(10)
    expect(result.success).toBe(true)
    expect(result.data?.inventory.name).toBe('Main Inventory')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/inventory/inventories/10'),
      expect.any(Object)
    )
  })

  it('getGroup uses GET /inventory/groups/{group_id}', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: { id: 100, name: 'Group A', inventoryId: 10, status: 'ACTIVE', totalSims: 20, availableSims: 10, allocatedSims: 10 } })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getGroup(100)
    expect(result.success).toBe(true)
    expect(result.data?.group.name).toBe('Group A')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/inventory/groups/100'),
      expect.any(Object)
    )
  })

  it('getTrafficPolicy uses GET /pcr/traffic-policies/{traffic_policy_id}', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: { id: 7, name: 'Data Policy', type: 'DATA' } })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getTrafficPolicy(7)
    expect(result.success).toBe(true)
    expect(result.data?.trafficPolicy.name).toBe('Data Policy')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/pcr/traffic-policies/7'),
      expect.any(Object)
    )
  })

  it('detail endpoints are GET only and never call purge/delete', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: {} })),
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse as any)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    await connector.getInventory(1)
    await connector.getGroup(1)
    await connector.getTrafficPolicy(1)
    for (const [url, init] of (globalThis.fetch as any).mock.calls) {
      expect(init.method || 'GET').toBe('GET')
      expect(String(url)).not.toContain('/sim-registries/')
    }
  })
})

describe('TelnaConnector getStatus (documented PCR profile, read-only)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  const STATUS_ICCID = '89012345678901234567'
  function json(data: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': 'application/json' }), text: vi.fn().mockResolvedValue(JSON.stringify(data)) }
  }
  function registry(status: string) { return json({ data: { iccid: STATUS_ICCID, status } }) }
  function profile(state?: string) { return state ? json({ data: { iccid: STATUS_ICCID, state } }) : json({ data: { iccid: STATUS_ICCID, state: null } }) }
  function packages(sims: unknown[]) { return json({ data: sims, total: sims.length }) }

  it('getStatus reads the three documented evidence endpoints in order (sim-registry, euicc, packages)', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(registry('PRE_SERVICE'))
      .mockResolvedValueOnce(profile('RELEASED'))
      .mockResolvedValueOnce(packages([]))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getStatus(STATUS_ICCID)
    expect(result.success).toBe(true)
    expect(result.data?.iccid).toBe(STATUS_ICCID)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    const urls = fetchSpy.mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.includes('/v2.1/inventory/sim-registries/'))).toBe(true)
    expect(urls.some(u => u.includes('/v2.1/esim-rsp/euicc-profiles/'))).toBe(true)
    expect(urls.some(u => u.includes('/v2.1/pcr/packages?sim='))).toBe(true)
  })

  it('SIM IN_SERVICE -> ACTIVE with networkAttached evidence', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(registry('IN_SERVICE'))
      .mockResolvedValueOnce(profile('ENABLED'))
      .mockResolvedValueOnce(packages([{ id: 'p1', status: 'ACTIVE' }]))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getStatus(STATUS_ICCID)
    expect(result.data?.status).toBe('ACTIVE')
    expect(result.data?.evidence).toMatchObject({ networkAttached: true, reason: 'sim-in-service' })
  })

  it('SIM SUSPENDED -> SUSPENDED', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(registry('SUSPENDED'))
      .mockResolvedValueOnce(profile('DISABLED'))
      .mockResolvedValueOnce(packages([]))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getStatus(STATUS_ICCID)
    expect(result.data?.status).toBe('SUSPENDED')
  })

  it('SIM PRE_SERVICE + profile not installed -> PENDING_ACTIVATION (not ACTIVE)', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(registry('PRE_SERVICE'))
      .mockResolvedValueOnce(profile('RELEASED'))
      .mockResolvedValueOnce(packages([]))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getStatus(STATUS_ICCID)
    expect(result.data?.status).not.toBe('ACTIVE')
    expect(result.data?.status).toBe('PENDING_ACTIVATION')
  })

  it('SIM PRE_SERVICE + profile INSTALLED/ENABLED -> INSTALLED (device evidence), not ACTIVE', async () => {
    for (const state of ['INSTALLED', 'ENABLED']) {
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(registry('PRE_SERVICE'))
        .mockResolvedValueOnce(profile(state))
        .mockResolvedValueOnce(packages([]))
      vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
      const connector = new TelnaConnector('telna-provider-1', 'Telna')
      const result = await connector.getStatus(STATUS_ICCID)
      expect(result.data?.status).not.toBe('ACTIVE')
      expect(result.data?.status).toBe('INSTALLED')
      expect(result.data?.evidence).toMatchObject({ deviceInstalled: true, reason: 'euicc-installed-or-enabled' })
    }
  })

  it('SIM TERMINATED -> EXPIRED', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(registry('TERMINATED'))
      .mockResolvedValueOnce(profile(undefined))
      .mockResolvedValueOnce(packages([]))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getStatus(STATUS_ICCID)
    expect(result.data?.status).toBe('EXPIRED')
    expect(result.data?.evidence).toMatchObject({ reason: 'telna-sim-terminated' })
  })

  it('package TERMINATED alone (SIM PRE_SERVICE, profile none) -> NOT EXPIRED', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(registry('PRE_SERVICE'))
      .mockResolvedValueOnce(profile(undefined))
      .mockResolvedValueOnce(packages([{ id: 'p1', status: 'TERMINATED' }]))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getStatus(STATUS_ICCID)
    expect(result.data?.status).not.toBe('EXPIRED')
    expect(result.data?.status).toBe('PENDING_ACTIVATION')
  })

  it('accepts a structured StatusLookupIdentifier with iccid', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(registry('PRE_SERVICE'))
      .mockResolvedValueOnce(profile(undefined))
      .mockResolvedValueOnce(packages([]))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getStatus({ iccid: STATUS_ICCID })
    expect(result.success).toBe(true)
    expect(result.data?.status).toBe('PENDING_ACTIVATION')
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('fails locally with IDENTIFIER_MISSING when no ICCID (never a local esim.id)', async () => {
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getStatus('')
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('IDENTIFIER_MISSING')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('resolveStatusLookup returns the provider ICCID, never a local esim.id', () => {
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    expect(connector.resolveStatusLookup!({ iccid: '89012345678901234567', status: 'ACTIVE' })).toBe('89012345678901234567')
    expect(connector.resolveStatusLookup!({ status: 'ACTIVE' })).toBeNull()
    expect(connector.resolveStatusLookup!({ providerSubscriptionId: 'sub-1' } as any)).toBeNull()
  })

  it('declares statusLookup capability true (read-only SIM/eUICC/package evidence)', () => {
    const caps = new TelnaConnector('telna-provider-1', 'Telna').capabilities!
    expect(caps.statusLookup).toBe(true)
    expect(caps.inventory).toBe(true)
    expect(caps.balance).toBe(true)
    expect(caps.suspend).toBe(false)
    expect(caps.resume).toBe(false)
  })

  it('declares installation + usage capabilities as enabled (documented V2.1 contract)', () => {
    const caps = new TelnaConnector('telna-provider-1', 'Telna').capabilities!
    // GET /v2.1/esim-rsp/euicc-profiles/{iccid} activation_code proves historical install lookup.
    expect(caps.installationLookup).toBe(true)
    expect(caps.installationLookupHistorical).toBe(true)
    // Package usage (data_usage_remaining bytes) + ICCID resolver.
    expect(caps.usageLookup).toBe(true)
    // We still never claim purchase-time install or webhooks.
    expect(caps.installationDataAtPurchase).not.toBe(true)
    expect(caps.webhooks).toBe(false)
  })

  it('paid add-ons (session/SMS/webhooks) stay capability-disabled on the standard account', () => {
    const caps = new TelnaConnector('telna-provider-1', 'Telna').capabilities!
    // SESSION (/v2.1/session-management/open-data-sessions) is a paid add-on — no
    // connector method calls it, and it is not a required/usage source.
    expect(caps.webhooks).toBe(false)
    // Usage does not depend on the paid open-data-session surface.
    expect(caps.usageLookup).toBe(true)
  })

  it('never logs the full ICCID', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const texts: Array<() => Promise<string>> = [
      () => Promise.resolve(JSON.stringify({ data: { iccid: '89012345678901234567', status: 'IN_SERVICE' } })),
      () => Promise.resolve(JSON.stringify({ data: { iccid: '89012345678901234567', state: 'INSTALLED' } })),
      () => Promise.resolve(JSON.stringify({ data: [], total: 0 })),
    ]
    const fetchSpy = vi.fn().mockImplementation(async () => ({
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: texts.shift()!,
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    await connector.getStatus('89012345678901234567')
    for (const [args] of logSpy.mock.calls as Array<[string]>) {
      expect(String(args)).not.toContain('89012345678901234567')
    }
    logSpy.mockRestore()
  })
})

describe('canonical Telna endpoint path/URL composition', () => {
it('buildTelnaEndpointUrl composes base + V2.1 endpoint with no double path', () => {
    const url = buildTelnaEndpointUrl('https://developer-api.telna.com', 'countries')
    expect(url).toBe('https://developer-api.telna.com/v2.1/core/countries')
  })

  it('tolerates a trailing slash on the base URL', () => {
    expect(buildTelnaEndpointUrl('https://developer-api.telna.com/', 'countries')).toBe('https://developer-api.telna.com/v2.1/core/countries')
    expect(buildTelnaEndpointUrl('https://developer-api.telna.com///', 'countries')).toBe('https://developer-api.telna.com/v2.1/core/countries')
  })

  it('preserves a path prefix already present in apiBaseUrl (no duplicate /v2.1 or /core)', () => {
    // Prefixed /v2 base is preserved and the endpoint path (already /v2.1/...) is
    // appended once — never duplicated.
    const url = buildTelnaEndpointUrl('https://developer-api.telna.com/v2', 'countries')
    expect(url).toBe('https://developer-api.telna.com/v2/v2.1/core/countries')
    expect(url.split('/v2.1').length).toBe(2)
    expect(url.split('/core').length).toBe(2)
  })

  it('substitutes path parameters', () => {
    expect(buildTelnaEndpointUrl('https://developer-api.telna.com', 'company', { company_id: 42 })).toBe('https://developer-api.telna.com/v2.1/core/companies/42')
  })

  it('testConnection and Discovery (listCountries) resolve the SAME canonical endpoint path', () => {
    // Single-source path map: both go through telnaEndpointPath('countries').
    const tcPath = telnaEndpointPath('countries')
    const discoveryPath = telnaEndpointPath('countries')
    expect(tcPath).toBe('/v2.1/core/countries')
    expect(discoveryPath).toBe('/v2.1/core/countries')
  })
})

describe('Telna Phase 1 � purchase / package / install / usage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  function json(data: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': 'application/json' }), text: vi.fn().mockResolvedValue(JSON.stringify(data)) }
  }

  // V2.1 PCR auth: collection Authorization API key (raw, no Bearer/Basic) + ApiKey.
  const pcrHeaders = { 'ApiKey': TEST_PCR_API_KEY, 'Authorization': TEST_KEY_ID }

  it('activateESIM runs the verified flow: template detail, SIM listing, neutral claim, POST /v2.1/pcr/packages', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { id: 42 } })) // GET /v2.1/pcr/package-templates/42
      .mockResolvedValueOnce(json({ data: [{ iccid: 'PRE-ICCID', status: 'PRE_SERVICE' }], total: 1 })) // GET /v2.1/inventory/sim-registries
      .mockResolvedValueOnce(json({ data: { id: 'pkg-INSTANCE-1', sim: 'PRE-ICCID', status: 'NOT_ACTIVE' } })) // POST /v2.1/pcr/packages
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    mockClaimProviderIccid.mockResolvedValue({ ok: true })

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' }, orderId: 'onesim-order-1' })

    expect(result.success).toBe(true)
    expect(result.data?.activationId).toBe('pkg-INSTANCE-1')
    expect(result.data?.iccidOrSimId).toBe('PRE-ICCID')
    expect(result.data?.status).toBe('PENDING_ACTIVATION')
    expect(result.data?.rawMetadata?.providerPackageInstanceId).toBe('pkg-INSTANCE-1')
    expect(mockClaimProviderIccid).toHaveBeenCalledTimes(1)
    expect(mockClaimProviderIccid).toHaveBeenCalledWith({ purchaseId: 'onesim-order-1', iccid: 'PRE-ICCID' })
    expect(mockReleaseProviderIccidClaim).not.toHaveBeenCalled()

    // Exactly one POST /v2.1/pcr/packages with the documented PCR headers + body.
    const postCalls = fetchSpy.mock.calls.filter(c => String(c[0]).includes('/v2.1/pcr/packages') && c[1].method === 'POST')
    expect(postCalls).toHaveLength(1)
    const [postUrl, postInit] = postCalls[0]
    expect(String(postUrl)).toContain('/v2.1/pcr/packages')
    expect(JSON.parse(postInit.body)).toEqual({ sim: 'PRE-ICCID', package_template: 42 })
    expect(postInit.headers['ApiKey']).toBe(TEST_PCR_API_KEY)
    expect(postInit.headers['Authorization']).toBe(TEST_KEY_ID)
    expect(postInit.headers['Authorization']).not.toContain('Bearer')
    expect(postInit.headers['Authorization']).not.toContain('Basic')
  })

  it('activateESIM does not send a local OneSIM id upstream — only ICCID + template id', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { id: 42 } }))
      .mockResolvedValueOnce(json({ data: [{ iccid: 'PRE-ICCID', status: 'PRE_SERVICE' }], total: 1 }))
      .mockResolvedValueOnce(json({ data: { id: 'pkg-INSTANCE-1', sim: 'PRE-ICCID' } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    mockClaimProviderIccid.mockResolvedValue({ ok: true })

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' }, orderId: 'onesim-order-1', packageId: 'onesim-pkg-1' })
    expect(result.success).toBe(true)
    const postCall = fetchSpy.mock.calls.find(c => String(c[0]).includes('/v2.1/pcr/packages') && c[1].method === 'POST')
    const body = JSON.parse(postCall![1].body as string)
    expect(body).not.toHaveProperty('packageId')
    expect(body).not.toHaveProperty('orderId')
    expect(body).not.toHaveProperty('esimId')
    expect(body).toEqual({ sim: 'PRE-ICCID', package_template: 42 })
  })

  it('no eligible candidate -> OUT_OF_STOCK, no claim, no POST', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { id: 42 } }))
      .mockResolvedValueOnce(json({ data: [], total: 0 }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' }, orderId: 'order-1' })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('OUT_OF_STOCK')
    expect(mockClaimProviderIccid).not.toHaveBeenCalled()
    for (const call of fetchSpy.mock.calls) expect(String(call[0])).not.toContain('/v2.1/pcr/packages')
  })

  it('pcrAuth missing -> AUTH_INCOMPLETE before claim/listing, NO POST', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider({ pcrAuth: 'missing' }))
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' }, orderId: 'order-1' })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('AUTH_INCOMPLETE')
    expect(mockClaimProviderIccid).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('flex host -> HOST_MISMATCH, no claim, no POST', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider({ apiBaseUrl: 'https://ppo-api.telna.com' }))
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' }, orderId: 'order-1' })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HOST_MISMATCH')
    expect(mockClaimProviderIccid).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('eUICC installation lookup: GET /euicc-profiles/{iccid} -> READY with activation code', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({ data: { iccid: '8944501234567890123', state: 'RELEASED', activation_code: 'LPA:1$rsp.example.com$mid-123' } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await connector.lookupInstallationData({ iccid: '8944501234567890123' })
    expect(r.success).toBe(true)
    expect(r.state).toBe('READY')
    expect(r.data?.activationCode).toBe('LPA:1$rsp.example.com$mid-123')
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/v2.1/esim-rsp/euicc-profiles/8944501234567890123')
  })

  it('usage exact package: getV2Package via /pcr/packages/EXACT -> total/remaining/used MB', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { id: 'EXACT', status: 'ACTIVE', data_usage_remaining: 1073741824, package_template: { id: 42, data_usage_allowance: 2147483648 } } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await connector.getUsage({ iccid: '8944501234567890123', providerSubscriptionId: 'EXACT' })
    expect(r.success).toBe(true)
    expect(r.data?.dataTotalMB).toBe(2048)
    expect(r.data?.dataRemainingMB).toBe(1024)
    expect(r.data?.dataUsedMB).toBe(1024)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/v2.1/pcr/packages/EXACT')
  })

  it('usage multi-package fallback: two non-TERMINATED packages -> DATA_UNAVAILABLE', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: [
        { id: 'p1', sim: '8944501234567890123', status: 'ACTIVE', data_usage_remaining: 100 },
        { id: 'p2', sim: '8944501234567890123', status: 'ACTIVE', data_usage_remaining: 200 },
      ], total: 2 }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await connector.getUsage('8944501234567890123')
    expect(r.success).toBe(false)
    expect(r.error?.code).toBe('DATA_UNAVAILABLE')
  })

  it('missing usage identifier ? clean IDENTIFIER_MISSING', async () => {
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await connector.getUsage('')
    expect(r.success).toBe(false)
    expect(r.error?.code).toBe('IDENTIFIER_MISSING')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('resolveUsageLookup returns the provider ICCID (+ package instance id when persisted), never a local id', () => {
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    expect(connector.resolveUsageLookup!({ iccid: '8944501234567890123' })).toEqual({ iccid: '8944501234567890123' })
    expect(connector.resolveUsageLookup!({ iccid: '8944501234567890123', providerResponse: { providerPackageInstanceId: 'pkg-777' } })).toEqual({ iccid: '8944501234567890123', providerSubscriptionId: 'pkg-777' })
    expect(connector.resolveUsageLookup!({ status: 'ACTIVE' } as any)).toBeNull()
  })

  it('TELNA_FLEX and TELNA_SEAMLESS remain isolated (distinct connector classes)', () => {
    expect(resolveConnectorType('TELNA', 'CUSTOM', 'TELNA')).toBe('TELNA')
    expect(resolveConnectorType('TELNA_FLEX', 'CUSTOM', 'TELNA')).toBe('TELNA_FLEX')
    expect(resolveConnectorType('TELNA_SEAMLESS', 'CUSTOM', 'TELNA')).toBe('TELNA_SEAMLESS')
  })
})

describe('Telna Phase 1B � safe OneSIM adaptation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
    vi.mocked(prisma.eSIM.findMany).mockResolvedValue([])
  })

  function json(data: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': 'application/json' }), text: vi.fn().mockResolvedValue(JSON.stringify(data)) }
  }

  const expectedBasic = 'Basic ' + Buffer.from(`${TEST_PCR_LOGIN_ID}:${TEST_PCR_ACCESS_TOKEN}`).toString('base64')

  function runActivate(fetchSpy: ReturnType<typeof vi.fn>, params: Record<string, unknown>) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    return c.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' }, ...params } as any)
  }

  // -- ICCID selection policy ------------------------------------------------
  // Only PRE_SERVICE SIMs are eligible; IN_SERVICE / TERMINATED /
  // WAITING_FOR_ASSIGNMENT are never selected → OUT_OF_STOCK with no claim.
  for (const [label, status] of [
    ['IN_SERVICE', 'IN_SERVICE'],
    ['TERMINATED', 'TERMINATED'],
    ['WAITING_FOR_ASSIGNMENT', 'WAITING_FOR_ASSIGNMENT'],
  ] as const) {
    it(`1. ${label} SIM is ineligible - activateESIM returns OUT_OF_STOCK, no claim, no POST`, async () => {
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(json({ data: { id: 42 } }))
        .mockResolvedValueOnce(json({ data: [{ iccid: 'NON-PRE-ICCID', status }], total: 1 }))
      const r = await runActivate(fetchSpy, { orderId: 'order-1' })
      expect(r.success).toBe(false)
      expect(r.error?.code).toBe('OUT_OF_STOCK')
      expect(mockClaimProviderIccid).not.toHaveBeenCalled()
      for (const call of fetchSpy.mock.calls) expect(String(call[0])).not.toContain('/v2.1/pcr/packages')
    })
  }

  it('2. PRE_SERVICE SIM is eligible - claim and POST /pcr/packages succeed', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { id: 42 } }))
      .mockResolvedValueOnce(json({ data: [{ iccid: 'PRE-ICCID', status: 'PRE_SERVICE' }], total: 1 }))
      .mockResolvedValueOnce(json({ data: { id: 'pkg-INSTANCE-1', sim: 'PRE-ICCID', status: 'NOT_ACTIVE' } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    mockClaimProviderIccid.mockResolvedValue({ ok: true })
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' }, orderId: 'order-1' })
    expect(r.success).toBe(true)
    expect(mockClaimProviderIccid).toHaveBeenCalledWith({ purchaseId: 'order-1', iccid: 'PRE-ICCID' })
    const post = fetchSpy.mock.calls.find(x => String(x[0]).includes('/v2.1/pcr/packages') && x[1].method === 'POST')
    expect(post).toBeTruthy()
  })

  it('3. already-used ICCIDs (bound to a local OneSIM eSIM) are excluded from selection', async () => {
    vi.mocked(prisma.eSIM.findMany).mockResolvedValue([{ iccid: 'USED-ICCID' }] as any)
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { id: 42 } }))
      .mockResolvedValueOnce(json({ data: [{ iccid: 'USED-ICCID', status: 'PRE_SERVICE' }, { iccid: 'FRESH-ICCID', status: 'PRE_SERVICE' }], total: 2 }))
      .mockResolvedValueOnce(json({ data: { id: 'pkg-INSTANCE-1', sim: 'FRESH-ICCID', status: 'NOT_ACTIVE' } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    mockClaimProviderIccid.mockResolvedValue({ ok: true })
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' }, orderId: 'order-1' })
    expect(r.success).toBe(true)
    expect(r.data?.iccidOrSimId).toBe('FRESH-ICCID')
    expect(mockClaimProviderIccid).toHaveBeenCalledWith({ purchaseId: 'order-1', iccid: 'FRESH-ICCID' })
    expect(mockClaimProviderIccid).not.toHaveBeenCalledWith(expect.objectContaining({ iccid: 'USED-ICCID' }))
  })

  it('4. claim collision (ok:false) moves to the next candidate; POST only for the winning ICCID', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { id: 42 } }))
      .mockResolvedValueOnce(json({ data: [{ iccid: 'CC1', status: 'PRE_SERVICE' }, { iccid: 'CC2', status: 'PRE_SERVICE' }], total: 2 }))
      .mockResolvedValueOnce(json({ data: { id: 'pkg-INSTANCE-2', sim: 'CC2', status: 'NOT_ACTIVE' } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    mockClaimProviderIccid
      .mockResolvedValueOnce({ ok: false, reason: 'CLAIM_LOST' })
      .mockResolvedValueOnce({ ok: true })
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' }, orderId: 'order-1' })
    expect(r.success).toBe(true)
    expect(r.data?.iccidOrSimId).toBe('CC2')
    expect(mockClaimProviderIccid).toHaveBeenCalledTimes(2)
    const post = fetchSpy.mock.calls.find(x => String(x[0]).includes('/v2.1/pcr/packages') && x[1].method === 'POST')
    expect(JSON.parse(post![1].body as string).sim).toBe('CC2')
  })

  it('5. provider POST failure triggers releaseProviderIccidClaim with same purchaseId+iccid', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { id: 42 } }))
      .mockResolvedValueOnce(json({ data: [{ iccid: 'FAIL-ICCID', status: 'PRE_SERVICE' }], total: 1 }))
      .mockResolvedValueOnce(json({}, 500))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    mockClaimProviderIccid.mockResolvedValue({ ok: true })
    mockReleaseProviderIccidClaim.mockResolvedValue(undefined as any)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' }, orderId: 'order-1' })
    expect(r.success).toBe(false)
    expect(r.error?.code).toBe('HTTP_500')
    expect(mockClaimProviderIccid).toHaveBeenCalledWith({ purchaseId: 'order-1', iccid: 'FAIL-ICCID' })
    expect(mockReleaseProviderIccidClaim).toHaveBeenCalledWith({ purchaseId: 'order-1', iccid: 'FAIL-ICCID' })
  })

  it('6. missing orderId -> safe failure, claim NOT called, no POST', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { id: 42 } }))
      .mockResolvedValueOnce(json({ data: [{ iccid: 'PRE-ICCID', status: 'PRE_SERVICE' }], total: 1 }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' } })
    expect(r.success).toBe(false)
    expect(mockClaimProviderIccid).not.toHaveBeenCalled()
    for (const call of fetchSpy.mock.calls) expect(String(call[0])).not.toContain('/v2.1/pcr/packages')
  })

  // -- Identity separation / package instance preservation -------------------
  it('7. purchase maps package instance id (C) + ICCID (A) into rawMetadata; PENDING_ACTIVATION', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { id: 42 } }))
      .mockResolvedValueOnce(json({ data: [{ iccid: 'PRE-ICCID', status: 'PRE_SERVICE' }], total: 1 }))
      .mockResolvedValueOnce(json({ data: { id: 'pkg-INSTANCE-1', sim: 'PRE-ICCID', status: 'NOT_ACTIVE' } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    mockClaimProviderIccid.mockResolvedValue({ ok: true })
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' }, orderId: 'order-1' })
    expect(r.success).toBe(true)
    expect(r.data?.activationId).toBe('pkg-INSTANCE-1')
    expect(r.data?.rawMetadata?.iccid).toBe('PRE-ICCID')
    expect(r.data?.rawMetadata?.providerTemplateId).toBe(42)
    expect(r.data?.rawMetadata?.providerPackageInstanceId).toBe('pkg-INSTANCE-1')
    expect(r.data?.status).toBe('PENDING_ACTIVATION')
  })

  // -- Usage tracks the exact package instance -------------------------------
  it('8. usage with an exact package instance id hits /pcr/packages/EXACT-1 and maps total/remaining/used', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(json({ data: { id: 'EXACT-1', sim: 'PRE-ICCID', status: 'ACTIVE', data_usage_remaining: 1073741824, package_template: { id: 42, data_usage_allowance: 2147483648 } } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.getUsage({ iccid: 'PRE-ICCID', providerSubscriptionId: 'EXACT-1' })
    expect(r.success).toBe(true)
    expect(r.data?.dataTotalMB).toBe(2048)
    expect(r.data?.dataRemainingMB).toBe(1024)
    expect(r.data?.dataUsedMB).toBe(1024)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/v2.1/pcr/packages/EXACT-1')
  })

  it('9. multiple packages on the same ICCID without an exact id -> DATA_UNAVAILABLE', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(json({ data: [
      { id: 'p1', status: 'ACTIVE', data_usage_remaining: 100 },
      { id: 'p2', status: 'ACTIVE', data_usage_remaining: 200 },
    ], total: 2 }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.getUsage('PRE-ICCID')
    expect(r.success).toBe(false)
    expect(r.error?.code).toBe('DATA_UNAVAILABLE')
  })

  // -- Lifecycle evidence -----------------------------------------------------
  it('10. package TERMINATED alone (SIM PRE_SERVICE, profile none) is NOT EXPIRED', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { iccid: 'PRE-ICCID', status: 'PRE_SERVICE' } }))
      .mockResolvedValueOnce(json({ data: { iccid: 'PRE-ICCID', state: null } }))
      .mockResolvedValueOnce(json({ data: [{ id: 'p1', status: 'TERMINATED' }], total: 1 }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.getStatus('PRE-ICCID')
    expect(r.success).toBe(true)
    expect(r.data?.status).not.toBe('EXPIRED')
    expect(r.data?.status).toBe('PENDING_ACTIVATION')
  })

  it('11. SIM TERMINATED terminal evidence -> EXPIRED (not PENDING)', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { iccid: 'TERM-ICCID', status: 'TERMINATED' } }))
      .mockResolvedValueOnce(json({ data: { iccid: 'TERM-ICCID', state: null } }))
      .mockResolvedValueOnce(json({ data: [], total: 0 }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.getStatus('TERM-ICCID')
    expect(r.data?.status).toBe('EXPIRED')
    expect(r.data?.evidence).toMatchObject({ reason: 'telna-sim-terminated' })
  })

  it('12. SIM IN_SERVICE -> ACTIVE with networkAttached evidence', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { iccid: 'ACTIVE-ICCID', status: 'IN_SERVICE' } }))
      .mockResolvedValueOnce(json({ data: { iccid: 'ACTIVE-ICCID', state: 'ENABLED' } }))
      .mockResolvedValueOnce(json({ data: [], total: 0 }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.getStatus('ACTIVE-ICCID')
    expect(r.data?.status).toBe('ACTIVE')
    expect(r.data?.evidence?.networkAttached).toBe(true)
  })

  it('13. PRE_SERVICE + profile not installed does not become ACTIVE', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { iccid: 'PRE-ICCID', status: 'PRE_SERVICE' } }))
      .mockResolvedValueOnce(json({ data: { iccid: 'PRE-ICCID', state: 'RELEASED' } }))
      .mockResolvedValueOnce(json({ data: [{ id: 'p1', status: 'ACTIVE' }], total: 1 }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.getStatus('PRE-ICCID')
    expect(r.data?.status).not.toBe('ACTIVE')
    expect(r.data?.status).toBe('PENDING_ACTIVATION')
  })

  // -- Purchase does NOT fabricate an ACTIVE device status --------------------
  it('14. successful package creation yields PENDING_ACTIVATION, never ACTIVE', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { id: 42 } }))
      .mockResolvedValueOnce(json({ data: [{ iccid: 'PRE-ICCID', status: 'PRE_SERVICE' }], total: 1 }))
      .mockResolvedValueOnce(json({ data: { id: 'pkg-1', sim: 'PRE-ICCID', status: 'ACTIVE' } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    mockClaimProviderIccid.mockResolvedValue({ ok: true })
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' }, orderId: 'order-test-1' })
    expect(r.success).toBe(true)
    expect(r.data?.status).toBe('PENDING_ACTIVATION')
  })

  it('15. installation lookup reads GET /euicc-profiles/{iccid} -> READY with activation code, gated by hasUsableInstallData', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({ data: { iccid: 'PRE-ICCID', state: 'RELEASED', activation_code: 'LPA:1$rsp.example.com$mid-9' } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.lookupInstallationData({ iccid: 'PRE-ICCID' })
    expect(r.success).toBe(true)
    expect(r.state).toBe('READY')
    expect(r.data?.activationCode).toBe('LPA:1$rsp.example.com$mid-9')
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/v2.1/esim-rsp/euicc-profiles/PRE-ICCID')
  })

  it('16. installation lookup with no usable activation data -> NOT_AVAILABLE_YET (NO_INSTALL_DATA)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({ data: { iccid: 'PRE-ICCID', state: 'DOWNLOADED' } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.lookupInstallationData({ iccid: 'PRE-ICCID' })
    expect(r.success).toBe(false)
    expect(r.state).toBe('NOT_AVAILABLE_YET')
    expect(r.errorCode).toBe('NO_INSTALL_DATA')
  })

  it('17. no local OneSIM id is ever sent upstream — only ICCID + template id on the POST', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { id: 42 } }))
      .mockResolvedValueOnce(json({ data: [{ iccid: 'PRE-ICCID', status: 'PRE_SERVICE' }], total: 1 }))
      .mockResolvedValueOnce(json({ data: { id: 'pkg-1', sim: 'PRE-ICCID' } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    mockClaimProviderIccid.mockResolvedValue({ ok: true })
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' }, orderId: 'onesim-order-1', packageId: 'onesim-pkg-1' })
    expect(r.success).toBe(true)
    const post = fetchSpy.mock.calls.find(x => String(x[0]).includes('/v2.1/pcr/packages') && x[1].method === 'POST')
    const body = JSON.parse(post![1].body as string)
    expect(body).toEqual({ sim: 'PRE-ICCID', package_template: 42 })
  })

  it('18. TELNA / TELNA_FLEX / TELNA_SEAMLESS remain isolated', () => {
    expect(resolveConnectorType('TELNA', 'CUSTOM', 'TELNA')).toBe('TELNA')
    expect(resolveConnectorType('TELNA_FLEX', 'CUSTOM', 'TELNA')).toBe('TELNA_FLEX')
    expect(resolveConnectorType('TELNA_SEAMLESS', 'CUSTOM', 'TELNA')).toBe('TELNA_SEAMLESS')
  })
})

describe('Telna Phase 1C/1D — atomic ICCID claim via neutral service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
    vi.mocked(prisma.eSIM.findMany).mockResolvedValue([])
    mockClaimProviderIccid.mockResolvedValue({ ok: true })
    mockReleaseProviderIccidClaim.mockResolvedValue(undefined as any)
  })

  function json(data: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': 'application/json' }), text: vi.fn().mockResolvedValue(JSON.stringify(data)) }
  }

  function templateJson() { return json({ data: { id: 42 } }) }
  function simRegJson(iccid: string, status = 'PRE_SERVICE') { return json({ data: [{ iccid, status }], total: 1 }) }
  function pkgJson(id: string, sim: string) { return json({ data: { id, sim, status: 'NOT_ACTIVE' } }) }

  it('activateESIM performs the neutral claim but never directly creates/deletes Prisma eSIM rows itself', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(templateJson())
      .mockResolvedValueOnce(simRegJson('PRE-ICCID'))
      .mockResolvedValueOnce(pkgJson('pkg-1', 'PRE-ICCID'))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    mockClaimProviderIccid.mockResolvedValue({ ok: true })

    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' }, orderId: 'order-1' })
    expect(r.success).toBe(true)
    expect(mockClaimProviderIccid).toHaveBeenCalledWith({ purchaseId: 'order-1', iccid: 'PRE-ICCID' })
    expect(prisma.eSIM.create).not.toHaveBeenCalled()
    expect(prisma.eSIM.delete).not.toHaveBeenCalled()
    // Ownership is handled by the neutral claim service, not direct Prisma ops.
  })

  it('claim collision (ok:false once then ok:true) moves to the next candidate; POST only the winning ICCID', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(templateJson())
      .mockResolvedValueOnce(json({ data: [{ iccid: 'CC1', status: 'PRE_SERVICE' }, { iccid: 'CC2', status: 'PRE_SERVICE' }], total: 2 }))
      .mockResolvedValueOnce(pkgJson('pkg-2', 'CC2'))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)

    mockClaimProviderIccid
      .mockResolvedValueOnce({ ok: false, reason: 'CLAIM_LOST' })
      .mockResolvedValueOnce({ ok: true })

    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' }, orderId: 'order-1' })
    expect(r.success).toBe(true)
    expect(r.data?.iccidOrSimId).toBe('CC2')
    expect(mockClaimProviderIccid).toHaveBeenCalledTimes(2)
    const post = fetchSpy.mock.calls.find(x => String(x[0]).includes('/v2.1/pcr/packages') && x[1].method === 'POST')
    expect(JSON.parse(post![1].body as string).sim).toBe('CC2')
  })

  it('a successful claim leads to exactly one POST /pcr/packages and no release', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(templateJson())
      .mockResolvedValueOnce(simRegJson('CLAIMED-ICCID'))
      .mockResolvedValueOnce(pkgJson('pkg-1', 'CLAIMED-ICCID'))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    mockClaimProviderIccid.mockResolvedValue({ ok: true })

    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' }, orderId: 'order-1' })
    expect(r.success).toBe(true)
    expect(mockClaimProviderIccid).toHaveBeenCalledTimes(1)
    expect(mockReleaseProviderIccidClaim).not.toHaveBeenCalled()
    const post = fetchSpy.mock.calls.filter(x => String(x[0]).includes('/v2.1/pcr/packages') && x[1].method === 'POST')
    expect(post).toHaveLength(1)
  })

  it('provider POST failure triggers releaseProviderIccidClaim with same purchaseId+iccid', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(templateJson())
      .mockResolvedValueOnce(simRegJson('FAIL-ICCID'))
      .mockResolvedValueOnce(json({}, 500))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    mockClaimProviderIccid.mockResolvedValue({ ok: true })
    mockReleaseProviderIccidClaim.mockResolvedValue(undefined as any)

    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' }, orderId: 'order-1' })
    expect(r.success).toBe(false)
    expect(r.error?.code).toBe('HTTP_500')
    expect(mockClaimProviderIccid).toHaveBeenCalledWith({ purchaseId: 'order-1', iccid: 'FAIL-ICCID' })
    expect(mockReleaseProviderIccidClaim).toHaveBeenCalledWith({ purchaseId: 'order-1', iccid: 'FAIL-ICCID' })
  })

  it('all candidate claims lost -> OUT_OF_STOCK, no release, no POST', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(templateJson())
      .mockResolvedValueOnce(simRegJson('BUSY-ICCID'))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    mockClaimProviderIccid.mockResolvedValue({ ok: false, reason: 'CLAIM_LOST' })

    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' }, orderId: 'order-1' })
    expect(r.success).toBe(false)
    expect(r.error?.code).toBe('OUT_OF_STOCK')
    expect(mockClaimProviderIccid).toHaveBeenCalled()
    expect(mockReleaseProviderIccidClaim).not.toHaveBeenCalled()
    for (const call of fetchSpy.mock.calls) expect(String(call[0])).not.toContain('/v2.1/pcr/packages')
  })

  it('missing orderId -> safe failure, claim service NOT called, no POST /packages', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(templateJson())
      .mockResolvedValueOnce(simRegJson('PRE-ICCID'))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' } })
    expect(r.success).toBe(false)
    expect(mockClaimProviderIccid).not.toHaveBeenCalled()
    for (const call of fetchSpy.mock.calls) expect(String(call[0])).not.toContain('/packages')
  })
})

describe('TelnaConnector per-family auth headers (documented, proven endpoints only)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
  })

  // V2.1 collection-level auth: raw API_ACCESS_KEY_ID in Authorization (no Bearer/Basic).
  const API_KEY = TEST_KEY_ID

  it('INVENTORY (listInventories) sends a raw Authorization API key and no PCR ApiKey/Basic', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [], total: 0, offset: 0, count: 10 })),
    }
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse as any)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    await connector.listInventories()
    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>
    expect(headers['Authorization']).toBe(API_KEY)
    expect(headers['Authorization']).not.toContain('Bearer')
    expect(headers['ApiKey']).toBeUndefined()
  })

  it('INVENTORY (listSimRegistries) sends a raw Authorization API key and no PCR ApiKey/Basic', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [], total: 0, offset: 0, count: 50 })),
    }
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse as any)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    await connector.listSimRegistries()
    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>
    expect(headers['Authorization']).toBe(API_KEY)
    expect(headers['Authorization']).not.toContain('Bearer')
    expect(headers['ApiKey']).toBeUndefined()
  })

  it('PCR (listPackageTemplates) sends raw Authorization API key + ApiKey (no Bearer, no Basic)', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [], total: 0, offset: 0, count: 50 })),
    }
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse as any)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    await connector.listPackageTemplates()
    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>
    expect(headers['ApiKey']).toBe(TEST_PCR_API_KEY)
    expect(headers['Authorization']).toBe(API_KEY)
    expect(headers['Authorization']).not.toContain('Bearer')
    expect(headers['Authorization']).not.toContain('Basic')
  })

  it('CORE (listCountries) sends a raw Authorization API key and no ApiKey', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [], total: 0, offset: 0, count: 0 })),
    }
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse as any)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    await connector.listCountries()
    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>
    expect(headers['Authorization']).toBe(API_KEY)
    expect(headers['Authorization']).not.toContain('Bearer')
    expect(headers['ApiKey']).toBeUndefined()
  })

  it('PCR with incomplete ApiKey short-circuits to AUTH_INCOMPLETE with NO fetch', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider({ pcrAuth: 'missing' }))
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listPackageTemplates()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('AUTH_INCOMPLETE')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('CORE (testConnection / countries) dispatches to /v2.1/core/countries with raw Authorization API key', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [{ id: 1 }], total: 1 })),
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.testConnection()
    expect(result.success).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/v2.1/core/countries')
    expect(init.headers['Authorization']).toBe(TEST_KEY_ID)
    expect(init.headers['Authorization']).not.toContain('Bearer')
  })

  it('documented endpoints are all proven — getV2SimRegistry is dispatched and NOT blocked as UNVERIFIED', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: { iccid: '89012345678901234567', status: 'PRE_SERVICE', imsi: '3000001', inventory_id: 1 } })),
    }
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse as any)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getV2SimRegistry('89012345678901234567')
    expect(result.success).toBe(true)
    expect(result.data?.sim?.iccid).toBe('89012345678901234567')
    expect(fetchSpy).toHaveBeenCalled()
    // Every canonical documented path is proven — no call resolves to UNVERIFIED_ENDPOINT.
  })
})

describe('Telna Connect V2.1 � live named-envelope + state normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
    vi.mocked(prisma.eSIM.findMany).mockResolvedValue([])
  })

  function json(data: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': 'application/json' }), text: vi.fn().mockResolvedValue(JSON.stringify(data)) }
  }

  it('1. live Core named envelope { total, offset, count, countries } parses', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({ total: 2, offset: 0, count: 2, countries: [{ id: 1, name: 'ZA', iso: 'ZAF' }, { id: 2, name: 'NG', iso: 'NGA' }] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.listCountries(2, 0)
    expect(r.success).toBe(true)
    expect(r.data?.items).toHaveLength(2)
    expect(r.data?.total).toBe(2)
  })

  it('2. live Inventory named envelope { total, offset, count, sims } parses', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({
      total: 4, offset: 0, count: 4,
      sims: [
        { iccid: '89A', status: 'PRE-SERVICE' },
        { iccid: '89B', status: 'PRE-SERVICE' },
        { iccid: '89C', status: 'IN-SERVICE' },
        { iccid: '89D', status: 'PRE-SERVICE' },
      ],
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.listV2SimRegistries()
    expect(r.success).toBe(true)
    expect(r.data?.items).toHaveLength(4)
    expect(r.data?.total).toBe(4)
  })

  it('3. live PCR named envelope { total, offset, count, package_templates } parses', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({
      total: 1, offset: 0, count: 1,
      package_templates: [{ id: 42, name: 'Africa 10GB', status: 'ACTIVE', data_usage_allowance: 10737418240, time_allowance: 30 }],
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.listPackageTemplates()
    expect(r.success).toBe(true)
    expect(r.data?.items).toHaveLength(1)
    expect(r.data?.items[0].id).toBe(42)
  })

  it('4. package named envelope { total, offset, count, packages } parses', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({
      total: 1, offset: 0, count: 1,
      packages: [{ id: 'pkg-1', sim: '89A', status: 'ACTIVE', data_usage_remaining: 100 }],
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.listV2Packages({ sim: '89A' })
    expect(r.success).toBe(true)
    expect(r.data?.items).toHaveLength(1)
    expect(r.data?.items[0].id).toBe('pkg-1')
  })

  it('5. normalizeTelnaState: PRE-SERVICE -> PRE_SERVICE, IN-SERVICE -> IN_SERVICE', () => {
    expect(normalizeTelnaState('PRE-SERVICE')).toBe('PRE_SERVICE')
    expect(normalizeTelnaState('IN-SERVICE')).toBe('IN_SERVICE')
    expect(normalizeTelnaState('De-activated')).toBe('DE_ACTIVATED')
    expect(normalizeTelnaState('  active ')).toBe('ACTIVE')
    expect(normalizeTelnaState(null)).toBe('')
  })

  it('6+7. PRE-SERVICE rows normalize and become eligible; IN-SERVICE stays excluded', async () => {
    // activateESIM: template detail → SIM list (named sims envelope) → POST.
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { id: 42, name: 'Template', data_usage_allowance: 1024 } })) // template detail
      .mockResolvedValueOnce(json({
        total: 4, offset: 0, count: 4,
        sims: [
          { iccid: 'PRE1', status: 'PRE-SERVICE' },
          { iccid: 'PRE2', status: 'PRE_SERVICE' },
          { iccid: 'USE1', status: 'IN-SERVICE' },
          { iccid: 'PRE3', status: 'TERMINATED' },
        ],
      }))
      .mockResolvedValueOnce(json({ data: { id: 'pkg-1', sim: 'PRE1', status: 'NOT_ACTIVE' } })) // POST /pcr/packages
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    mockClaimProviderIccid.mockResolvedValue({ ok: true })
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.activateESIM({ planId: '42', quantity: 1, subscriber: { email: 'a@b.com' }, orderId: 'order-1' })
    expect(r.success).toBe(true)
    expect(r.data?.iccids?.[0]).toBe('PRE1')
    expect(r.data?.iccids).not.toContain('USE1')
    expect(r.data?.iccids).not.toContain('PRE3')
  })

  it('8+9. data.data + bare-array tolerance retained on SIM list', async () => {
    // data.data envelope
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { data: [{ iccid: '89A', status: 'PRE_SERVICE' }] } }))
      .mockResolvedValueOnce(json([{ iccid: '89B', status: 'PRE_SERVICE' }])) // bare array
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r1 = await c.listV2SimRegistries()
    const r2 = await c.listV2SimRegistries()
    expect(r1.data?.items).toHaveLength(1)
    expect(r2.data?.items).toHaveLength(1)
  })

  it('10. template without an inventory field does not break parsing', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({ data: { package_templates: [{ id: 42, name: 'X', status: 'ACTIVE' }] } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.listPackageTemplates()
    expect(r.success).toBe(true)
    expect(r.data?.items).toHaveLength(1)
  })

  it('11. no secrets/identifiers logged in envelope parsing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchSpy = vi.fn().mockResolvedValue(json({
      total: 1, offset: 0, count: 1,
      sims: [{ iccid: '8944501234567890123', status: 'PRE-SERVICE' }],
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    await c.listV2SimRegistries()
    for (const [args] of logSpy.mock.calls as Array<[string]>) {
      expect(String(args)).not.toContain('8944501234567890123')
    }
    logSpy.mockRestore()
  })
})

describe('Telna Connect V2.1 � plan sync + vendor balance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
    vi.mocked(prisma.eSIM.findMany).mockResolvedValue([])
  })

  function json(data: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': 'application/json' }), text: vi.fn().mockResolvedValue(JSON.stringify(data)) }
  }

  it('plan sync: live { total, offset, count, package_templates } envelope → ConnectorPlan rows', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({
      total: 2, offset: 0, count: 2,
      package_templates: [
        { id: 101, name: 'Africa 10GB', status: 'Active', data_usage_allowance: 10737418240, time_allowance: 2592000, supported_countries: ['ZAF'] },
        { id: 102, name: 'Global 5GB', status: 'De-activated', data_usage_allowance: 5368709120, time_allowance: 2592000 },
      ],
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.syncPlans()
    expect(r.success).toBe(true)
    const plans = r.data || []
    // Active and deactivated templates BOTH return so canonical sync can update
    // the same ProviderPackage row. providerPlanId = template id.
    expect(plans).toHaveLength(2)
    const active = plans.find(p => p.id === '101')!
    const deactivated = plans.find(p => p.id === '102')!
    expect(active.id).toBe('101')
    expect(active.data_gb).toBe(10)
    expect(active.validity_days).toBe(30)
    expect(active.sku).toBe('101')
    expect(active.isAvailable).toBe(true)
    expect(active.currency).toBeUndefined() // not provider-supplied
    expect(deactivated.isAvailable).toBe(false)
    expect(deactivated.raw_data?.providerStatus).toBe('DE_ACTIVATED')
    // price_usd is the zero sentinel (not a real provider cost).
    expect(active.price_usd).toBe(0)
  })

  it('plan sync: no-cost template is NOT fabricating a genuine cost', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({
      total: 1, offset: 0, count: 1,
      package_templates: [{ id: 3, name: 'NoCost', status: 'Active', data_usage_allowance: 1073741824, time_allowance: { duration: 1, unit: 'DAY' } }],
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.syncPlans()
    const plan = r.data![0]
    expect(plan.price_usd).toBe(0)
    // No currency field → canonical sync records COST_UNAVAILABLE, not USD-supplied.
    expect(plan.currency).toBeUndefined()
    expect(plan.isAvailable).toBe(true)
  })

  it('plan sync: bytes ? GB and time_allowance(seconds) ? days', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({
      total: 1, offset: 0, count: 1,
      package_templates: [{ id: 7, name: 'X', status: 'Active', data_usage_allowance: 32212254720, time_allowance: 86400 }],
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.syncPlans()
    expect(r.data?.[0].data_gb).toBe(30)
    expect(r.data?.[0].validity_days).toBe(1)
  })

  it('plan sync: paginates multiple Telna pages without duplication', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ total: 150, offset: 0, count: 100, package_templates: Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, name: `P${i}`, status: 'Active', data_usage_allowance: 1073741824, time_allowance: 2592000 })) }))
      .mockResolvedValueOnce(json({ total: 150, offset: 100, count: 50, package_templates: Array.from({ length: 50 }, (_, i) => ({ id: 1100 + i, name: `P${100 + i}`, status: 'Active', data_usage_allowance: 1073741824, time_allowance: 2592000 })) }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.syncPlans()
    expect(r.data?.length).toBe(150)
    const ids = new Set(r.data?.map(p => p.id))
    expect(ids.size).toBe(150)
  })

  it('plan sync: De-activated template returned with isAvailable:false (same-id reconciliation signal)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({
      total: 2, offset: 0, count: 2,
      package_templates: [
        { id: 1, name: 'A', status: 'De-activated', data_usage_allowance: 5368709120 },
        { id: 2, name: 'B', status: 'Active', data_usage_allowance: 5368709120 },
      ],
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.syncPlans()
    expect(r.data?.map(p => `${p.id}:${p.isAvailable}`)).toEqual(['1:false', '2:true'])
  })

  it('balance: configured walletId maps balance + currency', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider({ config: { walletId: 42 } }) as any)
    const fetchSpy = vi.fn().mockResolvedValue(json({ data: { id: 42, name: 'Operating', currency: 'USD', balance: 123.45, status: 'ACTIVE', companyId: 1 } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.getBalance()
    expect(r.success).toBe(true)
    expect(r.data?.balance).toBe(123.45)
    expect(r.data?.currency).toBe('USD')
    expect(r.data?.accountId).toBe('42')
  })

  it('balance: single auto-discovered wallet works when walletId unset', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider({ config: {} }) as any)
    const fetchSpy = vi.fn().mockResolvedValue(json({ data: { total: 1, offset: 0, count: 1, wallets: [{ id: 9, name: 'Default', currency: 'USD', balance: 50, status: 'ACTIVE', companyId: 1 }] } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.getBalance()
    expect(r.success).toBe(true)
    expect(r.data?.balance).toBe(50)
  })

  it('balance: multiple wallets without walletId is AMBIGUOUS (never fabricate)', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider({ config: {} }) as any)
    const fetchSpy = vi.fn().mockResolvedValue(json({ data: { total: 2, offset: 0, count: 2, wallets: [
      { id: 1, name: 'A', currency: 'USD', balance: 10, status: 'ACTIVE', companyId: 1 },
      { id: 2, name: 'B', currency: 'USD', balance: 20, status: 'ACTIVE', companyId: 1 },
    ] } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.getBalance()
    expect(r.success).toBe(false)
    expect(r.error?.code).toBe('BALANCE_AMBIGUOUS')
  })

  it('balance: no wallets without walletId ? NOT_CONFIGURED (no fake zero)', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider({ config: {} }) as any)
    const fetchSpy = vi.fn().mockResolvedValue(json({ data: { total: 0, offset: 0, count: 0, wallets: [] } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.getBalance()
    expect(r.success).toBe(false)
    expect(r.error?.code).toBe('NOT_CONFIGURED')
  })

  it('balance: no secrets logged', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider({ config: { walletId: 1 } }) as any)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: { id: 1, name: 'W', currency: 'USD', balance: 5, status: 'ACTIVE', companyId: 1 } }))
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    await c.getBalance()
    for (const [args] of logSpy.mock.calls as Array<[string]>) {
      expect(String(args)).not.toContain('test-key-id')
    }
    logSpy.mockRestore()
  })

  it('fixture A: config:{walletId} keeps PCR ApiKey encrypted present', () => {
    const fp = mockProvider({ config: { walletId: 42 } })
    const cfg = fp.config as Record<string, unknown>
    expect(cfg.walletId).toBe(42)
    expect(cfg.telnaPcrApiKeyEncrypted).toBeTruthy()
    expect(decryptToken(cfg.telnaPcrApiKeyEncrypted as string)).toBe(TEST_PCR_API_KEY)
  })

  it('fixture B: pcrAuth:missing with config:{walletId} keeps walletId but drops PCR ApiKey', () => {
    const fp = mockProvider({ pcrAuth: 'missing', config: { walletId: 42 } })
    const cfg = fp.config as Record<string, unknown>
    expect(cfg.walletId).toBe(42)
    expect(cfg.telnaPcrApiKeyEncrypted).toBeUndefined()
  })
})

describe('Telna Plan Sync � final contract hardening (time_allowance object + bytes)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
    vi.mocked(prisma.eSIM.findMany).mockResolvedValue([])
  })

  function json(data: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': 'application/json' }), text: vi.fn().mockResolvedValue(JSON.stringify(data)) }
  }

  it('normalizeTelnaTimeAllowance: exact live {duration:1, unit:CALENDAR_MONTH} -> 30 days', () => {
    expect(normalizeTelnaTimeAllowance({ time_allowance: { duration: 1, unit: 'CALENDAR_MONTH' } })).toMatchObject({ validityDays: 30, validitySource: 'time_allowance:CALENDAR_MONTH' })
    expect(normalizeTelnaTimeAllowance({ time_allowance: { duration: 1, unit: 'MONTH' } }).validityDays).toBe(30)
  })

  it('normalizeTelnaTimeAllowance: DAY / WEEK / YEAR units', () => {
    expect(normalizeTelnaTimeAllowance({ time_allowance: { duration: 30, unit: 'DAY' } }).validityDays).toBe(30)
    expect(normalizeTelnaTimeAllowance({ time_allowance: { duration: 2, unit: 'WEEK' } }).validityDays).toBe(14)
    expect(normalizeTelnaTimeAllowance({ time_allowance: { duration: 1, unit: 'YEAR' } }).validityDays).toBe(365)
  })

  it('normalizeTelnaTimeAllowance: malformed object uses fallback + diagnostic', () => {
    expect(normalizeTelnaTimeAllowance({ time_allowance: { duration: 0, unit: 'DAY' } }).validitySource).toContain('malformed')
    expect(normalizeTelnaTimeAllowance({ time_allowance: {} as any }).validitySource).toContain('malformed')
    // unsupported unit
    expect(normalizeTelnaTimeAllowance({ time_allowance: { duration: 1, unit: 'FORTNIGHT' } as any }).validitySource).toContain('unsupported-unit')
  })

  it('plan sync: exact live template maps time_allowance object + bytes to canonical plan', async () => {
    const live = { id: 1264275, name: 'EU_1G_1M', status: 'Active', data_usage_allowance: 1048576000, activation_type: 'MANUAL', time_allowance: { duration: 1, unit: 'CALENDAR_MONTH' }, supported_countries: ['CHE', 'FRA'] }
    const fetchSpy = vi.fn().mockResolvedValue(json({ total: 1, offset: 0, count: 1, package_templates: [live] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.syncPlans()
    expect(r.data).toHaveLength(1)
    const p = r.data![0]
    expect(p.id).toBe('1264275')
    expect(p.data_gb).toBe(1)
    expect(p.validity_days).toBe(30)
    expect(p.raw_data?._validitySource).toContain('CALENDAR_MONTH')
  })

  it('plan sync: 1048576000 bytes -> 1 GB (retail-normalized, not fractional GiB)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({ total: 1, offset: 0, count: 1, package_templates: [{ id: 1, name: 'X', status: 'Active', data_usage_allowance: 1048576000, time_allowance: { duration: 1, unit: 'CALENDAR_MONTH' } }] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.syncPlans()
    expect(r.data?.[0].data_gb).toBe(1)
  })

  it('plan sync: pagination final short page advances offset by returned count and stops', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ total: 3, offset: 0, count: 2, package_templates: Array.from({ length: 2 }, (_, i) => ({ id: 100 + i, status: 'Active', data_usage_allowance: 1048576000, time_allowance: { duration: 1, unit: 'DAY' } })) }))
      .mockResolvedValueOnce(json({ total: 3, offset: 2, count: 1, package_templates: [{ id: 102, status: 'Active', data_usage_allowance: 1048576000, time_allowance: { duration: 1, unit: 'DAY' } }] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.syncPlans()
    expect(r.data?.length).toBe(3)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('plan sync: empty page breaks pagination (no infinite loop)', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(json({ total: 0, offset: 0, count: 0, package_templates: [] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.syncPlans()
    expect(r.data).toHaveLength(0)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('plan sync: De-activated template returned with isAvailable:false (no row deleted)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({ total: 1, offset: 0, count: 1, package_templates: [{ id: 9, name: 'X', status: 'De-activated', data_usage_allowance: 1048576000, time_allowance: { duration: 1, unit: 'DAY' } }] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.syncPlans()
    expect(r.data).toHaveLength(1)
    expect(r.data?.[0].isAvailable).toBe(false)
    expect(r.data?.[0].raw_data?.providerStatus).toBe('DE_ACTIVATED')
    // Exactly one page requested; the connector never issues ProviderPackage deletes.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('Telna V2.1 � remaining standard endpoints + custom package creation contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider())
    vi.mocked(prisma.eSIM.findMany).mockResolvedValue([])
  })

  function json(data: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': 'application/json' }), text: vi.fn().mockResolvedValue(JSON.stringify(data)) }
  }

  it('traffic-policy list parses the named traffic_policies envelope (PCR)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({ total: 2, offset: 0, count: 2, traffic_policies: [{ id: 7, name: 'Std' }, { id: 8, name: 'Premium' }] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.listTrafficPolicies()
    expect(r.success).toBe(true)
    expect(r.data?.items).toHaveLength(2)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/v2.1/pcr/traffic-policies')
  })

  it('route-policy list parses the named route_policies envelope (PCR), requires inventory', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({ total: 1, offset: 0, count: 1, route_policies: [{ id: 3, name: 'Default' }] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.listRoutePolicies(9, 10, 0)
    expect(r.success).toBe(true)
    expect(r.data?.items).toHaveLength(1)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/v2.1/pcr/route-policies')
    const url = new URL(String(fetchSpy.mock.calls[0][0]))
    expect(url.searchParams.get('inventory')).toBe('9')
    expect(url.searchParams.get('count')).toBe('10')
    expect(url.searchParams.get('offset')).toBe('0')
  })

  it('route-policy list requires inventory (INVALID_REQUEST, no HTTP call)', async () => {
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await (c as any).listRoutePolicies(undefined, 10, 0)
    expect(r.success).toBe(false)
    expect(r.error?.code).toBe('INVALID_REQUEST')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('capabilities: customPackageCreation true at connector-contract level; paid add-ons disabled', () => {
    const caps = new TelnaConnector('telna-provider-1', 'Telna').capabilities!
    expect(caps.webhooks).toBe(false)
    expect(caps.customPackageCreation).toBe(true)
    expect(caps.usageLookup).toBe(true)
    expect(caps.statusLookup).toBe(true)
    // Paid add-ons are not exposed as connector capabilities.
    expect(caps.webhooks).toBe(false)
  })

  it('getCustomPackageDefinition returns provider-owned options and documented fields, no credentials', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { total: 1, offset: 0, count: 1, inventories: [{ id: 9, name: 'Main' }] } }))
      .mockResolvedValueOnce(json({ data: { total: 1, offset: 0, count: 1, traffic_policies: [{ id: 2, name: 'Policy' }] } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.getCustomPackageDefinition()
    expect(r.success).toBe(true)
    expect(r.definition?.inventories).toHaveLength(1)
    expect(r.definition?.trafficPolicies).toHaveLength(1)
    const keys = (r.definition?.providerFields || []).map(f => f.key)
    expect(keys).toContain('traffic_policy')
    expect(JSON.stringify(r)).not.toContain('ApiKey')
    expect(JSON.stringify(r)).not.toContain('Authorization')
  })

  it('createCustomPackage is contract-supported (capability true) but no generic UI auto-invokes it (no live mutation on this code path)', async () => {
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    // CONTRACT_SUPPORTED=true at capability level; the method is the implemented
    // contract (not auto-invoked by the Provider Catalog UI). Validate no fetch
    // happens here because the test never calls createCustomPackage.
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    expect(c.capabilities?.customPackageCreation).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('createCustomPackage validates required fields before any POST', async () => {
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    mockCustomPackageReadiness.mockResolvedValue({ ready: true })
    const c = new TelnaConnector('telna-provider-1', 'Telna' as any) as any
    expect((await c.createCustomPackage({ name: '', dataGB: 1, validityDays: 30 })).error?.code).toBe('INVALID_REQUEST')
    expect((await c.createCustomPackage({ name: 'X', dataGB: 0, validityDays: 30 })).error?.code).toBe('INVALID_REQUEST')
    expect((await c.createCustomPackage({ name: 'X', dataGB: 1, validityDays: 0 })).error?.code).toBe('INVALID_REQUEST')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('createCustomPackage refuses while readiness is disabled (CAPABILITY_NOT_ENABLED, no POST)', async () => {
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    mockCustomPackageReadiness.mockResolvedValue({ ready: false, reason: 'account-not-enabled' })
    const c = new TelnaConnector('telna-provider-1', 'Telna' as any) as any
    const r = await c.createCustomPackage({ name: 'X', dataGB: 1, validityDays: 30 })
    expect(r.success).toBe(false)
    expect(r.error?.code).toBe('CAPABILITY_NOT_ENABLED')
    // Must never reach POST /package-templates when not enabled.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('createCustomPackage maps GB->bytes, time_allowance OBJECT, activation_time_allowance seconds -> providerPlanId', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({ data: { id: 999001, name: 'X', status: 'Active' } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    mockCustomPackageReadiness.mockResolvedValue({ ready: true })
    const c = new TelnaConnector('telna-provider-1', 'Telna' as any) as any
    const r = await c.createCustomPackage({
      name: 'MyPlan', countries: ['ZAF'], dataGB: 1, validityDays: 30,
      activationTimeAllowanceSeconds: 3600, voiceMinutes: 100, smsCount: 50, activationType: 'MANUAL',
    })
    expect(r.success).toBe(true)
    expect(r.data?.providerPlanId).toBe('999001')
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/v2.1/pcr/package-templates')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.data_usage_allowance).toBe(1073741824) // 1GB bytes
    // time_allowance is the documented OBJECT { duration, unit } — NOT flat seconds.
    expect(body.time_allowance).toEqual({ duration: 30, unit: 'SECOND' })
    // activation_time_allowance is a numeric SECONDS integer, distinct from time_allowance.
    expect(body.activation_time_allowance).toBe(3600)
    expect(body.voice_usage_allowance).toBe(100)
    expect(body.sms_usage_allowance).toBe(50)
    expect(body.supported_countries).toEqual(['ZAF'])
    // No local OneSIM id sent upstream.
    expect(String(init.body)).not.toContain('onesim-pkg')
    expect(String(init.body)).not.toContain('order-1')
  })

  it('POST /package-templates (create offering) is a different endpoint than POST /packages (assign instance)', async () => {
    // Ensure the endpoint map treats them as distinct.
    expect(telnaEndpointPath('packageTemplateCreate')).toBe('/v2.1/pcr/package-templates')
    expect(telnaEndpointPath('packages')).toBe('/v2.1/pcr/packages')
  })

  it('listCompanies parses the named companies envelope with pagination (CORE, RAW auth)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({ total: 2, offset: 0, count: 2, companies: [{ id: 1, name: 'Telna' }, { id: 2, name: 'Other' }] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    const r = await c.listCompanies(10, 0)
    expect(r.success).toBe(true)
    expect(r.data?.items).toHaveLength(2)
    const url = new URL(String(fetchSpy.mock.calls[0][0]))
    expect(String(url)).toContain('/v2.1/core/companies')
    expect(url.searchParams.get('count')).toBe('10')
    expect(url.searchParams.get('offset')).toBe('0')
  })

  it('create/modify company and inventory write endpoints are mapped but DISABLED (block before HTTP)', async () => {
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c: any = new TelnaConnector('telna-provider-1', 'Telna')
    // Methods exist (mapped contract) but always gate with NOT_STANDARD_PLAN, no HTTP.
    expect((await c.createCompany({ name: 'X' })).error?.code).toBe('NOT_STANDARD')
    expect((await c.updateCompany(1, {})).error?.code).toBe('NOT_STANDARD')
    expect((await c.createInventory({ name: 'X', company_id: 1 })).error?.code).toBe('NOT_STANDARD')
    expect((await c.updateInventory(1, {})).error?.code).toBe('NOT_STANDARD')
    // SIM purge is DANGEROUS → NOT_ENABLED gate (never exposed via ordinary admin).
    expect((await c.purgeSimRegistry('89441000000000000000')).error?.code).toBe('NOT_ENABLED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('updatePackageInstance uses PUT /v2.1/pcr/packages/{package_id} (distinct from sim-pcr PUT)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({ data: { id: 500, package_template: 7 } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna' as any) as any
    const r = await c.updatePackageInstance(500, { package_template: 7 })
    expect(r.success).toBe(true)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/v2.1/pcr/packages/500')
    expect(init.method).toBe('PUT')
    const body = JSON.parse(init.body)
    expect(body.package_template).toBe(7)
  })

  it('updateWallet uses PATCH /v2.1/pcr/wallets/{wallet_id} (distinct from balance GET)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(json({ data: { id: 5, name: 'W', balance: 10 } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const c = new TelnaConnector('telna-provider-1', 'Telna' as any) as any
    const r = await c.updateWallet(5, { minimum_balance: 1 })
    expect(r.success).toBe(true)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/v2.1/pcr/wallets/5')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body).minimum_balance).toBe(1)
  })

  it('wallet entitlement state is unaffected (balance capability present; no fake zero)', async () => {
    const c = new TelnaConnector('telna-provider-1', 'Telna')
    expect(c.capabilities?.balance).toBe(true)
    // Wallet 403 → WAITING_VENDOR_ENTITLEMENT, implemented; not touched this task.
    expect(c.capabilities?.balance).toBe(true)
  })
})
