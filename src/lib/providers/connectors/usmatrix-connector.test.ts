import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import { prisma } from '@/lib/prisma'
import { UsMatrixConnector, maskIccid } from './usmatrix-connector'
import { resolveConnectorType, createConnector } from './connector-factory'
import { buildUsMatrixUrl, normalizeUsMatrixBaseUrl, usMatrixEndpointPath } from './usmatrix-endpoints'

const mockPrisma = vi.mocked(prisma)

const RAW_TOKEN = 'usmatrix-jwt-token-1234567890'

function mockProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'usmatrix-1',
    name: 'US-Matrix',
    code: 'USMATRIX',
    type: 'CUSTOM',
    adapterStrategy: 'USMATRIX',
    authType: 'credentials',
    apiVersion: 'v1',
    apiBaseUrl: 'https://api-esim.usmatrix.com',
    apiToken: `enc:${RAW_TOKEN}`,
    authUrl: null,
    environment: 'production',
    config: {},
    ...overrides,
  } as any
}

function okJson(data: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())
  mockPrisma.provider.update.mockResolvedValue({})
})

describe('US-Matrix connector resolution', () => {
  it('resolves USMATRIX strategy to USMATRIX connector type', () => {
    expect(resolveConnectorType('USMATRIX', 'CUSTOM')).toBe('USMATRIX')
  })

  it('does not fall back to generic CUSTOM/REST_CATALOG', () => {
    expect(resolveConnectorType('USMATRIX', 'CUSTOM', 'USMATRIX')).toBe('USMATRIX')
    expect(resolveConnectorType(null, 'CUSTOM')).toBe('REST_CATALOG')
    expect(resolveConnectorType('TELNA', 'CUSTOM')).toBe('TELNA')
    expect(resolveConnectorType('IBASIS', 'CUSTOM')).toBe('IBASIS')
  })

  it('creates a UsMatrixConnector for USMATRIX type', () => {
    const connector = createConnector('usmatrix-1', 'US-Matrix', 'USMATRIX', { apiBaseUrl: 'https://api-esim.usmatrix.com' })
    expect(connector).toBeInstanceOf(UsMatrixConnector)
    expect(connector.name).toBe('US-Matrix')
  })
})

describe('US-Matrix base URL composition', () => {
  it('host-only base + documented /api/v1 path', () => {
    expect(buildUsMatrixUrl('https://api-esim.usmatrix.com', 'currentClient')).toBe('https://api-esim.usmatrix.com/api/v1/clients/current')
    expect(buildUsMatrixUrl('https://api-esim.usmatrix.com', 'signin')).toBe('https://api-esim.usmatrix.com/api/v1/whitelist/signin')
  })

  it('versioned base does NOT produce /api/v1/api/v1', () => {
    expect(normalizeUsMatrixBaseUrl('https://api-esim.usmatrix.com/api/v1')).toBe('https://api-esim.usmatrix.com')
    expect(buildUsMatrixUrl('https://api-esim.usmatrix.com/api/v1', 'packages')).toBe('https://api-esim.usmatrix.com/api/v1/packages')
    const url = buildUsMatrixUrl('https://api-esim.usmatrix.com/api/v1', 'currentClient')
    expect(url).not.toContain('/api/v1/api/v1')
  })

  it('trailing slash on base is safe', () => {
    expect(buildUsMatrixUrl('https://api-esim.usmatrix.com/', 'currentClient')).toBe('https://api-esim.usmatrix.com/api/v1/clients/current')
    expect(buildUsMatrixUrl('https://api-esim.usmatrix.com/api/v1/', 'currentClient')).toBe('https://api-esim.usmatrix.com/api/v1/clients/current')
  })

  it('substitutes path params', () => {
    expect(buildUsMatrixUrl('https://api-esim.usmatrix.com', 'esimMobileDetail', { esim_id: 'abc-123' })).toBe('https://api-esim.usmatrix.com/api/v1/esims/mobile-detail/abc-123')
  })

  it('endpoint path getter is single source of truth', () => {
    expect(usMatrixEndpointPath('currentClient')).toBe('/api/v1/clients/current')
    expect(usMatrixEndpointPath('signin')).toBe('/api/v1/whitelist/signin')
  })
})

describe('US-Matrix auth profile', () => {
  it('declares LOGIN_TOKEN auth (runtime login, Save & Authenticate)', () => {
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const profile = connector.authProfile!
    expect(profile.mode).toBe('LOGIN_TOKEN')
    expect(profile.requiresRuntimeAuthentication).toBe(true)
    expect(profile.canVerifyCredentials).toBe(true)
    expect(profile.supportsRefresh).toBe(false)
    expect(profile.actionLabel).toBe('Save & Authenticate')
  })

  it('declares read-only capabilities (no purchase/top-up/suspend/resume/usage)', () => {
    const caps = new UsMatrixConnector('usmatrix-1', 'US-Matrix').capabilities!
    expect(caps.installationLookup).toBe(true)
    expect(caps.installationLookupHistorical).toBe(true)
    expect(caps.inventory).toBe(true)
    expect(caps.statusLookup).toBe(false)
    expect(caps.usageLookup).toBe(false)
    expect(caps.topUp).toBe(false)
    expect(caps.suspend).toBe(false)
    expect(caps.resume).toBe(false)
    expect(caps.balance).toBe(false)
    expect(caps.webhooks).toBe(false)
  })

  it('installationDataAtPurchase is conservatively UNKNOWN (not NOT_SUPPORTED)', () => {
    const caps = new UsMatrixConnector('usmatrix-1', 'US-Matrix').capabilities!
    expect(caps.installationDataAtPurchase).toBe('UNKNOWN')
  })

  it('refreshAuthentication returns false (no documented expiry)', async () => {
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    expect(await connector.refreshAuthentication()).toBe(false)
  })
})

