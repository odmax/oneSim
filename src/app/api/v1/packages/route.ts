export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server'
import { authenticateAndCheck, respond } from '@/lib/api/v1-response'
import { stripPackageProviderFields } from '@/lib/analytics/safe-fields'
import { queryPurchasablePackages } from '@/lib/packages/query-purchasable'

export async function GET(request: NextRequest) {
  const startTime = Date.now()

  const { authError, businessId, apiKeyId, rateLimit } = await authenticateAndCheck(request, startTime)
  if (authError) return authError

  // Shared query — filtered by API PURCHASE exposure
  const readyPackages = await queryPurchasablePackages('api')

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
