import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateAndCheck, respond } from '@/lib/api/v1-response'
import { stripPackageProviderFields, stripPurchaseProviderFields, stripEsimProviderFields } from '@/lib/analytics/safe-fields'

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

  const sanitized = purchases.map(p => {
    const base = stripPurchaseProviderFields(p)
    const safePkg = stripPackageProviderFields(p.package) as any
    const unitPrice = parseFloat(p.package.priceUSD.toString())
    return {
      ...base,
      package: safePkg,
      esims: p.esims.map(e => stripEsimProviderFields(e)),
      unitCost: unitPrice,
      totalCost: parseFloat(p.totalAmount.toString()),
      quantity: p.quantity,
      currency: p.package.currency || 'USD',
    }
  })

  return respond(request, { success: true, orders: sanitized }, 200, startTime, businessId, {
    apiKeyId,
    rateLimit,
  })
}
