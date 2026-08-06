export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateAndCheck, respond } from '@/lib/api/v1-response'
import { stripPackageProviderFields } from '@/lib/analytics/safe-fields'
import { getPackagePurchaseReadiness } from '@/lib/packages/purchase-readiness'

export async function GET(request: NextRequest) {
  const startTime = Date.now()

  const { authError, businessId, apiKeyId, rateLimit } = await authenticateAndCheck(request, startTime)
  if (authError) return authError

  const allPackages = await prisma.eSIMPackage.findMany({
    where: {
      isActive: true,
      source: { in: ['CATALOG_PRODUCT', 'MANUAL'] },
    },
    include: {
      providerPackage: { select: { costStatus: true, pricingStatus: true, publishStatus: true, configurationStatus: true, activePriceSnapshotId: true, sellingPrice: true, costPrice: true } },
      provider: { select: { status: true, enabledCapabilities: true, code: true } },
    },
    orderBy: { priceUSD: 'asc' },
  })

  const readyPackages = allPackages.filter(pkg => {
    const readiness = getPackagePurchaseReadiness({
      pkg: { isActive: pkg.isActive, hiddenFromCatalog: pkg.hiddenFromCatalog, archivedAt: pkg.archivedAt, source: pkg.source, providerPackageId: pkg.providerPackageId },
      providerPkg: pkg.providerPackage,
      provider: pkg.provider,
    })
    return readiness.ready
  })

  const sanitized = readyPackages.map(pkg => {
    const base = stripPackageProviderFields(pkg) as any
    const unitPrice = parseFloat(pkg.priceUSD.toString())
    return {
      ...base,
      unitCost: unitPrice,
      unitPrice,
      currency: pkg.currency || 'USD',
    }
  })

  return respond(request, { success: true, packages: sanitized }, 200, startTime, businessId, {
    apiKeyId,
    rateLimit,
  })
}
