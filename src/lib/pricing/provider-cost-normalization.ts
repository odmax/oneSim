/**
 * Provider Cost Normalization — Phase 5C
 * ========================================
 *
 * PROVIDER-AGNOSTIC cost normalization pipeline.
 * No provider-name checks anywhere in this file.
 */

import { prisma } from '@/lib/prisma'

// ──────────────── Types ────────────────

export type CostSource =
  | 'PROVIDER_COST'
  | 'PROVIDER_WHOLESALE'
  | 'PROVIDER_NET_PRICE'
  | 'DERIVED_FROM_COMMISSION'
  | 'DERIVED_FROM_DISCOUNT'
  | 'ADMIN_OVERRIDE'

export type CostStatus = 'VALID' | 'STALE' | 'MISSING' | 'INVALID' | 'OVERRIDDEN'

export type CostDerivationMethod = 'DIRECT_COST' | 'RETAIL_MINUS_COMMISSION' | 'RETAIL_MINUS_COMMISSION_PERCENT' | 'RETAIL_DISCOUNT_PERCENT'

export type FeeType = 'ACTIVATION' | 'TRANSACTION' | 'RECURRING' | 'RENEWAL' | 'TAX' | 'OTHER'

export type FeeChargeTiming = 'AT_PURCHASE' | 'AT_ACTIVATION' | 'MONTHLY' | 'AT_RENEWAL' | 'PROVIDER_INCLUDED'

export interface ProviderFee {
  type: FeeType
  amount: number
  currency: string
  chargeTiming: FeeChargeTiming
  label?: string
}

export interface NormalizedProviderCost {
  amount: number
  currency: string
  source: CostSource
  originalAmount: number
  originalCurrency: string
  isTaxInclusive: boolean
  taxAmount?: number
  fees?: ProviderFee[]
  receivedAt: Date
  expiresAt?: Date
  metadata?: Record<string, unknown>
}

export interface CostDerivationConfig {
  method: CostDerivationMethod
  retailPrice?: number
  commissionAmount?: number
  commissionPercent?: number
  discountPercent?: number
}

export interface EffectiveCostResolution {
  amount: number | null
  currency: string | null
  source: 'ADMIN_OVERRIDE' | 'PROVIDER' | 'DERIVED' | 'VERIFIED_FALLBACK' | 'MISSING'
  costStatus: CostStatus
  snapshotId?: string
  reason?: string
}

// ──────────────── Validation ────────────────

export function validateProviderCost(cost: NormalizedProviderCost): {
  valid: boolean; errors: string[]
} {
  const errors: string[] = []
  if (typeof cost.amount !== 'number' || isNaN(cost.amount) || !isFinite(cost.amount)) errors.push('amount must be a valid number')
  if (cost.amount < 0) errors.push('amount cannot be negative')
  if (!cost.currency || cost.currency.length !== 3) errors.push('currency must be a 3-letter ISO code')
  if (!cost.originalCurrency || cost.originalCurrency.length !== 3) errors.push('originalCurrency must be a 3-letter ISO code')
  if (cost.isTaxInclusive && cost.taxAmount != null && cost.taxAmount < 0) errors.push('taxAmount cannot be negative')
  if (cost.fees) {
    for (const fee of cost.fees) {
      if (fee.amount < 0) errors.push(`fee amount cannot be negative (${fee.type})`)
    }
  }
  if (cost.expiresAt && cost.expiresAt <= cost.receivedAt) errors.push('expiresAt must be after receivedAt')
  return { valid: errors.length === 0, errors }
}

// ──────────────── Normalization ────────────────

/**
 * Convert raw provider response to NormalizedProviderCost.
 *
 * Backward compatibility: if called with only { amount, currency },
 * auto-normalizes to PROVIDER_COST with receivedAt=now.
 */