describe('US-Matrix authenticate (POST /api/v1/whitelist/signin)', () => {
  it('posts ONLY the documented SigninRequestDTO fields (email + password)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ token: RAW_TOKEN }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.authenticate({ email: 'reseller@example.com', password: 'S3curePass!' })
    expect(result.success).toBe(true)
    expect(result.data?.token).toBe(RAW_TOKEN)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/api/v1/whitelist/signin')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ email: 'reseller@example.com', password: 'S3curePass!' })
    // No extra guessed fields.
    expect(Object.keys(JSON.parse(init.body)).sort()).toEqual(['email', 'password'])
    // No Authorization header on signin (public endpoint).
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('accepts username fallback to email', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ token: RAW_TOKEN }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    await connector.authenticate({ username: 'reseller@example.com', password: 'S3curePass!' })
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({ email: 'reseller@example.com', password: 'S3curePass!' })
  })

  it('persists the token encrypted (Bearer used subsequently)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ token: RAW_TOKEN }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    await connector.authenticate({ email: 'reseller@example.com', password: 'S3curePass!' })
    expect(mockPrisma.provider.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ apiToken: `enc:${RAW_TOKEN}` }),
    }))
  })

  it('fails with CREDENTIALS_MISSING when no email/password (no network call)', async () => {
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.authenticate({})
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('CREDENTIALS_MISSING')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('maps 401 to auth failure (invalid credential/token)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({}, 401))
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.authenticate({ email: 'a@b.com', password: 'S3curePass!' })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_401')
  })

  it('maps 403 to forbidden (IP not whitelisted / permission denied)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({}, 403))
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.authenticate({ email: 'a@b.com', password: 'S3curePass!' })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_403')
    expect(String(result.error?.message)).toContain('whitelist')
  })

  it('never logs credentials or the token', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ token: RAW_TOKEN }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    await connector.authenticate({ email: 'reseller@example.com', password: 'S3curePass!' })
    for (const [args] of logSpy.mock.calls as Array<[string]>) {
      const line = String(args)
      expect(line).not.toContain('reseller@example.com')
      expect(line).not.toContain('S3curePass!')
      expect(line).not.toContain(RAW_TOKEN)
    }
    logSpy.mockRestore()
  })
})

describe('US-Matrix testConnection (login then GET /api/v1/clients/current)', () => {
  it('uses GET /clients/current with Bearer token (no mutation)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ id: 'client-1', name: 'Acme', packageCreation: true }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.testConnection()
    expect(result.success).toBe(true)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/api/v1/clients/current')
    expect(init.method).toBe('GET')
    expect(init.headers.Authorization).toBe(`Bearer ${RAW_TOKEN}`)
  })

  it('fails with NO_TOKEN before any request when not authenticated', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider({ apiToken: null }))
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.testConnection()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NO_TOKEN')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('surfaces network/timeout errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ENOTFOUND api-esim.usmatrix.com'))
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.testConnection()
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NETWORK_ERROR')
  })
})

describe('US-Matrix catalog discovery (GET /api/v1/packages)', () => {
  it('syncPlans maps the documented package shape (price USD, dataLimit GB)', async () => {
    const packages = {
      data: [
        { id: 'pkg-1', name: 'Europe 10GB - 30 Days', code: 'EU-10', price: 15, dataLimit: 10, status: 'live', active: true },
        { id: 'pkg-2', name: 'Global 5GB', price: 9, dataLimit: 5 },
      ],
      meta: { itemsPerPage: 100, totalItems: 2, currentPage: 1, totalPages: 1 },
    }
    const fetchSpy = vi.fn().mockResolvedValue(okJson(packages))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.syncPlans()
    expect(result.success).toBe(true)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/v1/packages')
    expect(result.data?.[0]?.id).toBe('pkg-1')
    expect(result.data?.[0]?.data_gb).toBe(10)
    expect(result.data?.[0]?.price_usd).toBe(15)
    expect(result.data?.[0]?.currency).toBe('USD')
  })

  it('is read-only (GET, no creation)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ data: [], meta: { totalItems: 0, itemsPerPage: 100, currentPage: 1, totalPages: 0 } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    await connector.syncPlans()
    expect(fetchSpy.mock.calls[0][1].method).toBe('GET')
  })
})

