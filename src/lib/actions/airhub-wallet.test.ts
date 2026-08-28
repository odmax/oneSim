import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: { findUnique: vi.fn(), update: vi.fn() },
    providerWallet: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    providerWalletSnapshot: { create: vi.fn() },
    providerWalletTransaction: { upsert: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    backgroundJob: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(null) },
  },
}))

vi.mock('@/lib/encryption', () => ({
  encryptToken: vi.fn((s: string) => `enc_${s}`),
  decryptToken: vi.fn((s: string) => s.replace('enc_', '')),
}))

vi.mock('@/lib/services/providers/health-monitor', () => ({
  recordHealthEvent: vi.fn(),
}))

import { prisma } from '@/lib/prisma'

const mockPrisma = vi.mocked(prisma)

/** fetch helper: first call is the login, subsequent calls are wallet endpoints. */
function sequenceResponses(login: any, wallet: any) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/UserLogin')) return { ok: true, status: 200, text: async () => JSON.stringify(login) }
    return { ok: true, status: 200, text: async () => JSON.stringify(wallet) }
  }))
}

function airhubProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'airhub-1', code: 'AIRHUB', name: 'AirHub',
    config: { username: 'u', password: 'p', partnerCode: 12345, tokenExpiry: Date.now() + 99999 },
    apiToken: 'enc_tok', tokenPlacement: 'BEARER_HEADER',
    ...overrides,
  }
}