export function normalizeProviderCost(input: {
  amount: number
  currency?: string | null
  source?: CostSource
  isTaxInclusive?: boolean
  taxAmount?: number
  fees?: ProviderFee[]
  derivedFrom?: {
    method: CostDerivationMethod
    retailPrice?: number
    commissionAmount?: number
    commissionPercent?: number
    discountPercent?: number
  }
}): NormalizedProviderCost {
  const now = new Date()
  let amount = input.amount
  let source = input.source || 'PROVIDER_COST'

  // Cost derivation — pure arithmetic, no provider checks
  if (input.derivedFrom) {
    const d = input.derivedFrom
    switch (d.method) {
      case 'RETAIL_MINUS_COMMISSION':
        if (d.retailPrice != null && d.commissionAmount != null) {
          amount = d.retailPrice - d.commissionAmount
          source = 'DERIVED_FROM_COMMISSION'
        }
        break
      case 'RETAIL_MINUS_COMMISSION_PERCENT':
        if (d.retailPrice != null && d.commissionPercent != null) {
          amount = d.retailPrice * (1 - d.commissionPercent / 100)
          source = 'DERIVED_FROM_COMMISSION'
        }
        break
      case 'RETAIL_DISCOUNT_PERCENT':
        if (d.retailPrice != null && d.discountPercent != null) {
          amount = d.retailPrice * (1 - d.discountPercent / 100)
          source = 'DERIVED_FROM_DISCOUNT'
        }
        break
    }
  }

  const currency = (input.currency || 'USD').toUpperCase()

  return {
    amount,
    currency,
    source,
    originalAmount: amount,
    originalCurrency: currency,
    isTaxInclusive: input.isTaxInclusive || false,
    taxAmount: input.taxAmount,
    fees: input.fees,
    receivedAt: now,
    metadata: input.derivedFrom ? { derivationMethod: input.derivedFrom.method } : undefined,
  }
}

// ──────────────── Persistence ────────────────

export async function persistProviderCost(
  packageId: string,
  cost: NormalizedProviderCost,
  costDerivation?: CostDerivationConfig,
): Promise<{ costStatus: CostStatus; snapshotId?: string }> {
  const validation = validateProviderCost(cost)
  if (!validation.valid) {
    await prisma.providerPackage.update({
      where: { id: packageId },
      data: { costStatus: 'INVALID' },
    })
    return { costStatus: 'INVALID' }
  }

  const amount = cost.amount
  const status: CostStatus = amount > 0 ? 'VALID' : 'MISSING'

  // Persist fees
  await prisma.providerPackageFee.deleteMany({ where: { providerPackageId: packageId } })
  if (cost.fees && cost.fees.length > 0) {
    await prisma.providerPackageFee.createMany({
      data: cost.fees.map(f => ({
        providerPackageId: packageId,
        type: f.type,
        amount: f.amount,
        currency: f.currency,
        chargeTiming: f.chargeTiming,
        label: f.label || null,
      })),
    })
  }

  // Persist main cost
  await prisma.providerPackage.update({
    where: { id: packageId },
    data: {
      costStatus: status,
      costReceivedAt: cost.receivedAt,
      costExpiresAt: cost.expiresAt || null,
      isTaxInclusive: cost.isTaxInclusive,
      taxAmount: cost.taxAmount || null,
      pricingStatus: status === 'VALID' ? 'READY' : 'COST_UNAVAILABLE',
      costDerivationMethod: costDerivation?.method || 'DIRECT_COST',
      costDerivationConfig: costDerivation ? JSON.parse(JSON.stringify(costDerivation)) : null,
    },
  })

  // Snapshot
  const writeSnapshot = async (normalizedCurrency: string = cost.currency) => {
    // Truncate Decimal to 6dp for Prisma
    const roundToDecimal = (v: number) => Math.round(v * 1000000) / 1000000
    return prisma.providerCostSnapshot.create({
      data: {
        providerPackageId: packageId,
        originalAmount: roundToDecimal(cost.originalAmount),
        originalCurrency: cost.originalCurrency,
        normalizedAmount: roundToDecimal(amount),
        normalizedCurrency,
        costSource: cost.source,
        exchangeRate: null,
        exchangeRateSource: null,
        exchangeRateVersion: null,
        isTaxInclusive: cost.isTaxInclusive,
        taxAmount: cost.taxAmount ? roundToDecimal(cost.taxAmount) : null,
        feesSnapshot: cost.fees ? JSON.parse(JSON.stringify(cost.fees)) : null,
        receivedAt: cost.receivedAt,
        expiresAt: cost.expiresAt || null,
        metadata: cost.metadata ? JSON.parse(JSON.stringify(cost.metadata)) : null,
      },
    })
  }

  const snapshot = await writeSnapshot()

  return { costStatus: status, snapshotId: snapshot.id }
}

