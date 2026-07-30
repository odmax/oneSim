import { prisma } from '@/lib/prisma'
import { getExchangeRateMaxAge, PLATFORM_BASE_CURRENCY } from './currency-config'

export type ExchangeRateResolutionType = 'DIRECT' | 'INVERSE' | 'CROSS_RATE' | 'SAME_CURRENCY'

export interface ExchangeRateResolution {
  rate: number
  baseCurrency: string
  quoteCurrency: string
  resolutionType: ExchangeRateResolutionType
  source: string | 'IDENTITY'
  exchangeRateId?: string
  version?: number
  effectiveAt: Date
  expiresAt?: Date
}

export async function getExchangeRate(from: string, to: string): Promise<ExchangeRateResolution | null> {
  const base = from.toUpperCase()
  const quote = to.toUpperCase()
  if (base === quote) {
    return { rate: 1, baseCurrency: base, quoteCurrency: quote, resolutionType: 'SAME_CURRENCY', source: 'IDENTITY', effectiveAt: new Date() }
  }

  const now = new Date()
  const minAge = new Date(now.getTime() - getExchangeRateMaxAge() * 60 * 1000)

  // DIRECT rate
  const direct = await prisma.exchangeRate.findFirst({
    where: { baseCurrency: base, quoteCurrency: quote, status: 'ACTIVE', expiresAt: { gte: now } },
    orderBy: { effectiveAt: 'desc' },
  })
  if (direct) {
    return {
      rate: Number(direct.rate),
      baseCurrency: base, quoteCurrency: quote,
      resolutionType: 'DIRECT', source: direct.source,
      exchangeRateId: direct.id, version: direct.version,
      effectiveAt: direct.effectiveAt, expiresAt: direct.expiresAt || undefined,
    }
  }

  // INVERSE rate
  const inverse = await prisma.exchangeRate.findFirst({
    where: { baseCurrency: quote, quoteCurrency: base, status: 'ACTIVE', expiresAt: { gte: now } },
    orderBy: { effectiveAt: 'desc' },
  })
  if (inverse && Number(inverse.rate) > 0) {
    return {
      rate: 1 / Number(inverse.rate),
      baseCurrency: base, quoteCurrency: quote,
      resolutionType: 'INVERSE', source: inverse.source,
      exchangeRateId: inverse.id, version: inverse.version,
      effectiveAt: inverse.effectiveAt, expiresAt: inverse.expiresAt || undefined,
    }
  }

  // CROSS_RATE via platform base currency
  if (base !== PLATFORM_BASE_CURRENCY && quote !== PLATFORM_BASE_CURRENCY) {
    const leg1 = await prisma.exchangeRate.findFirst({
      where: { baseCurrency: base, quoteCurrency: PLATFORM_BASE_CURRENCY, status: 'ACTIVE', expiresAt: { gte: now } },
      orderBy: { effectiveAt: 'desc' },
    })
    if (!leg1) return null

    const leg2 = await prisma.exchangeRate.findFirst({
      where: { baseCurrency: PLATFORM_BASE_CURRENCY, quoteCurrency: quote, status: 'ACTIVE', expiresAt: { gte: now } },
    })
    if (!leg2) return null

    return {
      rate: Number(leg1.rate) * Number(leg2.rate),
      baseCurrency: base, quoteCurrency: quote,
      resolutionType: 'CROSS_RATE', source: 'SYSTEM',
      exchangeRateId: `${leg1.id},${leg2.id}`, version: Math.max(leg1.version, leg2.version),
      effectiveAt: new Date(Math.min(leg1.effectiveAt.getTime(), leg2.effectiveAt.getTime())),
      expiresAt: leg1.expiresAt && leg2.expiresAt ? new Date(Math.min(leg1.expiresAt.getTime(), leg2.expiresAt.getTime())) : undefined,
    }
  }

  return null
}

export async function convertCurrency(amount: number, from: string, to: string): Promise<{ amount: number; resolution: ExchangeRateResolution } | null> {
  const resolution = await getExchangeRate(from, to)
  if (!resolution) return null
  return { amount: amount * resolution.rate, resolution }
}

export function validateRate(rate: number): { valid: boolean; error?: string } {
  if (typeof rate !== 'number' || isNaN(rate) || !isFinite(rate)) return { valid: false, error: 'Rate must be a valid number' }
  if (rate <= 0) return { valid: false, error: 'Rate must be greater than zero' }
  return { valid: true }
}
