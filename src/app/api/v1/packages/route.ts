export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateAndCheck, respond } from '@/lib/api/v1-response'
import { stripPackageProviderFields } from '@/lib/analytics/safe-fields'

export async function GET(request: NextRequest) {
  const startTime = Date.now()

  const { authError, businessId, apiKeyId, rateLimit } = await authenticateAndCheck(request, startTime)
  if (authError) return authError

  const packages = await prisma.eSIMPackage.findMany({
    where: {
      isActive: true,
      hiddenFromCatalog: false,
      archivedAt: null,
      source: { in: ['CATALOG_PRODUCT', 'MANUAL'] },
    },
    orderBy: { priceUSD: 'asc' },
  })

  const sanitized = packages.map(pkg => {
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