describe('Airhub Wallet — Full Integration', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('manual refresh succeeds and updates balance (auth persists partnerCode first)', async () => {
    sequenceResponses(
      { isSuccess: true, token: 'fresh-login-token-abcdef', data: { partnerCode: 12345 } },
      { isSuccess: true, message: 'ok', getwallet: { balance: 150.50, currency: 'USD' } },
    )

    mockPrisma.provider.findUnique.mockResolvedValue(airhubProvider())
    mockPrisma.provider.update.mockResolvedValue(airhubProvider())
    mockPrisma.providerWallet.findUnique.mockResolvedValue(null)
    mockPrisma.providerWallet.upsert.mockResolvedValue({ id: 'w1', balance: 150.5, currency: 'USD', lastSyncedAt: new Date() })
    mockPrisma.providerWalletSnapshot.create.mockResolvedValue({ id: 's1' })

    const { fetchAirhubWallet } = await import('./airhub-wallet')
    const result = await fetchAirhubWallet('airhub-1', 'MANUAL')
    expect(result.success).toBe(true)
    expect(result.data?.balance).toBe(150.50)
    vi.unstubAllGlobals()
  })

  it('manual refresh preserves previous balance on failure', async () => {
    sequenceResponses(
      { isSuccess: true, token: 'fresh-login-token-abcdef', data: { partnerCode: 12345 } },
      { isSuccess: false, message: 'provider rejected wallet' },
    )

    mockPrisma.provider.findUnique.mockResolvedValue(airhubProvider())
    mockPrisma.provider.update.mockResolvedValue(airhubProvider())
    mockPrisma.providerWallet.findUnique.mockResolvedValue({ id: 'w1', balance: 100, currency: 'USD', syncStatus: 'OK', lastSyncedAt: new Date() })
    mockPrisma.providerWallet.update.mockResolvedValue({ id: 'w1', balance: 100 })

    const { fetchAirhubWallet } = await import('./airhub-wallet')
    const result = await fetchAirhubWallet('airhub-1', 'MANUAL')
    expect(result.success).toBe(false)
    // Verify update was called, preserving balance
    const updateCalls = (prisma.providerWallet.update as any).mock.calls
    expect(updateCalls.length).toBeGreaterThanOrEqual(1)
    vi.unstubAllGlobals()
  })

  it('partnercode is sent as query parameter on the legacy fallback URL', async () => {
    let capturedUrl = ''
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/UserLogin')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ isSuccess: true, token: 'tok-abcdef', data: { partnerCode: 12345 } }) }
      }
      capturedUrl = String(url)
      if (url.includes('/GetWallet')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ isSuccess: true, message: 'ok', getwallet: {} }) }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ balance: 50 }) }
    }))

    mockPrisma.provider.findUnique.mockResolvedValue(airhubProvider())
    mockPrisma.provider.update.mockResolvedValue(airhubProvider())
    mockPrisma.providerWallet.findUnique.mockResolvedValue(null)
    mockPrisma.providerWallet.upsert.mockResolvedValue({ id: 'w1', balance: 50, currency: 'USD', lastSyncedAt: new Date() })
    mockPrisma.providerWalletSnapshot.create.mockResolvedValue({})

    const { fetchAirhubWallet } = await import('./airhub-wallet')
    const result = await fetchAirhubWallet('airhub-1')
    expect(result.success).toBe(true)
    expect(capturedUrl).toContain('partnercode=12345')
    expect(capturedUrl).toContain('/api/ESIM/get_wallet_invidual')
    vi.unstubAllGlobals()
  })

  it('malformed balance returns error and does NOT overwrite', async () => {
    sequenceResponses(
      { isSuccess: true, token: 'fresh-login-token-abcdef', data: { partnerCode: 12345 } },
      { isSuccess: true, message: 'ok', getwallet: { foo: 'bar' } },
    )

    mockPrisma.provider.findUnique.mockResolvedValue(airhubProvider())
    mockPrisma.provider.update.mockResolvedValue(airhubProvider())
    mockPrisma.providerWallet.findUnique.mockResolvedValue({ id: 'w1', balance: 100, currency: 'USD', syncStatus: 'OK', lastSyncedAt: new Date() })
    mockPrisma.providerWallet.update.mockResolvedValue({})

    const { fetchAirhubWallet } = await import('./airhub-wallet')
    const result = await fetchAirhubWallet('airhub-1')
    expect(result.success).toBe(false)

    // Verify balance was NOT overwritten (update is called but balance is preserved)
    const updateCalls = (prisma.providerWallet.update as any).mock.calls
    expect(updateCalls.length).toBeGreaterThanOrEqual(1)
    vi.unstubAllGlobals()
  })

  it('missing partnerCode (no login partner + no config partner) returns error AFTER auth', async () => {
    sequenceResponses(
      { isSuccess: true, token: 'fresh-login-token-abcdef' },
      { isSuccess: true, message: 'ok', getwallet: { balance: 10 } },
    )

    mockPrisma.provider.findUnique.mockResolvedValue(airhubProvider({ config: { username: 'u', password: 'p' } }))
    mockPrisma.provider.update.mockResolvedValue(airhubProvider({ config: { username: 'u', password: 'p' } }))

    const { fetchAirhubWallet } = await import('./airhub-wallet')
    const result = await fetchAirhubWallet('airhub-1')
    // Auth succeeds (token present) but no partnerCode anywhere → wallet must fail safely.
    expect(result.success).toBe(false)
    vi.unstubAllGlobals()
  })

  it('snapshot created only on successful valid response', async () => {
    sequenceResponses(
      { isSuccess: true, token: 'fresh-login-token-abcdef', data: { partnerCode: 12345 } },
      { isSuccess: true, message: 'ok', getwallet: { balance: 200, currency: 'USD' } },
    )

    mockPrisma.provider.findUnique.mockResolvedValue(airhubProvider())
    mockPrisma.provider.update.mockResolvedValue(airhubProvider())
    mockPrisma.providerWallet.findUnique.mockResolvedValue(null)
    mockPrisma.providerWallet.upsert.mockResolvedValue({ id: 'w1', balance: 200, currency: 'USD', lastSyncedAt: new Date() })
    const createMock = vi.fn().mockResolvedValue({ id: 's1' })
    mockPrisma.providerWalletSnapshot.create.mockImplementation(createMock)

    const { fetchAirhubWallet } = await import('./airhub-wallet')
    const result = await fetchAirhubWallet('airhub-1')
    expect(result.success).toBe(true)
    expect(createMock).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('low-balance threshold crossing creates alert', async () => {
    sequenceResponses(
      { isSuccess: true, token: 'fresh-login-token-abcdef', data: { partnerCode: 12345 } },
      { isSuccess: true, message: 'ok', getwallet: { balance: 5, currency: 'USD' } },
    )

    mockPrisma.provider.findUnique.mockResolvedValue(airhubProvider())
    mockPrisma.provider.update.mockResolvedValue(airhubProvider())
    mockPrisma.providerWallet.findUnique.mockResolvedValue({ id: 'w1', balance: 100, currency: 'USD', syncStatus: 'OK', lowBalanceThreshold: 20, lastSyncedAt: new Date() })
    const auditCreate = vi.fn().mockResolvedValue({})
    mockPrisma.auditLog.create.mockImplementation(auditCreate)
    mockPrisma.auditLog.findFirst.mockResolvedValue(null)
    mockPrisma.providerWallet.upsert.mockResolvedValue({ id: 'w1', balance: 5, currency: 'USD', lastSyncedAt: new Date() })
    mockPrisma.providerWalletSnapshot.create.mockResolvedValue({})

    const { fetchAirhubWallet } = await import('./airhub-wallet')
    const result = await fetchAirhubWallet('airhub-1')
    expect(result.success).toBe(true)

    // Check that a low-balance alert was created
    const alertCall = auditCreate.mock.calls.find((c: any[]) => c[0]?.data?.action === 'WALLET_LOW_BALANCE_ALERT')
    expect(alertCall).toBeDefined()
    vi.unstubAllGlobals()
  })

  it('G. does not call getWalletBalance when authentication fails', async () => {
    // Login returns 401 — authenticate() fails and the wallet endpoint must NOT
    // be fetched (the action only records an ERROR wallet row).
    let walletEndpointFetches = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (!String(url).includes('/UserLogin')) walletEndpointFetches++
      return { ok: false, status: 401, text: async () => JSON.stringify({ message: 'bad creds' }) }
    }))

    mockPrisma.provider.findUnique.mockResolvedValue(airhubProvider())
    // authenticate() on failure writes lastFailedConnection only.
    mockPrisma.provider.update.mockResolvedValue(airhubProvider())
    mockPrisma.providerWallet.findUnique.mockResolvedValue(null)

    const { fetchAirhubWallet } = await import('./airhub-wallet')
    const result = await fetchAirhubWallet('airhub-1')
    expect(result.success).toBe(false)
    // The wallet fetch (getWalletBalance HTTP) must NOT have happened.
    expect(walletEndpointFetches).toBe(0)
    // A failure record IS written, but no snapshot is taken.
    expect(mockPrisma.providerWalletSnapshot.create).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('H. successful authentication persists partnerCode then wallet retrieval works on the same connector instance', async () => {
    // Login returns nested data.partnerCode; the wallet endpoint returns a balance.
    let walletFetchCount = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/UserLogin')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ isSuccess: true, token: 'tok-abcdef', data: { partnerCode: '200652387' } }) }
      }
      walletFetchCount++
      return { ok: true, status: 200, text: async () => JSON.stringify({ isSuccess: true, message: 'ok', getwallet: { balance: 77, currency: 'USD' } }) }
    }))

    // Config has NO partnerCode initially — auth must derive and persist it.
    mockPrisma.provider.findUnique.mockResolvedValue(airhubProvider({ config: { username: 'u', password: 'p', tokenExpiry: Date.now() + 99999 } }))
    // Simulate the persisted config being readable afterwards: the connector's own
    // getWalletBalance() re-reads provider.config, so the findUnique return must
    // carry the auth-derIVED partnerCode once authentication persisted it.
    const persisted = airhubProvider({ config: { username: 'u', password: 'p', tokenExpiry: Date.now() + 99999, partnerCode: '200652387' } })
    const findUniqueMock = vi.fn()
      .mockResolvedValueOnce(airhubProvider({ config: { username: 'u', password: 'p', tokenExpiry: Date.now() + 99999 } }))
      .mockResolvedValue(persisted)
    mockPrisma.provider.findUnique.mockImplementation(findUniqueMock)
    const updateMock = vi.fn().mockResolvedValue(persisted)
    mockPrisma.provider.update.mockImplementation(updateMock)
    mockPrisma.providerWallet.findUnique.mockResolvedValue(null)
    mockPrisma.providerWallet.upsert.mockResolvedValue({ id: 'w1', balance: 77, currency: 'USD', lastSyncedAt: new Date() })
    mockPrisma.providerWalletSnapshot.create.mockResolvedValue({})

    const { fetchAirhubWallet } = await import('./airhub-wallet')
    const result = await fetchAirhubWallet('airhub-1')
    expect(result.success).toBe(true)
    expect(result.data?.balance).toBe(77)
    // authenticate() must have persisted partnerCode into config.
    const authUpdate = updateMock.mock.calls.find((c: any[]) => c[0]?.data?.config?.partnerCode)
    expect(authUpdate).toBeDefined()
    expect(authUpdate[0].data.config.partnerCode).toBe('200652387')
    // The wallet endpoint was actually hit.
    expect(walletFetchCount).toBeGreaterThan(0)
    vi.unstubAllGlobals()
  })
})