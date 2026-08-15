import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFindUnique, mockUpdate, mockCreate, mockFindFirst, mockTransaction } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn().mockResolvedValue({}),
  mockCreate: vi.fn(),
  mockFindFirst: vi.fn(),
  mockTransaction: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    providerPackage: { findUnique: mockFindUnique, update: mockUpdate },
    packagePriceSnapshot: { create: mockCreate, findUnique: vi.fn() },
    exchangeRate: { findFirst: mockFindFirst },
    packageConfigurationRule: { findFirst: mockFindFirst },
    $transaction: mockTransaction,
  },
}))

vi.mock('@/lib/currency/exchange-rate-service', () => ({
  convertCurrency: vi.fn(async (amount: number) => ({ amount, currency: 'USD' })),
  getExchangeRate: vi.fn(),
}))

vi.mock('@/lib/currency/currency-config', () => ({
  getPlatformBaseCurrency: () => 'USD',
  PRICING_ENGINE_VERSION: '3.0.0',
}))

vi.mock('@/lib/currency/currency-rounding', () => ({
  roundCurrencyAmount: (v: number) => Math.round(v * 100) / 100,
}))

import { finalizeCatalogPackageConfiguration } from './configuration-finalizer'

function makePkg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pp-1',
    costPrice: { toString: () => '7.00' },
    currency: 'USD',
    sellingPrice: { toString: () => '7.69' },
    sellingCurrency: 'USD',
    adminCostPrice: null,
    effectiveCostPrice: null,
    costSource: null,
    costStatus: 'MISSING',
    pricingStatus: 'COST_UNAVAILABLE',
    configurationStatus: 'CONFIGURED',
    publishStatus: 'READY',
    activePriceSnapshotId: null,
    fees: [],
    costReceivedAt: null,
    provider: { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'USMATRIX' },
    ...overrides,
  } as any
}

function setupTransaction() {
  mockTransaction.mockImplementation(async (fn: any) => {
    const tx = {
      providerPackage: { update: mockUpdate },
      packagePriceSnapshot: { create: mockCreate },
    }
    mockCreate.mockResolvedValue({ id: 'snap-1' })
    mockUpdate.mockResolvedValue({})
    await fn(tx)
  })
}

describe('finalizeCatalogPackageConfiguration — PRE_PUBLISH readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindUnique.mockReset()
    mockUpdate.mockReset()
    mockCreate.mockReset()
    mockFindFirst.mockReset()
    mockTransaction.mockReset()
    mockUpdate.mockResolvedValue({})
  })

  it('succeeds for READY + CONFIGURED package (does NOT require PUBLISHED)', async () => {
    mockFindUnique
      .mockResolvedValueOnce(makePkg()) // initial load
      .mockResolvedValueOnce(makePkg()) // recalc load
      .mockResolvedValueOnce(makePkg({ costStatus: 'VALID', pricingStatus: 'READY', activePriceSnapshotId: 'snap-1' })) // verified
      .mockResolvedValueOnce(makePkg({ costStatus: 'VALID', pricingStatus: 'READY', activePriceSnapshotId: 'snap-1' }))
    mockCreate.mockResolvedValue({ id: 'snap-1' })
    setupTransaction()
    const { prisma: p } = await import('@/lib/prisma')
    ;(p.packagePriceSnapshot.findUnique as any).mockResolvedValue({ id: 'snap-1', status: 'ACTIVE' })

    const result = await finalizeCatalogPackageConfiguration('pp-1', { reason: 'PUBLISH' })
    expect(result.success).toBe(true)
    expect(result.ready).toBe(true)
    expect(result.readinessReasons).toEqual([])
    // The finalizer must NOT set PUBLISHED.
    const publishWrites = mockUpdate.mock.calls.filter(c => c[0]?.data?.publishStatus !== undefined)
    expect(publishWrites).toHaveLength(0)
  })

  it('blocks UNCONFIGURED + DRAFT (not eligible to transition to PUBLISHED)', async () => {
    mockFindUnique
      .mockResolvedValueOnce(makePkg({ publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED' }))
      .mockResolvedValueOnce(makePkg({ publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED' }))
      .mockResolvedValueOnce(makePkg({ publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED', costStatus: 'VALID', pricingStatus: 'READY', activePriceSnapshotId: 'snap-1' }))
    mockCreate.mockResolvedValue({ id: 'snap-1' })
    setupTransaction()
    const { prisma: p } = await import('@/lib/prisma')
    ;(p.packagePriceSnapshot.findUnique as any).mockResolvedValue({ id: 'snap-1', status: 'ACTIVE' })

    const result = await finalizeCatalogPackageConfiguration('pp-1', { reason: 'PUBLISH' })
    expect(result.success).toBe(false)
    expect(result.failedStage).toBe('READINESS_FAILED')
    expect(result.readinessReasons.some((r: string) => r.includes('not eligible for publication'))).toBe(true)
  })

  it('blocks HIDDEN regardless of configuration', async () => {
    mockFindUnique
      .mockResolvedValueOnce(makePkg({ publishStatus: 'HIDDEN' }))
      .mockResolvedValueOnce(makePkg({ publishStatus: 'HIDDEN' }))
      .mockResolvedValueOnce(makePkg({ publishStatus: 'HIDDEN', costStatus: 'VALID', pricingStatus: 'READY', activePriceSnapshotId: 'snap-1' }))
    mockCreate.mockResolvedValue({ id: 'snap-1' })
    setupTransaction()
    const { prisma: p } = await import('@/lib/prisma')
    ;(p.packagePriceSnapshot.findUnique as any).mockResolvedValue({ id: 'snap-1', status: 'ACTIVE' })

    const result = await finalizeCatalogPackageConfiguration('pp-1', { reason: 'PUBLISH' })
    expect(result.success).toBe(false)
    expect(result.failedStage).toBe('READINESS_FAILED')
  })

  it('blocks ARCHIVED regardless of configuration', async () => {
    mockFindUnique
      .mockResolvedValueOnce(makePkg({ publishStatus: 'ARCHIVED' }))
      .mockResolvedValueOnce(makePkg({ publishStatus: 'ARCHIVED' }))
      .mockResolvedValueOnce(makePkg({ publishStatus: 'ARCHIVED', costStatus: 'VALID', pricingStatus: 'READY', activePriceSnapshotId: 'snap-1' }))
    mockCreate.mockResolvedValue({ id: 'snap-1' })
    setupTransaction()
    const { prisma: p } = await import('@/lib/prisma')
    ;(p.packagePriceSnapshot.findUnique as any).mockResolvedValue({ id: 'snap-1', status: 'ACTIVE' })

    const result = await finalizeCatalogPackageConfiguration('pp-1', { reason: 'PUBLISH' })
    expect(result.success).toBe(false)
    expect(result.failedStage).toBe('READINESS_FAILED')
  })
})
