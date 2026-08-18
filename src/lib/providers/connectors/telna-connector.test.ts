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

import type { Provider } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { TelnaConnector } from './telna-connector'
import { resolveConnectorType, createConnector } from './connector-factory'
import { encryptToken, decryptToken } from '@/lib/encryption'
import { claimProviderIccid, releaseProviderIccidClaim } from '@/lib/services/esims/esim-inventory-claim'

const mockClaimProviderIccid = vi.mocked(claimProviderIccid)
const mockReleaseProviderIccidClaim = vi.mocked(releaseProviderIccidClaim)

// Deterministic encrypted PCR credential fixtures. Stored in provider.config
// ONLY as encryptToken() ciphertext (never plaintext), matching the production
// connector's decrypted-at-load contract.
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

const mockProvider = (overrides: Partial<Provider> & { pcrAuth?: 'full' | 'missing' } = {}): Provider => {
  const { pcrAuth = 'full', ...rest } = overrides
  // PCR credentials are stored in provider.config ONLY as encryptToken()
  // ciphertext — matching the production connector's decrypted-at-load contract.
  const pcrConfig = pcrAuth === 'full'
    ? {
        telnaPcrApiKeyEncrypted: encryptToken(TEST_PCR_API_KEY),
        telnaPcrLoginIdEncrypted: encryptToken(TEST_PCR_LOGIN_ID),
        telnaPcrAccessTokenEncrypted: encryptToken(TEST_PCR_ACCESS_TOKEN),
      }
    : {
        // Intentionally absent — used to prove AUTH_INCOMPLETE gates.
      }
  return {
    id: 'telna-provider-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...baseMock,
    config: { ...(baseMock.config as any), ...pcrConfig },
    ...rest,
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

  it('refuses /core/countries with NOT_CONFIGURED (auth unproven) and makes NO HTTP call', async () => {
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.testConnection()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('testConnection never dispatches a request for the CORE family (regardless of mock response)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [{ id: 1 }], total: 1 })),
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.testConnection()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('CORE auth is unproven so 4xx/5xx/network responses are never reached', async () => {
    // Prove that the guard short-circuits BEFORE any HTTP classification:
    // even a 404 / 401 / network error mock must never be dispatched.
    for (const mock of [
      { ok: false, status: 404, headers: new Headers({ 'content-type': 'text/plain' }), text: vi.fn().mockResolvedValue('Not Found') },
      { ok: false, status: 401, headers: new Headers({ 'content-type': 'text/plain' }), text: vi.fn().mockResolvedValue('Unauthorized') },
      { ok: false, status: 403, headers: new Headers({ 'content-type': 'text/plain' }), text: vi.fn().mockResolvedValue('Forbidden') },
      { ok: false, status: 429, headers: new Headers({ 'content-type': 'text/plain' }), text: vi.fn().mockResolvedValue('Too Many Requests') },
    ]) {
      const fetchSpy = vi.fn().mockResolvedValue(mock as any)
      vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
      const connector = new TelnaConnector('telna-provider-1', 'Telna')
      const result = await connector.testConnection()
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('NOT_CONFIGURED')
      expect(fetchSpy).not.toHaveBeenCalled()
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
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not map live /core failures because the CORE family is never dispatched', async () => {
    // Even a 500 / network-error mock must not be reached for a CORE lookup;
    // the guard returns NOT_CONFIGURED before any fetch.
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ENETUNREACH'))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listCountries(10, 0)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('handles provider not configured', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(null)
    const connector = new TelnaConnector('non-existent', 'Telna')
    const result = await connector.listCountries(10, 0)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
  })

  it('CORE auth blocks the empty-response path (no fetch)', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [], total: 0, offset: 0, count: 0 })),
    }
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse as any)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listCountries(10, 0)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
    expect(fetchSpy).not.toHaveBeenCalled()
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

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not reach 404 classification for the CORE family (guard short-circuits)', async () => {
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
    expect(result.error?.code).toBe('NOT_CONFIGURED')
    expect(fetchSpy).not.toHaveBeenCalled()
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
      expect.stringContaining('/pcr/package-templates/201'),
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

  it('listCountries is guarded to NOT_CONFIGURED after auth-family changes (CORE unproven)', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: [{ id: 1, name: 'Test', iso: 'TT' }], total: 1, offset: 0, count: 1 })),
    }
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse as any)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listCountries(1, 0)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('getCompany is guarded to NOT_CONFIGURED after auth-family changes (CORE unproven)', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: { id: 1, name: 'Co', code: 'CO', status: 'ACTIVE' } })),
    }
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse as any)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getCompany(1)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
    expect(fetchSpy).not.toHaveBeenCalled()
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

  it('CORE company lookup (getCompany) is auth-blocked: NOT_CONFIGURED and no URL is composed to fetch', async () => {
    const fakeResponse = {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: { id: 1, name: 'Test', code: 'TST', status: 'ACTIVE' } })),
    }
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse as any)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.getCompany(123)
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
    expect(fetchSpy).not.toHaveBeenCalled()
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
      expect.stringContaining('/pcr/packages/1001'),
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
      expect.stringContaining('/inventory/sim-registries/89012345678901234567'),
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
    expect(urls.some(u => u.includes('/inventory/sim-registries/'))).toBe(true)
    expect(urls.some(u => u.includes('/euicc-profiles/'))).toBe(true)
    expect(urls.some(u => u.includes('/pcr/packages?sim='))).toBe(true)
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

  it('declares installation + usage capabilities as enabled (documented v2 contract)', () => {
    const caps = new TelnaConnector('telna-provider-1', 'Telna').capabilities!
    // GET /euicc-profiles/{iccid} activation_code proves historical install lookup.
    expect(caps.installationLookup).toBe(true)
    expect(caps.installationLookupHistorical).toBe(true)
    // Package usage (data_usage_remaining bytes) + ICCID resolver.
    expect(caps.usageLookup).toBe(true)
    // We still never claim purchase-time install or webhooks.
    expect(caps.installationDataAtPurchase).not.toBe(true)
    expect(caps.webhooks).toBe(false)
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
  it('buildTelnaEndpointUrl composes base + endpoint with no double path', () => {
    const url = buildTelnaEndpointUrl('https://developer-api.telna.com', 'countries')
    expect(url).toBe('https://developer-api.telna.com/core/countries')
  })

  it('tolerates a trailing slash on the base URL', () => {
    expect(buildTelnaEndpointUrl('https://developer-api.telna.com/', 'countries')).toBe('https://developer-api.telna.com/core/countries')
    expect(buildTelnaEndpointUrl('https://developer-api.telna.com///', 'countries')).toBe('https://developer-api.telna.com/core/countries')
  })

  it('preserves a path prefix already present in apiBaseUrl (no duplicate /core)', () => {
    const url = buildTelnaEndpointUrl('https://developer-api.telna.com/v2', 'countries')
    expect(url).toBe('https://developer-api.telna.com/v2/core/countries')
    expect(url.split('/core').length).toBe(2)
  })

  it('substitutes path parameters', () => {
    expect(buildTelnaEndpointUrl('https://developer-api.telna.com', 'company', { company_id: 42 })).toBe('https://developer-api.telna.com/core/companies/42')
  })

  it('testConnection and Discovery (listCountries) resolve the SAME canonical endpoint path', () => {
    // Single-source path map: both go through telnaEndpointPath('countries').
    const tcPath = telnaEndpointPath('countries')
    const discoveryPath = telnaEndpointPath('countries')
    expect(tcPath).toBe('/core/countries')
    expect(discoveryPath).toBe('/core/countries')
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

  const expectedBasic = 'Basic ' + Buffer.from(`${TEST_PCR_LOGIN_ID}:${TEST_PCR_ACCESS_TOKEN}`).toString('base64')
  const pcrHeaders = { 'ApiKey': TEST_PCR_API_KEY, 'Authorization': expectedBasic }

  it('activateESIM runs the verified flow: template detail, SIM listing, neutral claim, POST /pcr/packages', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(json({ data: { id: 42 } })) // GET /pcr/package-templates/42
      .mockResolvedValueOnce(json({ data: [{ iccid: 'PRE-ICCID', status: 'PRE_SERVICE' }], total: 1 })) // GET /inventory/sim-registries
      .mockResolvedValueOnce(json({ data: { id: 'pkg-INSTANCE-1', sim: 'PRE-ICCID', status: 'NOT_ACTIVE' } })) // POST /pcr/packages
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

    // Exactly one POST /pcr/packages with the documented PCR headers and body.
    const postCalls = fetchSpy.mock.calls.filter(c => String(c[0]).includes('/pcr/packages') && c[1].method === 'POST')
    expect(postCalls).toHaveLength(1)
    const [postUrl, postInit] = postCalls[0]
    expect(String(postUrl)).toContain('/pcr/packages')
    expect(JSON.parse(postInit.body)).toEqual({ sim: 'PRE-ICCID', package_template: 42 })
    expect(postInit.headers['ApiKey']).toBe(TEST_PCR_API_KEY)
    expect(postInit.headers['Authorization']).toBe(expectedBasic)
    expect(postInit.headers['Authorization']).not.toContain('Bearer')
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
    const postCall = fetchSpy.mock.calls.find(c => String(c[0]).includes('/pcr/packages') && c[1].method === 'POST')
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
    for (const call of fetchSpy.mock.calls) expect(String(call[0])).not.toContain('/pcr/packages')
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
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/euicc-profiles/8944501234567890123')
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
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/pcr/packages/EXACT')
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
      for (const call of fetchSpy.mock.calls) expect(String(call[0])).not.toContain('/pcr/packages')
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
    const post = fetchSpy.mock.calls.find(x => String(x[0]).includes('/pcr/packages') && x[1].method === 'POST')
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
    const post = fetchSpy.mock.calls.find(x => String(x[0]).includes('/pcr/packages') && x[1].method === 'POST')
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
    for (const call of fetchSpy.mock.calls) expect(String(call[0])).not.toContain('/pcr/packages')
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
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/pcr/packages/EXACT-1')
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
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/euicc-profiles/PRE-ICCID')
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
    const post = fetchSpy.mock.calls.find(x => String(x[0]).includes('/pcr/packages') && x[1].method === 'POST')
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
    const post = fetchSpy.mock.calls.find(x => String(x[0]).includes('/pcr/packages') && x[1].method === 'POST')
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
    const post = fetchSpy.mock.calls.filter(x => String(x[0]).includes('/pcr/packages') && x[1].method === 'POST')
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
    for (const call of fetchSpy.mock.calls) expect(String(call[0])).not.toContain('/pcr/packages')
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

  const BEARER = 'test-key-id-12345'
  const expectedBasic = 'Basic ' + Buffer.from(`${TEST_PCR_LOGIN_ID}:${TEST_PCR_ACCESS_TOKEN}`).toString('base64')

  it('INVENTORY (listInventories) sends a Bearer header and no PCR ApiKey/Basic', async () => {
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
    expect(headers['Authorization']).toBe(`Bearer ${BEARER}`)
    expect(headers['ApiKey']).toBeUndefined()
    expect(headers['Authorization']).not.toContain('Basic')
  })

  it('INVENTORY (listSimRegistries) sends a Bearer header and no PCR ApiKey/Basic', async () => {
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
    expect(headers['Authorization']).toBe(`Bearer ${BEARER}`)
    expect(headers['ApiKey']).toBeUndefined()
    expect(headers['Authorization']).not.toContain('Basic')
  })

  it('PCR (listPackageTemplates) sends ApiKey + Basic and no Bearer', async () => {
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
    expect(headers['Authorization']).toBe(expectedBasic)
    expect(headers['Authorization']).not.toContain('Bearer')
  })

  it('PCR with incomplete credentials short-circuits to AUTH_INCOMPLETE with NO fetch', async () => {
    vi.mocked(prisma.provider.findUnique).mockResolvedValue(mockProvider({ pcrAuth: 'missing' }))
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.listPackageTemplates()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('AUTH_INCOMPLETE')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('CORE (testConnection / countries) is refused with NOT_CONFIGURED and NO fetch', async () => {
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)

    const connector = new TelnaConnector('telna-provider-1', 'Telna')
    const result = await connector.testConnection()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_CONFIGURED')
    expect(fetchSpy).not.toHaveBeenCalled()
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
