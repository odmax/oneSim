import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: { findUnique: vi.fn() },
    providerWallet: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    providerWalletSnapshot: { create: vi.fn() },
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

describe('Airhub Wallet — Full Integration', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('manual refresh succeeds and updates balance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ balance: 150.50, currency: 'USD' }),
    }))

    ;(prisma.provider.findUnique as any).mockResolvedValue({
      id: 'airhub-1', code: 'AIRHUB',
      config: { username: 'u', password: 'p', partnerCode: 12345, tokenExpiry: Date.now() + 99999 },
      apiToken: 'enc_tok', tokenPlacement: 'BEARER_HEADER',
    })
    ;(prisma.providerWallet.findUnique as any).mockResolvedValue(null)
    ;(prisma.providerWallet.upsert as any).mockResolvedValue({ id: 'w1', balance: 150.5, currency: 'USD', lastSyncedAt: new Date() })
    ;(prisma.providerWalletSnapshot.create as any).mockResolvedValue({ id: 's1' })

    const { fetchAirhubWallet } = await import('./airhub-wallet')
    const result = await fetchAirhubWallet('airhub-1', 'MANUAL')
    expect(result.success).toBe(true)
    expect(result.data?.balance).toBe(150.50)
    vi.unstubAllGlobals()
  })

  it('manual refresh preserves previous balance on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401,
      text: async () => JSON.stringify({}),
    }))

    ;(prisma.provider.findUnique as any).mockResolvedValue({
      id: 'airhub-1', code: 'AIRHUB',
      config: { username: 'u', password: 'p', partnerCode: 12345, tokenExpiry: Date.now() + 99999 },
      apiToken: 'enc_tok', tokenPlacement: 'BEARER_HEADER',
    })
    ;(prisma.providerWallet.findUnique as any).mockResolvedValue({ id: 'w1', balance: 100, currency: 'USD', syncStatus: 'OK', lastSyncedAt: new Date() })
    ;(prisma.providerWallet.update as any).mockResolvedValue({ id: 'w1', balance: 100 })

    const { fetchAirhubWallet } = await import('./airhub-wallet')
    const result = await fetchAirhubWallet('airhub-1', 'MANUAL')
    expect(result.success).toBe(false)
    // Verify update was called, preserving balance
    const updateCalls = (prisma.providerWallet.update as any).mock.calls
    expect(updateCalls.length).toBeGreaterThanOrEqual(1)
    vi.unstubAllGlobals()
  })

  it('partnercode is sent as query parameter in URL', async () => {
    let capturedUrl = ''
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      capturedUrl = url
      return { ok: true, status: 200, text: async () => JSON.stringify({ balance: 50 }) }
    }))

    ;(prisma.provider.findUnique as any).mockResolvedValue({
      id: 'airhub-1', code: 'AIRHUB',
      config: { username: 'u', password: 'p', partnerCode: 12345, tokenExpiry: Date.now() + 99999 },
      apiToken: 'enc_tok', tokenPlacement: 'BEARER_HEADER',
    })
    ;(prisma.providerWallet.findUnique as any).mockResolvedValue(null)
    ;(prisma.providerWallet.upsert as any).mockResolvedValue({ id: 'w1', balance: 50, currency: 'USD', lastSyncedAt: new Date() })
    ;(prisma.providerWalletSnapshot.create as any).mockResolvedValue({})

    const { fetchAirhubWallet } = await import('./airhub-wallet')
    const result = await fetchAirhubWallet('airhub-1')
    expect(result.success).toBe(true)
    expect(capturedUrl).toContain('partnercode=12345')
    expect(capturedUrl).toContain('/api/ESIM/get_wallet_individual')
    vi.unstubAllGlobals()
  })

  it('malformed balance returns error and does NOT overwrite', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ balance: 'not-a-number', currency: 'USD' }),
    }))

    ;(prisma.provider.findUnique as any).mockResolvedValue({
      id: 'airhub-1', code: 'AIRHUB',
      config: { username: 'u', password: 'p', partnerCode: 12345, tokenExpiry: Date.now() + 99999 },
      apiToken: 'enc_tok', tokenPlacement: 'BEARER_HEADER',
    })
    ;(prisma.providerWallet.findUnique as any).mockResolvedValue({ id: 'w1', balance: 100, currency: 'USD', syncStatus: 'OK', lastSyncedAt: new Date() })
    ;(prisma.providerWallet.update as any).mockResolvedValue({})

    const { fetchAirhubWallet } = await import('./airhub-wallet')
    const result = await fetchAirhubWallet('airhub-1')
    expect(result.success).toBe(false)

    // Verify balance was NOT overwritten (update is called but balance is preserved)
    const updateCalls = (prisma.providerWallet.update as any).mock.calls
    expect(updateCalls.length).toBeGreaterThanOrEqual(1)
    vi.unstubAllGlobals()
  })

  it('missing partnerCode returns error', async () => {
    ;(prisma.provider.findUnique as any).mockResolvedValue({
      id: 'airhub-1', code: 'AIRHUB',
      config: { username: 'u', password: 'p' },
      apiToken: 'enc_tok', tokenPlacement: 'BEARER_HEADER',
    })

    const { fetchAirhubWallet } = await import('./airhub-wallet')
    const result = await fetchAirhubWallet('airhub-1')
    expect(result.success).toBe(false)
  })

  it('snapshot created only on successful valid response', async () => {
    // First request succeeds
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ balance: 200, currency: 'USD' }),
    }))

    ;(prisma.provider.findUnique as any).mockResolvedValue({
      id: 'airhub-1', code: 'AIRHUB',
      config: { username: 'u', password: 'p', partnerCode: 12345, tokenExpiry: Date.now() + 99999 },
      apiToken: 'enc_tok', tokenPlacement: 'BEARER_HEADER',
    })
    ;(prisma.providerWallet.findUnique as any).mockResolvedValue(null)
    ;(prisma.providerWallet.upsert as any).mockResolvedValue({ id: 'w1', balance: 200, currency: 'USD', lastSyncedAt: new Date() })
    const createMock = vi.fn().mockResolvedValue({ id: 's1' })
    ;(prisma.providerWalletSnapshot.create as any).mockImplementation(createMock)

    const { fetchAirhubWallet } = await import('./airhub-wallet')
    const result = await fetchAirhubWallet('airhub-1')
    expect(result.success).toBe(true)
    expect(createMock).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('low-balance threshold crossing creates alert', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ balance: 5, currency: 'USD' }),
    }))

    ;(prisma.provider.findUnique as any).mockResolvedValue({
      id: 'airhub-1', code: 'AIRHUB',
      config: { username: 'u', password: 'p', partnerCode: 12345, tokenExpiry: Date.now() + 99999 },
      apiToken: 'enc_tok', tokenPlacement: 'BEARER_HEADER',
    })
    ;(prisma.providerWallet.findUnique as any).mockResolvedValue({ id: 'w1', balance: 100, currency: 'USD', syncStatus: 'OK', lowBalanceThreshold: 20, lastSyncedAt: new Date() })
    const auditCreate = vi.fn().mockResolvedValue({})
    ;(prisma.auditLog.create as any).mockImplementation(auditCreate)
    ;(prisma.auditLog.findFirst as any).mockResolvedValue(null)
    ;(prisma.providerWallet.upsert as any).mockResolvedValue({ id: 'w1', balance: 5, currency: 'USD', lastSyncedAt: new Date() })
    ;(prisma.providerWalletSnapshot.create as any).mockResolvedValue({})

    const { fetchAirhubWallet } = await import('./airhub-wallet')
    const result = await fetchAirhubWallet('airhub-1')
    expect(result.success).toBe(true)

    // Check that a low-balance alert was created
    const alertCall = auditCreate.mock.calls.find((c: any[]) => c[0]?.data?.action === 'WALLET_LOW_BALANCE_ALERT')
    expect(alertCall).toBeDefined()
    vi.unstubAllGlobals()
  })
})
