import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: { provider: { findUnique: vi.fn() } },
}))

vi.mock('@/lib/encryption', () => ({
  encryptToken: vi.fn((t: string | null | undefined) => t ? `enc:${t}` : null),
  decryptToken: vi.fn((t: string | null | undefined) => {
    if (!t) return null
    if (typeof t === 'string' && t.startsWith('enc:')) return t.slice(4)
    return t
  }),
}))

vi.mock('@/lib/esim/installation-data', () => ({
  hasUsableInstallData: (fields: any) => Boolean(fields?.qrCodeUrl || fields?.activationCode || (fields?.smdpAddress && fields?.matchingId)),
}))

const { prisma } = await import('@/lib/prisma')
const { TelnaFlexConnector } = await import('./telna-flex-connector')
const { buildTelnaFlexUrl } = await import('./telna-flex-endpoints')

const mockPrisma = vi.mocked(prisma)

function mockProvider(overrides: any = {}) {
  return {
    id: 'telna-flex-1',
    name: 'Telna Flex',
    code: 'TELNA_FLEX',
    type: 'CUSTOM',
    adapterStrategy: 'TELNA_FLEX',
    apiBaseUrl: 'https://ppo-api.telna.com',
    apiToken: 'enc:flex-key-12345',
    config: { authorizationMode: 'BEARER' },
    ...overrides,
  }
}

function okJson(data: any, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': 'application/json' }), text: vi.fn().mockResolvedValue(JSON.stringify(data)) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.provider.findUnique.mockResolvedValue(mockProvider() as any)
})

describe('TelnaFlexConnector — auth profile', () => {
  it('declares STATIC_KEY_ID auth (Bearer KeyID, no runtime login, Save & Verify)', () => {
    const connector = new TelnaFlexConnector('telna-flex-1', 'Telna Flex')
    const profile = connector.authProfile!
    expect(profile.mode).toBe('STATIC_KEY_ID')
    expect(profile.requiresRuntimeAuthentication).toBe(false)
    expect(profile.canVerifyCredentials).toBe(true)
    expect(profile.actionLabel).toBe('Save & Verify')
  })

  it('declares read-only capabilities (discovery + usage + installation lookup; no purchase/top-up/suspend/resume)', () => {
    const caps = new TelnaFlexConnector('telna-flex-1', 'Telna Flex').capabilities!
    expect(caps.usageLookup).toBe(true)
    expect(caps.installationLookupHistorical).toBe(true)
    expect(caps.installationDataAtPurchase).toBe(false)
    expect(caps.topUp).toBe(false)
    expect(caps.suspend).toBe(false)
    expect(caps.resume).toBe(false)
  })
})

describe('TelnaFlexConnector — documented read-only endpoints', () => {
  it('testConnection uses GET /v1/ordering/products with Bearer KeyID', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ data: [{ product_id: 'p1' }] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaFlexConnector('telna-flex-1', 'Telna Flex')
    const result = await connector.testConnection()
    expect(result.success).toBe(true)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(init.method).toBe('GET')
    expect(String(url)).toContain('/v1/ordering/products')
    expect(init.headers.Authorization).toBe('Bearer flex-key-12345')
  })

  it('uses RAW Authorization when config.authorizationMode=RAW', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider({ config: { authorizationMode: 'RAW' } }) as any)
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ data: [] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaFlexConnector('telna-flex-1', 'Telna Flex')
    await connector.testConnection()
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('flex-key-12345')
  })

  it('404 is classified as endpoint/base-path error, not auth failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ message: 'Not Found' }, 404))
    const connector = new TelnaFlexConnector('telna-flex-1', 'Telna Flex')
    const result = await connector.testConnection()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_404')
    expect(result.error?.message).toContain('base path')
    expect(result.error?.message).not.toContain('Authentication rejected')
  })

  it('401 maps to auth failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({}, 401))
    const connector = new TelnaFlexConnector('telna-flex-1', 'Telna Flex')
    const result = await connector.testConnection()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_401')
    expect(result.error?.message).toContain('KeyID')
  })

  it('syncPlans discovers from GET /v1/ordering/products with defensive mapping', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ data: [{ product_id: 'p1', name: 'Flex 10GB', features: { data_mb: 10240 }, price: { net_price: 12.5, currency: 'USD' }, validity_days: 30 }] }))
    const connector = new TelnaFlexConnector('telna-flex-1', 'Telna Flex')
    const result = await connector.syncPlans()
    expect(result.success).toBe(true)
    expect(result.data?.[0]?.id).toBe('p1')
    expect(result.data?.[0]?.data_gb).toBe(10)
    expect(result.data?.[0]?.price_usd).toBe(12.5)
  })

  it('lookupInstallationData uses GET /v1/diagnostic/euicc-profiles/{iccid}', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({}))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaFlexConnector('telna-flex-1', 'Telna Flex')
    const result = await connector.lookupInstallationData({ iccid: '89012345678901234567' })
    expect(result.state).toBe('NOT_AVAILABLE_YET')
    expect(result.errorCode).toBe('NO_INSTALL_DATA')
    expect(result.diagnostics?.note).toContain('response shape unverified')
    const url = String(fetchSpy.mock.calls[0][0])
    expect(url).toContain('/v1/diagnostic/euicc-profiles/89012345678901234567')
  })

  it('lookupInstallationData with known install fields → READY', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ activation_code: 'LPA:1$smdp.example$mid', smdp_address: 'smdp.example.com', matching_id: 'mid-9' }))
    const connector = new TelnaFlexConnector('telna-flex-1', 'Telna Flex')
    const result = await connector.lookupInstallationData({ iccid: '89012345678901234567' })
    expect(result.state).toBe('READY')
    expect(result.data?.activationCode).toBe('LPA:1$smdp.example$mid')
  })

  it('lookupInstallationData without iccid → IDENTIFIER_MISSING (no HTTP)', async () => {
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaFlexConnector('telna-flex-1', 'Telna Flex')
    const result = await connector.lookupInstallationData({})
    expect(result.state).toBe('PERMANENT_FAILURE')
    expect(result.errorCode).toBe('IDENTIFIER_MISSING')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('purchase (activateESIM) is NOT wired and never issues a request', async () => {
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new TelnaFlexConnector('telna-flex-1', 'Telna Flex')
    const result = await connector.activateESIM({ planId: 'p1', quantity: 1, subscriber: { email: 'a@b.com' } })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_IMPLEMENTED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('buildTelnaFlexUrl — documented path composition', () => {
  it('composes base + /v1 path with no trailing-slash issues', () => {
    expect(buildTelnaFlexUrl('https://ppo-api.telna.com', 'products')).toBe('https://ppo-api.telna.com/v1/ordering/products')
    expect(buildTelnaFlexUrl('https://ppo-api.telna.com/', 'euiccProfiles', { iccid: '89012345678901234567' })).toBe('https://ppo-api.telna.com/v1/diagnostic/euicc-profiles/89012345678901234567')
  })

  it('preserves a base path prefix (no duplicate /v1)', () => {
    const url = buildTelnaFlexUrl('https://ppo-api.telna.com/prefix', 'products')
    expect(url).toBe('https://ppo-api.telna.com/prefix/v1/ordering/products')
  })

  it('appends query params', () => {
    expect(buildTelnaFlexUrl('https://ppo-api.telna.com', 'products', undefined, { count: 1, offset: 0 })).toBe('https://ppo-api.telna.com/v1/ordering/products?count=1&offset=0')
  })
})
