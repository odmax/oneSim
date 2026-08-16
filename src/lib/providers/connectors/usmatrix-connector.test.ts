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
import { UsMatrixConnector, maskIccid, extractMatchingId } from './usmatrix-connector'
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

  it('declares implemented capabilities (purchase/suspend/resume/install/status/usage wired)', () => {
    const caps = new UsMatrixConnector('usmatrix-1', 'US-Matrix').capabilities!
    expect(caps.installationLookup).toBe(true)
    expect(caps.installationLookupHistorical).toBe(true)
    expect(caps.inventory).toBe(true)
    expect(caps.statusLookup).toBe(true)
    expect(caps.usageLookup).toBe(true)
    expect(caps.topUp).toBe(false)
    expect(caps.suspend).toBe(true)
    expect(caps.resume).toBe(true)
    expect(caps.balance).toBe(false)
    expect(caps.webhooks).toBe(false)
  })

  it('installationDataAtPurchase is SUPPORTED (AssignPackageResponseDTO carries install fields)', () => {
    const caps = new UsMatrixConnector('usmatrix-1', 'US-Matrix').capabilities!
    expect(caps.installationDataAtPurchase).toBe(true)
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

describe('US-Matrix top-up + status + QR are unwired (documented endpoints, no OneSIM wiring)', () => {
  it('top-up/getQRCode return NOT_IMPLEMENTED and never call the network; getStatus is wired', async () => {
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    expect((await connector.topUpESIM({ iccid: 'x', planId: 'p', quantity: 1 })).error?.code).toBe('NOT_IMPLEMENTED')
    expect((await connector.getQRCode('8944501234567890123')).error?.code).toBe('NOT_IMPLEMENTED')
    // getStatus is implemented; with no mock response it errors cleanly (never NOT_IMPLEMENTED).
    const statusResult = await connector.getStatus('provider-esim-uuid')
    expect(statusResult.error?.code).not.toBe('NOT_IMPLEMENTED')
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('declares the documented mutating paths in the endpoint map for path-accuracy', () => {
    // Path-accuracy only — never called from unwired ops.
    expect(usMatrixEndpointPath('esims')).toBe('/api/v1/esims')
  })
})

describe('US-Matrix purchase (POST /api/v1/esims/assign-package)', () => {
  it('posts the exact AssignPackageRequestDTO (package only, no local ids) with Bearer auth', async () => {
    const resp = { id: 'esim-uuid-1', iccid: '8955123456789012345', smDpAddress: 'rsp.truphone.com', activationCode: '1$rsp.truphone.com$EF1234ABCD5678', qrcodeString: 'LPA:1$rsp.truphone.com$EF1234ABCD5678', profile: 'CONSUMER' }
    const fetchSpy = vi.fn().mockResolvedValue(okJson(resp, 201))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.activateESIM({ planId: 'pkg-uuid-1', quantity: 1, subscriber: { email: 'a@b.com' } })
    expect(result.success).toBe(true)
    expect(result.data?.activationId).toBe('esim-uuid-1')
    expect(result.data?.iccids).toEqual(['8955123456789012345'])
    expect(result.data?.activationCodes).toEqual(['1$rsp.truphone.com$EF1234ABCD5678'])
    // qrcodeString is the QR/LPA PAYLOAD — mapped to qrCode, never qrCodeUrl.
    expect(result.data?.qrCode).toBe('LPA:1$rsp.truphone.com$EF1234ABCD5678')
    expect(result.data?.qrCodeUrl).toBeUndefined()
    expect(result.data?.smdpAddress).toBe('rsp.truphone.com')
    expect(result.data?.matchingId).toBe('EF1234ABCD5678')
    expect(result.data?.status).toBe('READY')
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/api/v1/esims/assign-package')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ package: 'pkg-uuid-1' })
    expect(init.headers.Authorization).toBe(`Bearer ${RAW_TOKEN}`)
  })

  it('never sends local OneSIM ids; package is the provider plan id', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ id: 'e1', iccid: '8955123456789012345', smDpAddress: null, activationCode: null, qrcodeString: null, profile: null }, 201))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    await connector.activateESIM({ planId: 'provider-plan-uuid', quantity: 1, subscriber: { email: 'a@b.com' }, orderId: 'onesim-order-1', packageId: 'onesim-pkg-1' })
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.package).toBe('provider-plan-uuid')
    expect(String(body)).not.toContain('onesim-order-1')
    expect(String(body)).not.toContain('onesim-pkg-1')
  })

  it('includes optional client UUID only when configured', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider({ config: { clientId: 'client-uuid-9' } }))
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ id: 'e1', iccid: '8955123456789012345', smDpAddress: null, activationCode: null, qrcodeString: null, profile: null }, 201))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    await connector.activateESIM({ planId: 'pkg-1', quantity: 1, subscriber: { email: 'a@b.com' } })
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({ package: 'pkg-1', client: 'client-uuid-9' })
  })

  it('maps missing iccid to INVALID_RESPONSE', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ id: 'e1', iccid: '', smDpAddress: null, activationCode: null, qrcodeString: null, profile: null }, 201))
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.activateESIM({ planId: 'pkg-1', quantity: 1, subscriber: { email: 'a@b.com' } })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_RESPONSE')
  })

  it('purchase does NOT claim device activation (status is READY/provisioned, never ACTIVE)', async () => {
    const resp = { id: 'esim-uuid-1', iccid: '8955123456789012345', smDpAddress: 'smdp.example.com', activationCode: 'LPA:1$smdp.example.com$c', qrcodeString: 'LPA:1$smdp.example.com$c', profile: 'CONSUMER' }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson(resp, 201))
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.activateESIM({ planId: 'pkg-1', quantity: 1, subscriber: { email: 'a@b.com' } })
    expect(result.success).toBe(true)
    // assign-package returns "package assigned + install credentials generated",
    // NOT proof of network activation → must never claim ACTIVE.
    expect(result.data?.status).toBe('READY')
    expect(result.data?.status).not.toBe('ACTIVE')
  })

  it('maps 404 to HTTP_404 (no compatible eSIM / package not found)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({}, 404))
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.activateESIM({ planId: 'pkg-1', quantity: 1, subscriber: { email: 'a@b.com' } })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_404')
  })

  it('maps 422 to HTTP_422 (package has no vendors / incompatible)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({}, 422))
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.activateESIM({ planId: 'pkg-1', quantity: 1, subscriber: { email: 'a@b.com' } })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_422')
  })

  it('maps 401 to HTTP_401 (token rejected)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({}, 401))
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.activateESIM({ planId: 'pkg-1', quantity: 1, subscriber: { email: 'a@b.com' } })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('HTTP_401')
  })

  it('maps network timeout to TIMEOUT (no silent retry, exactly one request)', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.activateESIM({ planId: 'pkg-1', quantity: 1, subscriber: { email: 'a@b.com' } })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('TIMEOUT')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('fails with NO_TOKEN before any request when not authenticated', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider({ apiToken: null }))
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.activateESIM({ planId: 'pkg-1', quantity: 1, subscriber: { email: 'a@b.com' } })
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('NO_TOKEN')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('never logs the full ICCID / activation code / qrcode string', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const resp = { id: 'e1', iccid: '8955123456789012345', smDpAddress: 'smdp.example.com', activationCode: 'LPA:1$smdp.example.com$code1', qrcodeString: 'LPA:1$smdp.example.com$code1', profile: 'CONSUMER' }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson(resp, 201))
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    await connector.activateESIM({ planId: 'pkg-1', quantity: 1, subscriber: { email: 'a@b.com' } })
    for (const [args] of logSpy.mock.calls as Array<[string]>) {
      expect(String(args)).not.toContain('8955123456789012345')
      expect(String(args)).not.toContain('LPA:1$smdp.example.com$code1')
      expect(String(args)).not.toContain('1$smdp.example.com$code1')
    }
    logSpy.mockRestore()
  })

  it('validatePurchase returns valid only when configured + authenticated', async () => {
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    expect((await connector.validatePurchase()).valid).toBe(true)
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider({ apiToken: null }))
    expect((await connector.validatePurchase()).valid).toBe(false)
  })
})

