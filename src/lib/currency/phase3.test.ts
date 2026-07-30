import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    exchangeRate: { findFirst: vi.fn() },
    providerPackage: { findUnique: vi.fn() },
    purchaseQuote: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'

// ── Currency Registry ──
import { isCurrencySupported, validateCurrency, getDecimalPlaces } from './currency-registry'

describe('currency-registry', () => {
  it('USD is supported', () => expect(isCurrencySupported('USD')).toBe(true))
  it('EUR is supported', () => expect(isCurrencySupported('EUR')).toBe(true))
  it('JPY has 0 decimal places', () => expect(getDecimalPlaces('JPY')).toBe(0))
  it('USD has 2 decimal places', () => expect(getDecimalPlaces('USD')).toBe(2))
  it('lowercase is normalized', () => expect(isCurrencySupported('usd')).toBe(true))
  it('unknown is rejected', () => expect(isCurrencySupported('XYZ')).toBe(false))
  it('validate returns error for unknown', () => expect(validateCurrency('XYZ').valid).toBe(false))
})

// ── Currency Config ──
import { getPlatformBaseCurrency, PRICING_ENGINE_VERSION } from './currency-config'

describe('currency-config', () => {
  it('default base currency is USD', () => expect(getPlatformBaseCurrency()).toBe('USD'))
  it('pricing engine version is set', () => expect(PRICING_ENGINE_VERSION).toBe('3.0.0'))
})

// ── Currency Rounding ──
import { roundCurrencyAmount } from './currency-rounding'

describe('currency-rounding', () => {
  it('rounds USD to 2dp', () => expect(roundCurrencyAmount(1.2345, 'USD')).toBe(1.23))
  it('rounds JPY to 0dp', () => expect(roundCurrencyAmount(1234.56, 'JPY')).toBe(1235))
  it('END_IN_99 rounding', () => expect(roundCurrencyAmount(10.50, 'USD', 'END_IN_99')).toBe(10.99))
  it('END_IN_95 rounding', () => expect(roundCurrencyAmount(10.50, 'USD', 'END_IN_95')).toBe(10.95))
  it('NEAREST_1 rounding', () => expect(roundCurrencyAmount(10.60, 'JPY', 'NEAREST_1')).toBe(11))
})

// ── Exchange Rate Service ──
import { getExchangeRate, convertCurrency, validateRate } from './exchange-rate-service'

describe('exchange-rate-service', () => {
  it('same-currency returns identity (rate 1)', async () => {
    const result = await getExchangeRate('USD', 'USD')
    expect(result!.rate).toBe(1)
    expect(result!.resolutionType).toBe('SAME_CURRENCY')
  })

  it('returns direct rate when available', async () => {
    ;(prisma.exchangeRate.findFirst as any).mockResolvedValueOnce({
      rate: { toString: () => '0.85' }, baseCurrency: 'USD', quoteCurrency: 'EUR',
      source: 'MANUAL', id: 'r1', version: 1, effectiveAt: new Date(), expiresAt: new Date(Date.now() + 99999),
    })
    const result = await getExchangeRate('USD', 'EUR')
    expect(result!.rate).toBe(0.85)
    expect(result!.resolutionType).toBe('DIRECT')
  })

  it('returns inverse rate when direct unavailable', async () => {
    ;(prisma.exchangeRate.findFirst as any)
      .mockResolvedValueOnce(null) // direct not found
      .mockResolvedValueOnce({
        rate: { toString: () => '1.176' }, baseCurrency: 'EUR', quoteCurrency: 'USD',
        source: 'MANUAL', id: 'r2', version: 1, effectiveAt: new Date(), expiresAt: new Date(Date.now() + 99999),
      })
    const result = await getExchangeRate('USD', 'EUR')
    expect(result!.rate).toBeCloseTo(1 / 1.176, 5)
    expect(result!.resolutionType).toBe('INVERSE')
  })

  it('returns null when no rate exists', async () => {
    ;(prisma.exchangeRate.findFirst as any).mockResolvedValue(null).mockResolvedValue(null)
    const result = await getExchangeRate('USD', 'XYZ')
    expect(result).toBeNull()
  })

  it('converts currency correctly', async () => {
    ;(prisma.exchangeRate.findFirst as any).mockResolvedValueOnce({
      rate: { toString: () => '0.85' }, baseCurrency: 'USD', quoteCurrency: 'EUR',
      source: 'MANUAL', id: 'r3', version: 1, effectiveAt: new Date(), expiresAt: new Date(Date.now() + 99999),
    })
    const result = await convertCurrency(100, 'USD', 'EUR')
    expect(result!.amount).toBe(85)
  })

  it('validateRate rejects zero', () => expect(validateRate(0).valid).toBe(false))
  it('validateRate rejects negative', () => expect(validateRate(-1).valid).toBe(false))
  it('validateRate rejects NaN', () => expect(validateRate(NaN).valid).toBe(false))
  it('validateRate accepts valid', () => expect(validateRate(1.5).valid).toBe(true))
})

// ── Purchase Quote Service ──
import { createPurchaseQuote, validatePurchaseQuote, consumePurchaseQuote } from '../pricing/purchase-quote-service'

describe('purchase-quote-service', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects package with non-READY pricing status', async () => {
    ;(prisma.providerPackage.findUnique as any).mockResolvedValue({ pricingStatus: 'COST_UNAVAILABLE' })
    const result = await createPurchaseQuote({ businessId: 'b1', providerPackageId: 'p1', quantity: 1 })
    expect(result.success).toBe(false)
  })

  it('creates quote for READY package', async () => {
    ;(prisma.providerPackage.findUnique as any).mockResolvedValue({
      pricingStatus: 'READY', sellingPrice: { toString: () => '5' }, sellingCurrency: 'USD',
      effectiveCostPrice: { toString: () => '2' }, currency: 'USD',
    })
    ;(prisma.purchaseQuote.create as any).mockResolvedValue({
      quoteReference: 'QT-1', unitPrice: 5, totalAmount: 5, currency: 'USD', expiresAt: new Date(),
    })
    const result = await createPurchaseQuote({ businessId: 'b1', providerPackageId: 'p1', quantity: 1 })
    expect(result.success).toBe(true)
  })

  it('rejects consumed quote', async () => {
    ;(prisma.purchaseQuote.findUnique as any).mockResolvedValue({ status: 'CONSUMED', businessId: 'b1' })
    const result = await validatePurchaseQuote('QT-1', 'b1')
    expect(result.valid).toBe(false)
  })

  it('rejects quote from different business', async () => {
    ;(prisma.purchaseQuote.findUnique as any).mockResolvedValue({ status: 'ACTIVE', businessId: 'b2' })
    const result = await validatePurchaseQuote('QT-1', 'b1')
    expect(result.valid).toBe(false)
  })

  it('consumes active quote atomically', async () => {
    ;(prisma.purchaseQuote.updateMany as any).mockResolvedValue({ count: 1 })
    const result = await consumePurchaseQuote('QT-1')
    expect(result.success).toBe(true)
  })

  it('fails to consume already-consumed quote', async () => {
    ;(prisma.purchaseQuote.updateMany as any).mockResolvedValue({ count: 0 })
    const result = await consumePurchaseQuote('QT-1')
    expect(result.success).toBe(false)
  })
})