// ──────────────── Effective Cost Resolution ────────────────

/**
 * Resolve effective cost for pricing.
 *
 * Priority:
 *   1. Active admin override (adminCostPrice > 0)
 *   2. Current valid normalized provider cost (costStatus=VALID)
 *   3. Derived cost from configured method
 *   4. Previously verified cost within freshness window
 *   5. MISSING
 */
export async function resolveEffectiveCost(
  packageId: string,
  freshnessMs: number = 90 * 24 * 60 * 60 * 1000, // 90 days default
): Promise<EffectiveCostResolution> {
  const pkg = await prisma.providerPackage.findUnique({
    where: { id: packageId },
    select: {
      adminCostPrice: true, effectiveCostPrice: true, costPrice: true, currency: true,
      costStatus: true, costReceivedAt: true, costExpiresAt: true,
      costDerivationMethod: true, costDerivationConfig: true,
    },
  })
  if (!pkg) return { amount: null, currency: null, source: 'MISSING', costStatus: 'MISSING', reason: 'Package not found' }

  // 1. Admin override wins
  const adminCost = pkg.adminCostPrice ? Number(pkg.adminCostPrice) : 0
  if (adminCost > 0) {
    return {
      amount: adminCost, currency: pkg.currency,
      source: 'ADMIN_OVERRIDE', costStatus: 'OVERRIDDEN',
      reason: `Admin override: ${adminCost}`,
    }
  }

  // 2. Current valid normalized cost
  if (pkg.costStatus === 'VALID') {
    const cost = Number(pkg.costPrice)
    if (cost > 0) {
      return { amount: cost, currency: pkg.currency, source: 'PROVIDER', costStatus: 'VALID' }
    }
  }

  // 3. Derived cost
  if (pkg.costDerivationMethod && pkg.costDerivationMethod !== 'DIRECT_COST') {
    const config = (pkg.costDerivationConfig || {}) as any
    const result = deriveCost(config)
    if (result != null && result > 0) {
      return { amount: result, currency: pkg.currency, source: 'DERIVED', costStatus: 'VALID', reason: `Derived via ${pkg.costDerivationMethod}` }
    }
  }

  // 4. Verified fallback within freshness window
  if (pkg.costReceivedAt && pkg.costStatus === 'STALE') {
    const age = Date.now() - pkg.costReceivedAt.getTime()
    if (age <= freshnessMs) {
      const cost = Number(pkg.costPrice)
      if (cost > 0) {
        return {
          amount: cost, currency: pkg.currency, source: 'VERIFIED_FALLBACK', costStatus: 'STALE',
          reason: `Using verified cost (${Math.round(age / 86400000)}d old, within ${freshnessMs / 86400000}d window)`,
        }
      }
    }
  }

  return { amount: null, currency: null, source: 'MISSING', costStatus: 'MISSING', reason: 'No valid cost available' }
}

// ──────────────── Derivation ────────────────

function deriveCost(config: CostDerivationConfig): number | null {
  switch (config.method) {
    case 'RETAIL_MINUS_COMMISSION':
      if (config.retailPrice != null && config.commissionAmount != null) return config.retailPrice - config.commissionAmount
      break
    case 'RETAIL_MINUS_COMMISSION_PERCENT':
      if (config.retailPrice != null && config.commissionPercent != null) return config.retailPrice * (1 - config.commissionPercent / 100)
      break
    case 'RETAIL_DISCOUNT_PERCENT':
      if (config.retailPrice != null && config.discountPercent != null) return config.retailPrice * (1 - config.discountPercent / 100)
      break
  }
  return null
}

// ──────────────── Pricing Availability ────────────────

/**
 * Check if a package can be purchased based on cost status.
 * Packages with MISSING or INVALID cost are not purchasable.
 */
export function isPackagePurchasable(
  costStatus: CostStatus | null | undefined,
  adminOverrideActive: boolean,
): boolean {
  if (adminOverrideActive) return true
  if (!costStatus) return false
  return costStatus === 'VALID' || costStatus === 'OVERRIDDEN'
}
