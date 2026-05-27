import { prisma } from '@/lib/prisma'

export interface ClientPriceParams {
  packageId?: string
  package?: {
    id: string
    priceUSD: { toString(): string }
    dataGB?: number
    country?: string
  }
  businessId?: string
  country?: string
}

export interface ClientPriceResult {
  basePrice: number
  finalPrice: number
  discount: number
  appliedRule: { id: string; name: string; ruleType: string } | null
}

export async function calculateClientPrice(params: ClientPriceParams): Promise<ClientPriceResult> {
  let pkg = params.package

  if (!pkg && params.packageId) {
    const dbPkg = await prisma.eSIMPackage.findUnique({ where: { id: params.packageId } })
    if (dbPkg) {
      pkg = {
        id: dbPkg.id,
        priceUSD: dbPkg.priceUSD,
        dataGB: dbPkg.dataGB,
        country: undefined,
      }
    }
  }

  if (!pkg) {
    return { basePrice: 0, finalPrice: 0, discount: 0, appliedRule: null }
  }

  const basePrice = parseFloat(pkg.priceUSD.toString())
  if (basePrice <= 0) {
    return { basePrice: 0, finalPrice: 0, discount: 0, appliedRule: null }
  }

  const now = new Date()

  const rules = await prisma.pricingRule.findMany({
    where: {
      isActive: true,
      OR: [
        { startDate: null },
        { startDate: { lte: now } },
      ],
      AND: [
        { OR: [{ endDate: null }, { endDate: { gte: now } }] },
      ],
    },
    orderBy: { priority: 'asc' },
  })

  for (const rule of rules) {
    if (!matchesRule(rule, params, pkg)) continue

    const result = applyRule(rule, basePrice)
    if (result !== null) {
      return {
        basePrice,
        finalPrice: result.finalPrice,
        discount: basePrice - result.finalPrice,
        appliedRule: { id: rule.id, name: rule.name, ruleType: rule.ruleType },
      }
    }
  }

  return { basePrice, finalPrice: basePrice, discount: 0, appliedRule: null }
}

function matchesRule(
  rule: { ruleType: string; businessId?: string | null; region?: string | null; country?: string | null; packageId?: string | null; packageType?: string | null },
  params: ClientPriceParams,
  pkg: { id: string; dataGB?: number; country?: string },
): boolean {
  switch (rule.ruleType) {
    case 'GLOBAL_DISCOUNT':
      return !rule.businessId && !rule.region && !rule.country && !rule.packageId
    case 'BUSINESS_DISCOUNT':
      return !!rule.businessId && rule.businessId === params.businessId
    case 'REGION_OVERRIDE':
      return (!!rule.region || !!rule.country) &&
        (!rule.country || rule.country === (params.country || pkg.country)) &&
        (!rule.region || rule.region === (params.country || pkg.country))
    case 'PACKAGE_OVERRIDE':
      return !!rule.packageId && rule.packageId === pkg.id
    case 'PROMOTIONAL':
      return true
    default:
      return false
  }
}

function applyRule(
  rule: { ruleMode: string; value?: any },
  basePrice: number,
): { finalPrice: number } | null {
  if (!rule.value) return null
  const val = parseFloat(rule.value.toString())

  switch (rule.ruleMode) {
    case 'PERCENTAGE': {
      if (val <= 0 || val > 100) return null
      const discount = basePrice * (val / 100)
      return { finalPrice: Math.max(0, Math.round((basePrice - discount) * 100) / 100) }
    }
    case 'FIXED_AMOUNT': {
      if (val <= 0) return null
      return { finalPrice: Math.max(0, Math.round((basePrice - val) * 100) / 100) }
    }
    case 'FIXED_PRICE': {
      if (val <= 0) return null
      return { finalPrice: Math.round(val * 100) / 100 }
    }
    default:
      return null
  }
}
