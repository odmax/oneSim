import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    providerPackage: {
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(),
    },
    providerPackageFee: {
      deleteMany: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({}),
    },
    providerCostSnapshot: {
      create: vi.fn().mockResolvedValue({ id: 'snap-1' }),
    },
  },
}))

import { prisma } from '@/lib/prisma'
import {
  normalizeProviderCost,
  validateProviderCost,
  persistProviderCost,
  resolveEffectiveCost,
  isPackagePurchasable,
  triggerPricingRecalculation,
  setPricingReady,
  checkCostFreshness,
} from './provider-cost-normalization'
import type { NormalizedProviderCost } from './provider-cost-normalization'

describe('normalizeProviderCost', () => {
  it('auto-normalizes direct cost (backward compatibility)', () => {
    const result = normalizeProviderCost({ amount: 1.60, currency: 'USD' })
    expect(result.source).toBe('PROVIDER_COST')
    expect(result.amount).toBe(1.60)
    expect(result.originalAmount).toBe(1.60)
    expect(result.isTaxInclusive).toBe(false)
  })

  it('derives cost from RETAIL_MINUS_COMMISSION', () => {
    const result = normalizeProviderCost({
      amount: 0,
      source: 'PROVIDER_COST',
      derivedFrom: { method: 'RETAIL_MINUS_COMMISSION', retailPrice: 10, commissionAmount: 3 },
    })
    expect(result.amount).toBe(7)
    expect(result.source).toBe('DERIVED_FROM_COMMISSION')
  })

  it('derives cost from RETAIL_MINUS_COMMISSION_PERCENT', () => {
    const result = normalizeProviderCost({
      amount: 0,
      derivedFrom: { method: 'RETAIL_MINUS_COMMISSION_PERCENT', retailPrice: 100, commissionPercent: 20 },
    })
    expect(result.amount).toBe(80)
  })

  it('derives cost from RETAIL_DISCOUNT_PERCENT', () => {
    const result = normalizeProviderCost({
      amount: 0,
      derivedFrom: { method: 'RETAIL_DISCOUNT_PERCENT', retailPrice: 100, discountPercent: 15 },
    })
    expect(result.amount).toBe(85)
  })

  it('wholesale source is preserved', () => {
    const result = normalizeProviderCost({ amount: 50, source: 'PROVIDER_WHOLESALE' })
    expect(result.source).toBe('PROVIDER_WHOLESALE')
  })
})

describe('validateProviderCost', () => {
  it('accepts valid cost', () => {
    const result = validateProviderCost(makeCost())
    expect(result.valid).toBe(true)
  })

  it('rejects negative amount', () => {
    const result = validateProviderCost(makeCost({ amount: -5 }))
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('amount cannot be negative')
  })

  it('rejects NaN', () => {
    const result = validateProviderCost(makeCost({ amount: NaN }))
    expect(result.valid).toBe(false)
  })

  it('rejects invalid currency', () => {
    const result = validateProviderCost(makeCost({ currency: 'US' as any }))
    expect(result.valid).toBe(false)
  })

  it('rejects negative fee amounts', () => {
    const result = validateProviderCost(makeCost({ fees: [{ type: 'ACTIVATION', amount: -5, currency: 'USD', chargeTiming: 'AT_PURCHASE' }] }))
    expect(result.valid).toBe(false)
  })
})

