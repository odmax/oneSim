import { prisma } from '@/lib/prisma'
import { checkPackageEligibility } from '@/lib/packages/package-eligibility'
import { aggregateReasons } from './metrics'

export async function runCatalogHealthDiagnostics(providerId?: string) {
  const where: any = {}
  if (providerId) where.providerId = providerId

  const packages = await prisma.providerPackage.findMany({
    where,
    include: { provider: { select: { id: true, name: true, status: true } } },
  })

  let eligible = 0
  let ineligible = 0
  const allReasons: string[] = []

  for (const pkg of packages) {
    const result = checkPackageEligibility({
      configurationStatus: pkg.configurationStatus,
      sellingPrice: pkg.sellingPrice,
      sellingCurrency: pkg.sellingCurrency,
      publishStatus: pkg.publishStatus,
      isAvailable: pkg.isAvailable,
      excludedFromCheapest: pkg.excludedFromCheapest,
      excludedFromAutoPick: pkg.excludedFromAutoPick,
      costPrice: pkg.costPrice,
      effectiveCostPrice: pkg.effectiveCostPrice ? Number(pkg.effectiveCostPrice) : null,
      provider: pkg.provider ? { status: pkg.provider.status } : null,
    })

    if (result.catalogHealthEligible) {
      eligible++
    } else {
      ineligible++
      allReasons.push(...result.reasons)
    }
  }

  return {
    total: packages.length,
    eligible,
    ineligible,
    reasonCounts: aggregateReasons(allReasons),
  }
}

export async function getProviderBlockedSummary() {
  const providers = await prisma.provider.findMany({
    where: { status: { notIn: ['ARCHIVED'] } },
    select: { id: true, name: true, code: true },
  })

  const results = []
  for (const prov of providers) {
    const summary = await runCatalogHealthDiagnostics(prov.id)
    results.push({
      providerId: prov.id,
      providerName: prov.name,
      providerCode: prov.code,
      ...summary,
    })
  }

  return results
}
