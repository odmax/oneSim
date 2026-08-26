export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server'
import { authenticateAndCheck, respond } from '@/lib/api/v1-response'
import { serializePublicPackage } from '@/lib/api/public-dto'
import { queryPurchasablePackages } from '@/lib/packages/query-purchasable'

export async function GET(request: NextRequest) {
  const startTime = Date.now()

  const { authError, businessId, apiKeyId, rateLimit } = await authenticateAndCheck(request, startTime)
  if (authError) return authError

  const readyPackages = await queryPurchasablePackages('api')

  const packages = readyPackages.map(pkg =>
    serializePublicPackage(pkg, pkg.providerPackage)
  )

  return respond(request, { success: true, packages }, 200, startTime, businessId, {
    apiKeyId,
    rateLimit,
  })
}
