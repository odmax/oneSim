export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateAndCheck, respond } from '@/lib/api/v1-response'
import { stripPackageProviderFields, stripPurchaseProviderFields, stripEsimProviderFields } from '@/lib/analytics/safe-fields'
import { PurchaseSnapshot } from '@/lib/packages/snapshot-utils'
import { serializePublicOrder } from '@/lib/api/public-dto'

export async function GET(request: NextRequest) {
  const startTime = Date.now()

  const { authError, businessId, apiKeyId, rateLimit } = await authenticateAndCheck(request, startTime)
  if (authError) return authError

  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')

  const where: any = { businessId }
  if (status) where.status = status

  const purchases = await prisma.eSIMPurchase.findMany({
    where,
    include: {
      package: true,
      esims: {
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  const sanitized = purchases.map(p => serializePublicOrder(p))

  return respond(request, { success: true, orders: sanitized }, 200, startTime, businessId, {
    apiKeyId,
    rateLimit,
  })
}