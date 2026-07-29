import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: { findUnique: vi.fn(), findFirst: vi.fn() },
    providerWallet: { upsert: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    providerWalletSnapshot: { create: vi.fn(), findMany: vi.fn() },
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

describe('Airhub Wallet', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('getWalletBalance returns balance on success', async () => {
    // Override global fetch
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ balance: 150.50, currency: 'USD', availableBalance: 500 }),
    })
    vi.stubGlobal('fetch', mockFetch)

    ;(prisma.provider.findUnique as any).mockResolvedValue({
      id: 'airhub-prov',
      code: 'AIRHUB',
      config: { username: 'test', password: 'test', partnerCode: 12345, tokenExpiry: Date.now() + 99999 },
      apiToken: 'enc_token',
      tokenPlacement: 'BEARER_HEADER',
    })

    const { fetchAirhubWallet } = await import('@/lib/actions/airhub-wallet')
    ;(prisma.providerWallet.upsert as any).mockResolvedValue({ id: 'w1', balance: 150.5, currency: 'USD', lastSyncedAt: new Date() })
    ;(prisma.providerWalletSnapshot.create as any).mockResolvedValue({ id: 's1' })

    const result = await fetchAirhubWallet('airhub-prov')
    expect(result.success).toBe(true)
    expect(result.data?.balance).toBe(150.50)
    expect(result.data?.currency).toBe('USD')

    vi.unstubAllGlobals()
  })

  it('getWalletBalance returns error on HTTP failure', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: 'Invalid token' }),
    })
    vi.stubGlobal('fetch', mockFetch)

    ;(prisma.provider.findUnique as any).mockResolvedValue({
      id: 'airhub-prov',
      code: 'AIRHUB',
      config: { username: 'test', password: 'test', partnerCode: 12345, tokenExpiry: Date.now() + 99999 },
      apiToken: 'enc_token',
      tokenPlacement: 'BEARER_HEADER',
    })
    ;(prisma.providerWallet.upsert as any).mockResolvedValue({})

    const { fetchAirhubWallet } = await import('@/lib/actions/airhub-wallet')
    const result = await fetchAirhubWallet('airhub-prov')
    expect(result.success).toBe(false)

    vi.unstubAllGlobals()
  })

  it('getWalletBalance returns error when no partnerCode configured', async () => {
    ;(prisma.provider.findUnique as any).mockResolvedValue({
      id: 'airhub-prov',
      code: 'AIRHUB',
      config: { username: 'test', password: 'test' },
      apiToken: 'enc_token',
      tokenPlacement: 'BEARER_HEADER',
    })

    const { fetchAirhubWallet } = await import('@/lib/actions/airhub-wallet')
    const result = await fetchAirhubWallet('airhub-prov')
    expect(result.success).toBe(false)
    expect(result.code).toBe('NO_PARTNER_CODE')
  })
})