describe('persistProviderCost', () => {
  beforeEach(() => vi.clearAllMocks())

  it('marks valid cost as VALID and creates snapshot', async () => {
    ;(prisma.providerCostSnapshot.create as any).mockResolvedValue({ id: 'snap-1' })

    const result = await persistProviderCost('pkg-1', makeCost())
    expect(result.costStatus).toBe('VALID')
    expect(result.snapshotId).toBe('snap-1')

    const updateCall = (prisma.providerPackage.update as any).mock.calls[0]
    expect(updateCall[0].data.costStatus).toBe('VALID')
    expect(updateCall[0].data.pricingStatus).toBe('READY')
  })

  it('marks zero cost as MISSING', async () => {
    ;(prisma.providerCostSnapshot.create as any).mockResolvedValue({ id: 'snap-2' })

    const result = await persistProviderCost('pkg-1', makeCost({ amount: 0 }))
    expect(result.costStatus).toBe('MISSING')
    const updateCall = (prisma.providerPackage.update as any).mock.calls[0]
    expect(updateCall[0].data.pricingStatus).toBe('COST_UNAVAILABLE')
  })

  it('persists fees separately', async () => {
    ;(prisma.providerCostSnapshot.create as any).mockResolvedValue({ id: 'snap-3' })

    await persistProviderCost('pkg-1', makeCost({
      fees: [
        { type: 'ACTIVATION', amount: 2, currency: 'USD', chargeTiming: 'AT_PURCHASE' },
        { type: 'RECURRING', amount: 5, currency: 'USD', chargeTiming: 'MONTHLY' },
      ],
    }))

    expect(prisma.providerPackageFee.deleteMany).toHaveBeenCalled()
    expect(prisma.providerPackageFee.createMany).toHaveBeenCalled()
  })

  it('marks invalid cost without snapshot', async () => {
    const result = await persistProviderCost('pkg-1', makeCost({ amount: NaN }))
    expect(result.costStatus).toBe('INVALID')
    expect(result.snapshotId).toBeUndefined()
    expect(prisma.providerCostSnapshot.create).not.toHaveBeenCalled()
  })
})

describe('resolveEffectiveCost', () => {
  beforeEach(() => vi.clearAllMocks())

  it('admin override wins (priority 1)', async () => {
    ;(prisma.providerPackage.findUnique as any).mockResolvedValue({
      adminCostPrice: { toString: () => '5.00' },
      costPrice: { toString: () => '1.60' },
      costStatus: 'VALID',
      currency: 'USD',
    })
    const result = await resolveEffectiveCost('pkg-1')
    expect(result.source).toBe('ADMIN_OVERRIDE')
    expect(result.amount).toBe(5)
  })

  it('returns PROVIDER for valid cost', async () => {
    ;(prisma.providerPackage.findUnique as any).mockResolvedValue({
      adminCostPrice: null,
      costPrice: { toString: () => '1.60' },
      costStatus: 'VALID',
      currency: 'USD',
    })
    const result = await resolveEffectiveCost('pkg-1')
    expect(result.source).toBe('PROVIDER')
    expect(result.amount).toBe(1.60)
  })

  it('returns VERIFIED_FALLBACK for stale cost within freshness', async () => {
    ;(prisma.providerPackage.findUnique as any).mockResolvedValue({
      adminCostPrice: null,
      costPrice: { toString: () => '1.60' },
      costStatus: 'STALE',
      currency: 'USD',
      costReceivedAt: new Date(Date.now() - 7 * 86400000), // 7 days ago
    })
    const result = await resolveEffectiveCost('pkg-1')
    expect(result.source).toBe('VERIFIED_FALLBACK')
    expect(result.amount).toBe(1.60)
  })

  it('returns MISSING for stale cost beyond freshness', async () => {
    ;(prisma.providerPackage.findUnique as any).mockResolvedValue({
      adminCostPrice: null,
      costPrice: { toString: () => '1.60' },
      costStatus: 'STALE',
      currency: 'USD',
      costReceivedAt: new Date(Date.now() - 120 * 86400000), // 120 days ago
    })
    const result = await resolveEffectiveCost('pkg-1')
    expect(result.source).toBe('MISSING')
  })

  it('returns MISSING for MISSING cost status', async () => {
    ;(prisma.providerPackage.findUnique as any).mockResolvedValue({
      adminCostPrice: null,
      costPrice: { toString: () => '0' },
      costStatus: 'MISSING',
      currency: 'USD',
    })
    const result = await resolveEffectiveCost('pkg-1')
    expect(result.source).toBe('MISSING')
  })

  it('returns DERIVED for configured derivation', async () => {
    ;(prisma.providerPackage.findUnique as any).mockResolvedValue({
      adminCostPrice: null,
      costPrice: { toString: () => '0' },
      costStatus: 'MISSING',
      currency: 'USD',
      costDerivationMethod: 'RETAIL_MINUS_COMMISSION',
      costDerivationConfig: { method: 'RETAIL_MINUS_COMMISSION', retailPrice: 10, commissionAmount: 3 },
    })
    const result = await resolveEffectiveCost('pkg-1')
    expect(result.source).toBe('DERIVED')
    expect(result.amount).toBe(7)
  })
})