describe('US-Matrix suspend/resume (PUT /esims/suspend + /esims/unsuspend)', () => {
  it('suspends with the documented SuspendEsimRequestDTO { esims: [eSIM UUID or ICCID] }', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson(null, 204))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.suspendESIM('esim-uuid-1')
    expect(result.success).toBe(true)
    expect(result.data?.status).toBe('SUSPENDED')
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/api/v1/esims/suspend')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ esims: ['esim-uuid-1'] })
  })

  it('resumes with the documented UnsuspendEsimRequestDTO', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson(null, 204))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.resumeESIM('esim-uuid-1')
    expect(result.success).toBe(true)
    expect(result.data?.status).toBe('ACTIVE')
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/api/v1/esims/unsuspend')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ esims: ['esim-uuid-1'] })
  })

  it('never uses the package-level suspend endpoint (esims/suspend, not packages/suspend)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson(null, 204))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    await connector.suspendESIM('esim-uuid-1')
    await connector.resumeESIM('esim-uuid-1')
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toContain('/packages/suspend')
      expect(String(call[0])).not.toContain('/packages/unsuspend')
    }
  })

  it('fails with INVALID_REQUEST when no identifier', async () => {
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    expect((await connector.suspendESIM({} as any)).error?.code).toBe('INVALID_REQUEST')
    expect((await connector.resumeESIM({} as any)).error?.code).toBe('INVALID_REQUEST')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('US-Matrix usage (POST /api/v1/packages/usage)', () => {
  it('posts GetPackageUsageRequestDTO keyed by packageEsimId and normalizes RateGroupDTO', async () => {
    const resp = {
      success: true,
      errmsg: '',
      package: {
        package_status: 'New',
        status: 'active',
        rate_groups: [{
          rate_group_id: 'rg-1', rate_group_allowance: 5, rate_group_allow_qtyp: 'GB',
          rate_group_usage: 1.25, rate_group_total_qty: 5, rate_group_throttle_usage: 0,
          rate_group_throttle_qtyp: 'GB', rate_group_starttime: '2026-08-01', rate_group_expire: '2026-08-31',
          rate_group_days_used: 10,
        }],
      },
    }
    const fetchSpy = vi.fn().mockResolvedValue(okJson(resp))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.getUsage('package-esim-uuid-1')
    expect(result.success).toBe(true)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/api/v1/packages/usage')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ packageEsimId: 'package-esim-uuid-1' })
    // 1.25 GB → MB
    expect(result.data?.dataUsedMB).toBe(1280)
    expect(result.data?.dataTotalMB).toBe(5120)
    expect(result.data?.dataRemainingMB).toBe(3840)
    expect(result.data?.percentageUsed).toBe(25)
    expect(result.data?.expiresAt).toBe('2026-08-31')
  })

  it('rejects ICCIDs / local ids as packageEsimId (never leaks them upstream)', async () => {
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r1 = await connector.getUsage('8955123456789012345')
    expect(r1.success).toBe(false)
    expect(r1.error?.code).toBe('INVALID_IDENTIFIER')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns INVALID_RESPONSE when rate_groups missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ success: true, errmsg: '', package: { package_status: 'New', status: 'active', rate_groups: [] } }))
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.getUsage('package-esim-uuid-1')
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_RESPONSE')
  })
})