describe('US-Matrix eSIM inventory (GET /api/v1/esims)', () => {
  it('lists eSIMs defensively and never sends a local OneSIM id', async () => {
    const esims = {
      data: [
        { id: 'esim-uuid-1', iccid: '8944501234567890123', smDpAddress: 'smdp.example.com', activationCode: 'LPA:1$smdp.example.com$code1', qrcodeString: 'LPA:1$smdp.example.com$code1', status: 'assigned' },
      ],
      meta: { itemsPerPage: 100, totalItems: 1, currentPage: 1, totalPages: 1 },
    }
    const fetchSpy = vi.fn().mockResolvedValue(okJson(esims))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.listEsims({ iccid: '8944501234567890123' })
    expect(result.success).toBe(true)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/v1/esims')
    expect(String(fetchSpy.mock.calls[0][0])).toContain('iccid=8944501234567890123')
    expect(result.data?.items?.[0]?.status).toBe('assigned')
  })
})

describe('US-Matrix installation lookup (read-only, EsimDTO fields)', () => {
  it('recovers READY from documented smDpAddress/activationCode/qrcodeString', async () => {
    const esims = {
      data: [
        { id: 'esim-uuid-1', iccid: '8944501234567890123', smDpAddress: 'smdp.example.com', activationCode: 'LPA:1$smdp.example.com$code1', qrcodeString: 'LPA:1$smdp.example.com$code1', status: 'assigned' },
      ],
      meta: { itemsPerPage: 100, totalItems: 1, currentPage: 1, totalPages: 1 },
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson(esims))
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.lookupInstallationData({ iccid: '8944501234567890123' })
    expect(result.state).toBe('READY')
    expect(result.data?.activationCode).toBe('LPA:1$smdp.example.com$code1')
    expect(result.data?.smdpAddress).toBe('smdp.example.com')
    expect(result.data?.qrCode).toBe('LPA:1$smdp.example.com$code1')
  })

  it('never calls POST /esims/qrcode during historical reconciliation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ data: [], meta: { itemsPerPage: 100, totalItems: 0, currentPage: 1, totalPages: 0 } }))
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.lookupInstallationData({ iccid: '8944501234567890123' })
    expect(result.state).toBe('NOT_AVAILABLE_YET')
    for (const call of (globalThis.fetch as any).mock.calls) {
      expect(String(call[0])).not.toContain('/esims/qrcode')
    }
  })

  it('no ICCID → IDENTIFIER_MISSING (no HTTP)', async () => {
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.lookupInstallationData({})
    expect(result.state).toBe('PERMANENT_FAILURE')
    expect(result.errorCode).toBe('IDENTIFIER_MISSING')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('getQRCode is NOT_IMPLEMENTED (POST /esims/qrcode is a flag-update, not a QR generator)', async () => {
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.getQRCode('8944501234567890123')
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NOT_IMPLEMENTED')
    expect(String(result.error?.message)).toContain('lookupInstallationData')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('US-Matrix suspend/resume + purchase are unwired (paths validated in endpoint map, no live mutation)', () => {
  it('suspend/resume/activate/top-up return NOT_IMPLEMENTED and never call the network', async () => {
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    expect((await connector.suspendESIM('x')).error?.code).toBe('NOT_IMPLEMENTED')
    expect((await connector.resumeESIM('x')).error?.code).toBe('NOT_IMPLEMENTED')
    expect((await connector.activateESIM({ planId: 'p', quantity: 1, subscriber: { email: 'a@b.com' } })).error?.code).toBe('NOT_IMPLEMENTED')
    expect((await connector.topUpESIM({ iccid: 'x', planId: 'p', quantity: 1 })).error?.code).toBe('NOT_IMPLEMENTED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('declares the documented mutating paths in the endpoint map for future wiring', () => {
    // Path-accuracy only — never called.
    expect(usMatrixEndpointPath('esims')).toBe('/api/v1/esims')
  })
})

describe('US-Matrix security (logging)', () => {
  it('never logs the full ICCID', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const esims = { data: [{ id: 'e1', iccid: '8944501234567890123', smDpAddress: 'smdp.example.com', activationCode: 'LPA:1$smdp$c', qrcodeString: 'LPA:1$smdp$c', status: 'free' }], meta: { itemsPerPage: 100, totalItems: 1, currentPage: 1, totalPages: 1 } }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson(esims))
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    await connector.listEsims({ iccid: '8944501234567890123' })
    for (const [args] of logSpy.mock.calls as Array<[string]>) {
      expect(String(args)).not.toContain('8944501234567890123')
    }
    logSpy.mockRestore()
  })

  it('never logs the Bearer token or Authorization header', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ id: 'c1' }))
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    await connector.testConnection()
    for (const [args] of logSpy.mock.calls as Array<[string]>) {
      expect(String(args)).not.toContain(RAW_TOKEN)
      expect(String(args)).not.toContain(`Bearer ${RAW_TOKEN}`)
    }
    logSpy.mockRestore()
  })

  it('maskIccid masks full ICCIDs', () => {
    expect(maskIccid('8944501234567890123')).toBe('8944••••0123')
    expect(maskIccid(null)).toBe('')
    expect(maskIccid('')).toBe('')
  })
})
