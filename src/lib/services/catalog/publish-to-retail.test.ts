import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFindUniqueProviderPackage, mockFindUniqueRetail, mockFindFirst, mockCreate, mockUpdate, mockTransaction } = vi.hoisted(() => ({
  mockFindUniqueProviderPackage: vi.fn(),
  mockFindUniqueRetail: vi.fn(),
  mockFindFirst: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockTransaction: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    providerPackage: { findUnique: mockFindUniqueProviderPackage, update: mockUpdate },
    eSIMPackage: { findFirst: mockFindFirst, create: mockCreate, findUnique: mockFindUniqueRetail },
    packagePriceSnapshot: { findUnique: vi.fn().mockResolvedValue({ id: 'snap-1', status: 'ACTIVE' }) },
    packageConfigurationRule: { findFirst: vi.fn().mockResolvedValue(null) },
    exchangeRate: { findFirst: vi.fn().mockResolvedValue(null) },
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

import { publishProviderPackageToRetailCatalog } from './publish-to-retail'

function makeProviderPackage(overrides: Record<string, any> = {}) {
  return {
    id: 'pp-1',
    providerPlanId: 'plan-1',
    providerId: 'prov-1',
    name: 'Test South Africa-20',
    dataGB: 20,
    validityDays: 30,
    country: 'ZA',
    costPrice: { toString: () => '7.00' },
    currency: 'USD',
    sellingPrice: { toString: () => '7.69' },
    sellingCurrency: 'USD',
    markupPercent: { toString: () => '9.86' },
    configurationStatus: 'CONFIGURED',
    publishStatus: 'READY',
    costStatus: 'VALID',
    pricingStatus: 'READY',
    activePriceSnapshotId: 'snap-1',
    provider: { id: 'prov-1', name: 'US-Matrix', code: 'USMATRIX', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'] },
    ...overrides,
  } as any
}

function makeRetail(overrides: Record<string, any> = {}) {
  return {
    id: 'retail-1',
    isActive: true,
    hiddenFromCatalog: false,
    archivedAt: null,
    source: 'CATALOG_PRODUCT',
    providerPackageId: 'pp-1',
    providerPackage: {
      costStatus: 'VALID',
      pricingStatus: 'READY',
      publishStatus: 'PUBLISHED',
      configurationStatus: 'CONFIGURED',
      activePriceSnapshotId: 'snap-1',
      sellingPrice: { toString: () => '7.69' },
      costPrice: { toString: () => '7.00' },
    },
    provider: { status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'USMATRIX' },
    ...overrides,
  } as any
}

describe('publishProviderPackageToRetailCatalog — canonical flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindUniqueProviderPackage.mockReset()
    mockFindUniqueRetail.mockReset()
    mockFindFirst.mockReset()
    mockCreate.mockReset()
    mockUpdate.mockReset()
    mockTransaction.mockReset()
    // recalculatePackagePrice calls providerPackage.update(...).catch(...)
    // for the RECALCULATING marker before the transaction — keep it always usable.
    mockUpdate.mockResolvedValue({})
  })

  it('first-time publish: READY + CONFIGURED with no existing retail → creates retail, sets PUBLISHED, strict readiness passes', async () => {
    // Step 1 load (with provider)
    mockFindUniqueProviderPackage.mockResolvedValue(makeProviderPackage())
    // Finalizer internals: recalc findUnique (pp) + verified re-read
    mockFindUniqueProviderPackage
      .mockResolvedValueOnce(makeProviderPackage())
      .mockResolvedValueOnce(makeProviderPackage({ costStatus: 'VALID', pricingStatus: 'READY', activePriceSnapshotId: 'snap-1' }))
    // eSIMPackage.findFirst inside transaction → null (no existing retail)
    mockFindFirst.mockResolvedValue(null)
    mockCreate.mockResolvedValue({ id: 'retail-1' })
    mockTransaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: { update: mockUpdate },
        eSIMPackage: { findFirst: mockFindFirst, create: mockCreate, update: vi.fn(), findUnique: vi.fn().mockResolvedValue(null) },
        packagePriceSnapshot: { create: mockCreate },
      }
      mockUpdate.mockResolvedValue({})
      await cb(tx)
    })
    // Strict post-publish retail re-read (publishStatus now PUBLISHED)
    mockFindUniqueRetail.mockResolvedValue(makeRetail())

    const result = await publishProviderPackageToRetailCatalog('pp-1', { reason: 'PUBLISH' })

    expect(result.success).toBe(true)
    expect(result.created).toBe(true)
    expect(result.updated).toBe(false)
    expect(result.publishStatusSet).toBe(true)
    expect(result.ready).toBe(true)
    expect(result.readinessReasons).toEqual([])
    // PUBLISHED was written inside the transaction alongside retail create.
    const txUpdateCalls = mockUpdate.mock.calls.filter(c => c[0]?.data?.publishStatus === 'PUBLISHED')
    expect(txUpdateCalls.length).toBeGreaterThan(0)
    // Retail created exactly once (snapshot create in recalc is separate).
    const retailCreates = mockCreate.mock.calls.filter(c => c[0]?.data?.source === 'CATALOG_PRODUCT')
    expect(retailCreates).toHaveLength(1)
  })

  it('existing retail → updates retail, re-publishes, sets PUBLISHED, strict readiness passes', async () => {
    mockFindUniqueProviderPackage.mockResolvedValue(makeProviderPackage())
    mockFindUniqueProviderPackage
      .mockResolvedValueOnce(makeProviderPackage())
      .mockResolvedValueOnce(makeProviderPackage({ costStatus: 'VALID', pricingStatus: 'READY', activePriceSnapshotId: 'snap-1' }))
    mockFindFirst.mockResolvedValue({ id: 'retail-1' })
    mockCreate.mockResolvedValue({ id: 'retail-1' })
    mockTransaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: { update: mockUpdate },
        eSIMPackage: { findFirst: mockFindFirst, create: mockCreate, update: vi.fn().mockResolvedValue({ id: 'retail-1' }), findUnique: vi.fn().mockResolvedValue(null) },
        packagePriceSnapshot: { create: mockCreate },
      }
      mockUpdate.mockResolvedValue({})
      await cb(tx)
    })
    mockFindUniqueRetail.mockResolvedValue(makeRetail())

    const result = await publishProviderPackageToRetailCatalog('pp-1', { reason: 'PUBLISH' })

    expect(result.success).toBe(true)
    expect(result.created).toBe(false)
    expect(result.updated).toBe(true)
    expect(result.publishStatusSet).toBe(true)
  })

  it('finalizer fails (UNCONFIGURED + DRAFT) → FINALIZATION_FAILED with exact reasons, no retail, no PUBLISHED', async () => {
    mockFindUniqueProviderPackage.mockResolvedValue(makeProviderPackage({ publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED' }))
    // Finalizer recalc still succeeds (recalc doesn't require eligibility), verified re-read keeps UNCONFIGURED
    mockFindUniqueProviderPackage
      .mockResolvedValueOnce(makeProviderPackage({ publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED' }))
      .mockResolvedValueOnce(makeProviderPackage({ publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED', costStatus: 'VALID', pricingStatus: 'READY', activePriceSnapshotId: 'snap-1' }))

    const result = await publishProviderPackageToRetailCatalog('pp-1', { reason: 'PUBLISH' })

    expect(result.success).toBe(false)
    expect(result.failedStage).toBe('FINALIZATION_FAILED')
    expect(result.readinessReasons.some((r: string) => r.includes('not eligible for publication'))).toBe(true)
    expect(result.publishStatusSet).toBe(false)
    expect(mockFindFirst).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('HIDDEN package → finalizer blocks in PRE_PUBLISH mode (never PUBLISHED)', async () => {
    mockFindUniqueProviderPackage.mockResolvedValue(makeProviderPackage({ publishStatus: 'HIDDEN', configurationStatus: 'CONFIGURED' }))
    mockFindUniqueProviderPackage
      .mockResolvedValueOnce(makeProviderPackage({ publishStatus: 'HIDDEN', configurationStatus: 'CONFIGURED' }))
      .mockResolvedValueOnce(makeProviderPackage({ publishStatus: 'HIDDEN', configurationStatus: 'CONFIGURED', costStatus: 'VALID', pricingStatus: 'READY', activePriceSnapshotId: 'snap-1' }))

    const result = await publishProviderPackageToRetailCatalog('pp-1', { reason: 'PUBLISH' })
    expect(result.success).toBe(false)
    expect(result.failedStage).toBe('FINALIZATION_FAILED')
    expect(result.publishStatusSet).toBe(false)
  })

  it('strict post-publish verification catches a non-purchasable final state (e.g. provider lacks PURCHASE)', async () => {
    mockFindUniqueProviderPackage.mockResolvedValue(makeProviderPackage())
    mockFindUniqueProviderPackage
      .mockResolvedValueOnce(makeProviderPackage())
      .mockResolvedValueOnce(makeProviderPackage({ costStatus: 'VALID', pricingStatus: 'READY', activePriceSnapshotId: 'snap-1' }))
    mockFindFirst.mockResolvedValue(null)
    mockCreate.mockResolvedValue({ id: 'retail-1' })
    mockTransaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: { update: mockUpdate },
        eSIMPackage: { findFirst: mockFindFirst, create: mockCreate, update: vi.fn(), findUnique: vi.fn().mockResolvedValue(null) },
        packagePriceSnapshot: { create: mockCreate },
      }
      mockUpdate.mockResolvedValue({})
      await cb(tx)
    })
    // Strict re-read: provider has no PURCHASE capability.
    mockFindUniqueRetail.mockResolvedValue(makeRetail({ provider: { status: 'ACTIVE', enabledCapabilities: ['STATUS'], code: 'USMATRIX' } }))

    const result = await publishProviderPackageToRetailCatalog('pp-1', { reason: 'PUBLISH' })
    expect(result.success).toBe(false)
    expect(result.failedStage).toBe('RETAIL_READINESS_FAILED')
    expect(result.readinessReasons.some((r: string) => r.includes('PURCHASE'))).toBe(true)
  })
})