describe('US-Matrix read-only helpers (availability + countries)', () => {
  it('availability-count posts packageIds and returns counts', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ counts: { 'pkg-1': 12, 'pkg-2': 0 } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.availabilityCount(['pkg-1', 'pkg-2'])
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ 'pkg-1': 12, 'pkg-2': 0 })
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/api/v1/esims/availability-count')
    expect(JSON.parse(init.body)).toEqual({ packageIds: ['pkg-1', 'pkg-2'] })
  })

  it('availability-count/{packageId} returns a single count', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ packageId: 'pkg-1', count: 7 }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.availabilityCountForPackage('pkg-1')
    expect(result.success).toBe(true)
    expect(result.data).toBe(7)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/v1/esims/availability-count/pkg-1')
  })

  it('countries returns documented CountryDTO list (read-only)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({ data: [{ id: 'c1', name: 'South Africa', region: 'Africa', iso3: 'ZAF', imagePath: '/flags/za.png' }], count: 1 }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const result = await connector.listCountries()
    expect(result.success).toBe(true)
    expect(result.data?.[0]?.iso3).toBe('ZAF')
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/v1/countries')
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

describe('extractMatchingId (conservative LPA component extraction)', () => {
  it('extracts the matching id from a standard LPA payload', () => {
    expect(extractMatchingId('LPA:1$rsp.example.com$ABCDEF1234567890')).toBe('ABCDEF1234567890')
    expect(extractMatchingId('1$rsp.example.com$ABCDEF1234567890')).toBe('ABCDEF1234567890')
  })

  it('returns null for a plain activation code (not an LPA shape)', () => {
    expect(extractMatchingId('TN2023041314334227F18CAD')).toBeNull()
  })

  it('returns null for an HTTP URL', () => {
    expect(extractMatchingId('https://provider.example/qr/123.png')).toBeNull()
  })

  it('returns null for malformed / missing components', () => {
    expect(extractMatchingId('LPA:1$only-two$parts$x')).toBeNull() // extra $
    expect(extractMatchingId('LPA:1$smdp$')).toBeNull() // empty third
    expect(extractMatchingId('1$smdp')).toBeNull() // two parts only
    expect(extractMatchingId(null)).toBeNull()
    expect(extractMatchingId('')).toBeNull()
  })

  it('never returns the entire activation code as a matching id', () => {
    // If the value is a full LPA payload the extracted id is the LAST segment,
    // never the whole string.
    const full = 'LPA:1$smdp.example.com$MID-42'
    expect(extractMatchingId(full)).toBe('MID-42')
    expect(extractMatchingId(full)).not.toBe(full)
  })
})

describe('US-Matrix status lookup (read-only evidence policy)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())
    mockPrisma.provider.update.mockResolvedValue({})
  })

  function infoResponse(overrides: any = {}) {
    return okJson({
      activationProfile: { iccid: '8944501234567890123', eid: '8904305', imsi: '724543', status: 'ENABLED' },
      profileLogs: [{ status: 'ENABLED', type: 'PROFILE', eventName: 'INSTALL', createdAt: '2026-08-01T10:00:00Z' }],
      ...overrides,
    })
  }

  it('resolveStatusLookup returns a structured bundle (provider UUID + ICCID for identity check)', () => {
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = connector.resolveStatusLookup!({ providerActivationId: 'esim-uuid-1', iccid: '8944501234567890123' } as any)
    expect(r).toEqual({ providerActivationId: 'esim-uuid-1', iccid: '8944501234567890123' })
    expect(JSON.stringify(r)).not.toContain('local')
  })

  it('resolveStatusLookup falls back to providerResponse.providerEsimId', () => {
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = connector.resolveStatusLookup!({ providerActivationId: '', providerResponse: { providerEsimId: 'esim-uuid-9' } } as any)
    expect(r).toEqual({ providerActivationId: 'esim-uuid-9' })
  })

  it('resolveStatusLookup returns null when no provider UUID exists', () => {
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = connector.resolveStatusLookup!({ iccid: '8944501234567890123' } as any)
    expect(r).toBeNull()
  })

  it('assigned-only (no profile/network evidence) stays PENDING_ACTIVATION', async () => {
    const fetchSpy = vi.fn()
    fetchSpy
      .mockResolvedValueOnce(okJson({ activationProfile: { status: 'assigned' }, profileLogs: [] }))
      .mockResolvedValueOnce(okJson({ data: [] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getStatus('esim-uuid-1')
    expect(r.success).toBe(true)
    expect(r.data?.status).toBe('PENDING_ACTIVATION')
  })

  it('profile ENABLED does NOT automatically mean ACTIVE (INSTALLED only)', async () => {
    const fetchSpy = vi.fn()
    fetchSpy
      .mockResolvedValueOnce(infoResponse())
      .mockResolvedValueOnce(okJson({ data: [] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getStatus('esim-uuid-1')
    expect(r.success).toBe(true)
    expect(r.data?.status).toBe('INSTALLED')
    expect(r.data?.status).not.toBe('ACTIVE')
  })

  it('suspended → SUSPENDED', async () => {
    const fetchSpy = vi.fn()
    fetchSpy
      .mockResolvedValueOnce(okJson({ activationProfile: { status: 'SUSPENDED' }, profileLogs: [] }))
      .mockResolvedValueOnce(okJson({ data: [] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getStatus('esim-uuid-1')
    expect(r.data?.status).toBe('SUSPENDED')
  })

  it('successful network attach → ACTIVE evidence', async () => {
    const fetchSpy = vi.fn()
    fetchSpy
      .mockResolvedValueOnce(okJson({ activationProfile: { status: 'ENABLED' }, profileLogs: [] }))
      .mockResolvedValueOnce(okJson({ data: [{ event_time: '2026-08-02T08:00:00Z', request_type: 'Update Location', request_status: 'DIAMETER_SUCCESS', serving_network: '65501', network_type: 'LTE', volume_used: 12 }] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getStatus('esim-uuid-1')
    expect(r.data?.status).toBe('ACTIVE')
  })

  it('real evidence: exact empirical envelopes (info + location logs) → ACTIVE with evidence', async () => {
    // EXACT empirical location-event envelope: { search_id, page_number,
    // total_pages, data: [...] } — events live at response.data.data.
    const locationLogs = {
      search_id: 'search-abc',
      page_number: 1,
      total_pages: 1,
      data: [
        {
          event_time: '2026-08-16 09:08:42.274',
          request_type: 'Initial',
          request_status: 'DIAMETER_SUCCESS',
          imsi: '65501',
          iccid: '8944501234567890123',
          country_network: 'South Africa-Vodacom',
          serving_network: '65501',
          network_type: '4G LTE',
          volume_used: 0.3906280854716897,
        },
        {
          event_time: '2026-08-15 18:02:10.000',
          request_type: 'Update',
          request_status: 'DIAMETER_SUCCESS',
          imsi: '65501',
          iccid: '8944501234567890123',
          country_network: 'South Africa-Vodacom',
          serving_network: '65501',
          network_type: '3G UTRAN',
          volume_used: 0.1,
        },
      ],
    }
    const fetchSpy = vi.fn()
    fetchSpy
      .mockResolvedValueOnce(okJson({
        // EXACT empirical /esims/info envelope.
        activationProfile: { status: 'ENABLE', eid: '8904305000000000001', imsi: '655010000000001' },
        profileLogs: [
          { status: 'AVAILABLE', type: 'PROFILE', eventName: 'CREATE', createdAt: '2026-08-16T09:00:00Z', result: 'success' },
          { status: 'DOWNLOADED', type: 'PROFILE', eventName: 'DOWNLOAD', createdAt: '2026-08-16T09:01:00Z', result: 'success' },
          { status: 'INSTALLED', type: 'PROFILE', eventName: 'INSTALL', createdAt: '2026-08-16T09:02:00Z', result: 'success' },
          { status: 'ENABLED', type: 'PROFILE', eventName: 'ENABLE', createdAt: '2026-08-16T09:03:00Z', result: 'success' },
        ],
      }))
      .mockResolvedValueOnce(okJson(locationLogs))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getStatus({ providerActivationId: 'esim-uuid-1', iccid: '8944501234567890123' })
    expect(r.success).toBe(true)
    // The connector MUST normalize verified attach into the canonical contract.
    expect(r.data?.status).toBe('ACTIVE')
    expect(r.data?.rawStatus).toBe('network_attach')
    expect(r.data?.evidence).toMatchObject({ networkAttached: true })
    expect(r.data?.evidence?.reason).toBe('diameter-success-attach')
    expect(r.data?.evidence?.observedAt).toBe('2026-08-16 09:08:42.274')
    // Sanitized metadata (no PIN/PUK/ADM/raw profile payload persisted).
    expect(r.data?.rawMetadata?.servingNetwork).toBe('65501')
    expect(r.data?.rawMetadata?.networkType).toBe('4G LTE')
    expect(r.data?.rawMetadata?.countryNetwork).toBe('South Africa-Vodacom')
    expect(JSON.stringify(r.data)).not.toContain('8904305000000000001') // EID not persisted
    expect(JSON.stringify(r.data)).not.toContain('PIN')
    expect(JSON.stringify(r.data)).not.toContain('PUK')
  })

  it('selects the NEWEST valid event (stale failure does not override fresh attach)', async () => {
    const fetchSpy = vi.fn()
    fetchSpy
      .mockResolvedValueOnce(okJson({ activationProfile: { status: 'ENABLE' }, profileLogs: [] }))
      .mockResolvedValueOnce(okJson({ data: [
        { event_time: '2026-08-15T08:00:00Z', request_status: 'DIAMETER_SUCCESS', serving_network: '65501', network_type: '3G', iccid: '8944501234567890123' },
        { event_time: '2026-08-14T08:00:00Z', request_status: 'DIAMETER_ERROR_LOCAL_HHR', serving_network: '65501', network_type: '3G', iccid: '8944501234567890123' },
      ] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getStatus({ providerActivationId: 'esim-uuid-1', iccid: '8944501234567890123' })
    expect(r.data?.status).toBe('ACTIVE')
    expect(r.data?.rawMetadata?.observedAt).toBe('2026-08-15T08:00:00Z')
  })

  it('ENABLE + INSTALLED logs but EMPTY location events → INSTALLED (not ACTIVE)', async () => {
    const fetchSpy = vi.fn()
    fetchSpy
      .mockResolvedValueOnce(okJson({ activationProfile: { status: 'ENABLE' }, profileLogs: [
        { status: 'INSTALLED', eventName: 'INSTALL', createdAt: '2026-08-16T09:02:00Z' },
        { status: 'ENABLED', eventName: 'ENABLE', createdAt: '2026-08-16T09:03:00Z' },
      ] }))
      .mockResolvedValueOnce(okJson({ search_id: 's', page_number: 1, total_pages: 0, data: [] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getStatus('esim-uuid-1')
    expect(r.data?.status).toBe('INSTALLED')
    expect(r.data?.evidence).toMatchObject({ deviceInstalled: true })
    expect(r.data?.status).not.toBe('ACTIVE')
  })

  it('mismatched event ICCID is NOT evidence (never promote from another eSIM)', async () => {
    const fetchSpy = vi.fn()
    fetchSpy
      .mockResolvedValueOnce(okJson({ activationProfile: { status: 'ENABLE' }, profileLogs: [] }))
      .mockResolvedValueOnce(okJson({ data: [
        { event_time: '2026-08-16T09:08:42Z', request_status: 'DIAMETER_SUCCESS', serving_network: '65501', network_type: '4G', iccid: '8944999999999999999' },
      ] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getStatus({ providerActivationId: 'esim-uuid-1', iccid: '8944501234567890123' })
    expect(r.data?.status).toBe('INSTALLED') // profile enabled but event belongs to another ICCID
    expect(r.data?.status).not.toBe('ACTIVE')
  })

  it('event without ICCID is accepted when the endpoint is scoped to the provider eSIM id (documented policy)', async () => {
    const fetchSpy = vi.fn()
    fetchSpy
      .mockResolvedValueOnce(okJson({ activationProfile: { status: 'ENABLE' }, profileLogs: [] }))
      .mockResolvedValueOnce(okJson({ data: [
        { event_time: '2026-08-16T09:08:42Z', request_status: 'DIAMETER_SUCCESS', serving_network: '65501', network_type: '4G' },
      ] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getStatus({ providerActivationId: 'esim-uuid-1', iccid: '8944501234567890123' })
    expect(r.data?.status).toBe('ACTIVE')
  })

  it('failed network event does NOT → ACTIVE', async () => {
    const fetchSpy = vi.fn()
    fetchSpy
      .mockResolvedValueOnce(okJson({ activationProfile: { status: 'ENABLED' }, profileLogs: [] }))
      .mockResolvedValueOnce(okJson({ data: [{ event_time: '2026-08-02T08:00:00Z', request_type: 'Update Location', request_status: 'DIAMETER_ERROR_LOCAL_HHR', serving_network: '65501' }] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getStatus('esim-uuid-1')
    expect(r.data?.status).toBe('INSTALLED') // profile enabled but no attach
    expect(r.data?.evidence?.networkAttached).toBeFalsy()
    expect(r.data?.status).not.toBe('ACTIVE')
  })

  it('secrets never logged during status lookup (safe field-name diagnostics only)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchSpy = vi.fn()
    fetchSpy
      .mockResolvedValueOnce(infoResponse())
      .mockResolvedValueOnce(okJson({ data: [] }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    await connector.getStatus('esim-uuid-1')
    for (const [args] of logSpy.mock.calls as Array<[string]>) {
      expect(String(args)).not.toContain('8944501234567890123')
      expect(String(args)).not.toContain('724543')
      expect(String(args)).not.toContain('Bearer ')
    }
    logSpy.mockRestore()
  })
})

describe('US-Matrix usage (POST /packages/usage, rate-group normalization)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.provider.findUnique.mockResolvedValue(mockProvider())
    mockPrisma.provider.update.mockResolvedValue({})
  })

  it('resolveUsageLookup returns packageEsimId only when persisted in providerResponse', () => {
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = connector.resolveUsageLookup!({ providerResponse: { packageEsimId: 'assoc-uuid-1' } } as any)
    expect(r).toBe('assoc-uuid-1')
  })

  it('resolveUsageLookup returns a structured bundle (provider eSIM UUID) when no association id persisted', () => {
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = connector.resolveUsageLookup!({ providerActivationId: 'esim-uuid-1', providerResponse: { providerEsimId: 'esim-uuid-1' } } as any)
    // Not persisted → carry the provider eSIM UUID so getUsage can discover the association.
    expect(r).toEqual({ providerActivationId: 'esim-uuid-1' })
  })

  it('resolveUsageLookup returns null when no provider identifier exists at all', () => {
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = connector.resolveUsageLookup!({ providerResponse: {} } as any)
    expect(r).toBeNull()
  })

  it('resolveUsageLookup rejects an ICCID-shaped value (not an association id)', () => {
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = connector.resolveUsageLookup!({ providerResponse: { packageEsimId: '8944501234567890123' } } as any)
    expect(r).toBeNull()
  })

  it('resolveUsageLookup bundle carries provider-owned package identity for deterministic matching', () => {
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = connector.resolveUsageLookup!({ providerActivationId: 'esim-uuid-1', providerPlanId: 'pkg-uuid-77', providerPackageId: 'pp-1', providerResponse: { providerEsimId: 'esim-uuid-1' } } as any)
    expect(r).toEqual({ providerActivationId: 'esim-uuid-1', providerPlanId: 'pkg-uuid-77', providerPackageId: 'pp-1' })
  })

  it('persisted packageEsimId fast path: NO mobile-detail discovery call', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJson({
      success: true, errmsg: '',
      package: { status: 'active', package_status: 'In Use', rate_groups: [
        { rate_group_id: 'rg-1', rate_group_allowance: 10, rate_group_allow_qtyp: 'GB', rate_group_usage: 1, rate_group_total_qty: 10, rate_group_throttle_usage: 0, rate_group_throttle_qtyp: 'GB', rate_group_starttime: 'x', rate_group_expire: 'y', rate_group_days_used: 1 },
      ] },
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const lookup = connector.resolveUsageLookup!({ providerActivationId: 'esim-uuid-1', providerResponse: { packageEsimId: 'assoc-uuid-1' } } as any)
    expect(lookup).toBe('assoc-uuid-1')
    const r = await connector.getUsage(lookup as string)
    expect(r.success).toBe(true)
    // Exactly ONE HTTP call — /packages/usage only; mobile-detail is never hit.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/packages/usage')
    expect(String(fetchSpy.mock.calls[0][0])).not.toContain('/mobile-detail')
    expect(r.data?.providerPackageEsimId).toBe('assoc-uuid-1')
  })

  it('exposes the discovered packageEsimId as providerPackageEsimId for canonical persistence', async () => {
    const fetchSpy = vi.fn()
    fetchSpy
      .mockResolvedValueOnce(okJson({ data: { packageEsims: [{ id: 'assoc-uuid-9', status: 'active', package: { id: 'pkg-uuid-77' } }] } }))
      .mockResolvedValueOnce(okJson({ success: true, errmsg: '', package: { package_status: 'New', status: 'active', rate_groups: [
        { rate_group_id: 'rg-1', rate_group_allowance: 10, rate_group_allow_qtyp: 'GB', rate_group_usage: 1, rate_group_total_qty: 10, rate_group_throttle_usage: 0, rate_group_throttle_qtyp: 'GB', rate_group_starttime: 'x', rate_group_expire: 'y', rate_group_days_used: 1 },
      ] } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getUsage({ providerActivationId: 'esim-uuid-1' })
    expect(r.success).toBe(true)
    expect(r.data?.providerPackageEsimId).toBe('assoc-uuid-9')
  })

  it('getUsage rejects a local ICCID (no packageEsimId) cleanly', async () => {
    const fetchSpy = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getUsage('8944501234567890123')
    expect(r.success).toBe(false)
    expect(r.error?.code).toBe('INVALID_IDENTIFIER')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('normalizes GB usage to MB (single rate group)', async () => {
    const resp = okJson({
      success: true, errmsg: '',
      package: { package_status: 'New', status: 'active', rate_groups: [
        { rate_group_id: 'rg-1', rate_group_allowance: 5, rate_group_allow_qtyp: 'GB', rate_group_usage: 1.25, rate_group_total_qty: 5, rate_group_throttle_usage: 0, rate_group_throttle_qtyp: 'GB', rate_group_starttime: '2026-08-01', rate_group_expire: '2026-08-31', rate_group_days_used: 10 },
      ] },
    })
    const fetchSpy = vi.fn().mockResolvedValue(resp)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getUsage('assoc-uuid-1')
    expect(r.success).toBe(true)
    expect(r.data?.dataTotalMB).toBe(5120) // 5 GB
    expect(r.data?.dataUsedMB).toBe(1280) // 1.25 GB
    expect(r.data?.dataRemainingMB).toBe(3840)
    expect(r.data?.expiresAt).toBe('2026-08-31')
  })

  it('normalizes MB usage to MB (unit passthrough)', async () => {
    const resp = okJson({
      success: true, errmsg: '',
      package: { package_status: 'New', status: 'active', rate_groups: [
        { rate_group_id: 'rg-1', rate_group_allowance: 1024, rate_group_allow_qtyp: 'MB', rate_group_usage: 512, rate_group_total_qty: 1024, rate_group_throttle_usage: 0, rate_group_throttle_qtyp: 'MB', rate_group_starttime: '2026-08-01', rate_group_expire: '2026-08-31', rate_group_days_used: 5 },
      ] },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getUsage('assoc-uuid-1')
    expect(r.data?.dataTotalMB).toBe(1024)
    expect(r.data?.dataUsedMB).toBe(512)
    expect(r.data?.dataRemainingMB).toBe(512)
  })

  it('aggregates multiple rate groups without double-counting', async () => {
    const resp = okJson({
      success: true, errmsg: '',
      package: { package_status: 'New', status: 'active', rate_groups: [
        { rate_group_id: 'rg-1', rate_group_allowance: 2, rate_group_allow_qtyp: 'GB', rate_group_usage: 0.5, rate_group_total_qty: 2, rate_group_throttle_usage: 0, rate_group_throttle_qtyp: 'GB', rate_group_starttime: '2026-08-01', rate_group_expire: '2026-08-31', rate_group_days_used: 10 },
        { rate_group_id: 'rg-2', rate_group_allowance: 3, rate_group_allow_qtyp: 'GB', rate_group_usage: 1, rate_group_total_qty: 3, rate_group_throttle_usage: 0, rate_group_throttle_qtyp: 'GB', rate_group_starttime: '2026-08-01', rate_group_expire: '2026-09-30', rate_group_days_used: 5 },
      ] },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getUsage('assoc-uuid-1')
    expect(r.data?.dataTotalMB).toBe(5120) // 2+3 GB
    expect(r.data?.dataUsedMB).toBe(1536) // 0.5+1 GB
    expect(r.data?.dataRemainingMB).toBe(3584)
    expect(r.data?.expiresAt).toBe('2026-09-30') // latest
  })

  it('remaining = total - used always non-negative', async () => {
    const resp = okJson({
      success: true, errmsg: '',
      package: { package_status: 'New', status: 'active', rate_groups: [
        { rate_group_id: 'rg-1', rate_group_allowance: 1, rate_group_allow_qtyp: 'GB', rate_group_usage: 2, rate_group_total_qty: 1, rate_group_throttle_usage: 0, rate_group_throttle_qtyp: 'GB', rate_group_starttime: '2026-08-01', rate_group_expire: '2026-08-31', rate_group_days_used: 10 },
      ] },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getUsage('assoc-uuid-1')
    expect(r.data?.dataRemainingMB).toBe(0)
  })

  it('returns INVALID_RESPONSE when no rate groups', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ success: true, errmsg: '', package: { package_status: 'New', status: 'active', rate_groups: [] } }))
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getUsage('assoc-uuid-1')
    expect(r.success).toBe(false)
    expect(r.error?.code).toBe('INVALID_RESPONSE')
  })

  it('discovers packageEsimId from mobile-detail packageEsims[].id (never package.id)', async () => {
    const fetchSpy = vi.fn()
    // First call: mobile-detail returns packageEsims with association id + package.id (distinct).
    fetchSpy
      .mockResolvedValueOnce(okJson({
        data: {
          packageEsims: [
            { id: 'assoc-uuid-9', status: 'active', usageValue: 0, package: { id: 'pkg-uuid-77', name: 'Test', dataLimit: 10 } },
          ],
        },
      }))
      .mockResolvedValueOnce(okJson({
        success: true, errmsg: '',
        package: { package_status: 'New', status: 'active', rate_groups: [
          { rate_group_id: 'rg-1', rate_group_allowance: 10, rate_group_allow_qtyp: 'GB', rate_group_usage: 1, rate_group_total_qty: 10, rate_group_throttle_usage: 0, rate_group_throttle_qtyp: 'GB', rate_group_starttime: '2026-08-16', rate_group_expire: '2026-09-05', rate_group_days_used: 1 },
        ] },
      }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getUsage({ providerActivationId: 'esim-uuid-1' })
    expect(r.success).toBe(true)
    // The usage POST body must carry the ASSOCIATION id, never package.id.
    const usageBody = JSON.parse(fetchSpy.mock.calls[1][1].body)
    expect(usageBody.packageEsimId).toBe('assoc-uuid-9')
    expect(usageBody.packageEsimId).not.toBe('pkg-uuid-77')
  })

  it('selects the single exact provider-package match among multiple associations', async () => {
    const fetchSpy = vi.fn()
    fetchSpy
      .mockResolvedValueOnce(okJson({
        data: {
          packageEsims: [
            { id: 'assoc-other', status: 'active', package: { id: 'pkg-other' } },
            { id: 'assoc-match', status: 'active', package: { id: 'pkg-uuid-77' } },
          ],
        },
      }))
      .mockResolvedValueOnce(okJson({ success: true, errmsg: '', package: { package_status: 'New', status: 'active', rate_groups: [
        { rate_group_id: 'rg-1', rate_group_allowance: 5, rate_group_allow_qtyp: 'GB', rate_group_usage: 1, rate_group_total_qty: 5, rate_group_throttle_usage: 0, rate_group_throttle_qtyp: 'GB', rate_group_starttime: 'x', rate_group_expire: 'y', rate_group_days_used: 1 },
      ] } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getUsage({ providerActivationId: 'esim-uuid-1', providerPlanId: 'pkg-uuid-77' })
    expect(r.success).toBe(true)
    const usageBody = JSON.parse(fetchSpy.mock.calls[1][1].body)
    expect(usageBody.packageEsimId).toBe('assoc-match')
  })

  it('ambiguous multiple associations → clean skip, NO /packages/usage call', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(okJson({
      data: {
        packageEsims: [
          { id: 'assoc-a', status: 'active', package: { id: 'pkg-a' } },
          { id: 'assoc-b', status: 'active', package: { id: 'pkg-b' } },
        ],
      },
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getUsage({ providerActivationId: 'esim-uuid-1', providerPlanId: 'pkg-uuid-77' })
    expect(r.success).toBe(false)
    expect(r.error?.code).toBe('AMBIGUOUS_ASSOCIATION')
    expect(fetchSpy).toHaveBeenCalledTimes(1) // mobile-detail only — never a guess
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/mobile-detail')
    expect(String(fetchSpy.mock.calls[0][0])).not.toContain('/packages/usage')
  })

  it('multiple associations with no provider package identity → ambiguous (never blindly index 0)', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(okJson({
      data: {
        packageEsims: [
          { id: 'assoc-a', status: 'active', package: { id: 'pkg-a' } },
          { id: 'assoc-b', status: 'active', package: { id: 'pkg-b' } },
        ],
      },
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getUsage({ providerActivationId: 'esim-uuid-1' })
    expect(r.success).toBe(false)
    expect(r.error?.code).toBe('AMBIGUOUS_ASSOCIATION')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('exactly one association is selected without requiring package identity', async () => {
    const fetchSpy = vi.fn()
    fetchSpy
      .mockResolvedValueOnce(okJson({ data: { packageEsims: [{ id: 'assoc-only', status: 'active', package: { id: 'pkg-1' } }] } }))
      .mockResolvedValueOnce(okJson({ success: true, errmsg: '', package: { package_status: 'New', status: 'active', rate_groups: [
        { rate_group_id: 'rg-1', rate_group_allowance: 5, rate_group_allow_qtyp: 'GB', rate_group_usage: 1, rate_group_total_qty: 5, rate_group_throttle_usage: 0, rate_group_throttle_qtyp: 'GB', rate_group_starttime: 'x', rate_group_expire: 'y', rate_group_days_used: 1 },
      ] } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getUsage({ providerActivationId: 'esim-uuid-1' })
    expect(r.success).toBe(true)
    const usageBody = JSON.parse(fetchSpy.mock.calls[1][1].body)
    expect(usageBody.packageEsimId).toBe('assoc-only')
  })

  it('no association found → clean unavailable (no usage call)', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(okJson({ data: { packageEsims: [] } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getUsage({ providerActivationId: 'esim-uuid-1' })
    expect(r.success).toBe(false)
    expect(r.error?.code).toBe('NO_ASSOCIATION')
    expect(fetchSpy).toHaveBeenCalledTimes(1) // mobile-detail only, no /packages/usage
  })

  it('normalizes the live 10GB / 0.390628GB sample to expected MB values', async () => {
    const resp = okJson({
      success: true, errmsg: '',
      package: { status: 'active', package_status: 'In Use', rate_groups: [
        { rate_group_id: 'rg-1', rate_group_allowance: 10, rate_group_allow_qtyp: 'GB', rate_group_usage: 0.3906280854716897, rate_group_total_qty: 10, rate_group_throttle_usage: 0, rate_group_throttle_qtyp: 'GB', rate_group_starttime: '2026-08-16 09:08:42.274', rate_group_expire: '2026-09-05 09:08:42.274', rate_group_days_used: 1 },
      ] },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getUsage('assoc-uuid-live')
    expect(r.success).toBe(true)
    expect(r.data?.dataTotalMB).toBe(10240) // 10 GB
    expect(r.data?.dataUsedMB).toBe(400) // 0.3906 GB ≈ 400 MB
    expect(r.data?.dataRemainingMB).toBe(9840)
    expect(r.data?.expiresAt).toBe('2026-09-05 09:08:42.274')
  })

  it('KB and bytes units convert correctly', async () => {
    const resp = okJson({
      success: true, errmsg: '',
      package: { package_status: 'New', status: 'active', rate_groups: [
        { rate_group_id: 'rg-1', rate_group_allowance: 2048, rate_group_allow_qtyp: 'KB', rate_group_usage: 512, rate_group_total_qty: 2048, rate_group_throttle_usage: 0, rate_group_throttle_qtyp: 'KB', rate_group_starttime: 'x', rate_group_expire: 'y', rate_group_days_used: 1 },
        { rate_group_id: 'rg-2', rate_group_allowance: 1048576, rate_group_allow_qtyp: 'B', rate_group_usage: 524288, rate_group_total_qty: 1048576, rate_group_throttle_usage: 0, rate_group_throttle_qtyp: 'B', rate_group_starttime: 'x', rate_group_expire: 'z', rate_group_days_used: 1 },
      ] },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp)
    const connector = new UsMatrixConnector('usmatrix-1', 'US-Matrix')
    const r = await connector.getUsage('assoc-uuid-1')
    // KB: 2048 KB = 2 MB total, 512 KB = 0.5 MB used
    // B: 1048576 B = 1 MB total, 524288 B = 0.5 MB used
    expect(r.data?.dataTotalMB).toBe(3)
    expect(r.data?.dataUsedMB).toBe(1)
  })
})