describe('isPackagePurchasable', () => {
  it('allows VALID cost', () => expect(isPackagePurchasable('VALID', false)).toBe(true))
  it('allows admin override', () => expect(isPackagePurchasable('MISSING', true)).toBe(true))
  it('rejects MISSING', () => expect(isPackagePurchasable('MISSING', false)).toBe(false))
  it('rejects INVALID', () => expect(isPackagePurchasable('INVALID', false)).toBe(false))
  it('rejects null cost status', () => expect(isPackagePurchasable(null, false)).toBe(false))
})

function makeCost(overrides: Partial<NormalizedProviderCost> = {}): NormalizedProviderCost {
  return {
    amount: 1.60, currency: 'USD',
    source: 'PROVIDER_COST',
    originalAmount: 1.60, originalCurrency: 'USD',
    isTaxInclusive: false,
    receivedAt: new Date(),
    ...overrides,
  }
}

describe('triggerPricingRecalculation', () => {
  it('sets pricingStatus to REQUIRES_RECALCULATION', async () => {
    const updateMock = vi.mocked(prisma.providerPackage.update)
    await triggerPricingRecalculation('pkg-1')
    expect(updateMock).toHaveBeenCalledWith({ where: { id: 'pkg-1' }, data: { pricingStatus: 'REQUIRES_RECALCULATION' } })
  })
})

describe('setPricingReady', () => {
  it('sets READY when cost is VALID and sellingPrice > 0', async () => {
    ;(prisma.providerPackage.findUnique as any).mockResolvedValue({ costStatus: 'VALID', sellingPrice: { toString: () => '5' } })
    const updateMock = vi.mocked(prisma.providerPackage.update)
    await setPricingReady('pkg-1', null)
    expect(updateMock).toHaveBeenCalledWith({ where: { id: 'pkg-1' }, data: { pricingStatus: 'READY' } })
  })

  it('sets COST_UNAVAILABLE when cost is MISSING', async () => {
    ;(prisma.providerPackage.findUnique as any).mockResolvedValue({ costStatus: 'MISSING', sellingPrice: { toString: () => '5' } })
    const updateMock = vi.mocked(prisma.providerPackage.update)
    await setPricingReady('pkg-1', null)
    expect(updateMock).toHaveBeenCalledWith({ where: { id: 'pkg-1' }, data: { pricingStatus: 'COST_UNAVAILABLE' } })
  })
})

describe('checkCostFreshness', () => {
  it('returns true for fresh VALID cost', async () => {
    ;(prisma.providerPackage.findUnique as any).mockResolvedValue({
      costStatus: 'VALID', costReceivedAt: new Date(), costExpiresAt: null,
    })
    const result = await checkCostFreshness('pkg-1')
    expect(result).toBe(true)
  })

  it('returns false and marks STALE for expired cost', async () => {
    ;(prisma.providerPackage.findUnique as any).mockResolvedValue({
      costStatus: 'VALID', costReceivedAt: new Date(Date.now() - 200 * 86400000), costExpiresAt: null,
    })
    const updateMock = vi.mocked(prisma.providerPackage.update)
    const result = await checkCostFreshness('pkg-1')
    expect(result).toBe(false)
    expect(updateMock).toHaveBeenCalledWith({ where: { id: 'pkg-1' }, data: { costStatus: 'STALE', pricingStatus: 'REQUIRES_RECALCULATION' } })
  })

  it('returns true for OVERRIDDEN regardless of age', async () => {
    ;(prisma.providerPackage.findUnique as any).mockResolvedValue({
      costStatus: 'OVERRIDDEN', costReceivedAt: new Date(Date.now() - 500 * 86400000), costExpiresAt: null,
    })
    const result = await checkCostFreshness('pkg-1')
    expect(result).toBe(true)
  })
})
