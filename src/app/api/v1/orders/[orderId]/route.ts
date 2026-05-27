import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateAndCheck, respond } from '@/lib/api/v1-response'
import { stripPackageProviderFields, stripPurchaseProviderFields, stripEsimProviderFields } from '@/lib/analytics/safe-fields'

export async function GET(
  request: NextRequest,
  { params }: { params: { orderId: string } },
) {
  const startTime = Date.now()

  const { authError, businessId, apiKeyId, rateLimit } = await authenticateAndCheck(request, startTime)
  if (authError) return authError

  const purchase = await prisma.eSIMPurchase.findUnique({
    where: { id: params.orderId },
    include: {
      package: true,
      esims: {
        orderBy: { createdAt: 'asc' },
      },
    },
  })

  if (!purchase) {
    return respond(request, { success: false, error: 'Order not found' }, 404, startTime, businessId, {
      apiKeyId,
      rateLimit,
      errorMessage: 'Order not found',
    })
  }

  if (purchase.businessId !== businessId) {
    return respond(request, { success: false, error: 'Forbidden' }, 403, startTime, businessId, {
      apiKeyId,
      rateLimit,
      errorMessage: 'Order does not belong to this business',
    })
  }

  const safePkg = stripPackageProviderFields(purchase.package) as any
  const unitPrice = parseFloat(purchase.package.priceUSD.toString())

  const sanitized = {
    ...stripPurchaseProviderFields(purchase),
    package: safePkg,
    esims: purchase.esims.map(e => stripEsimProviderFields(e)),
    unitCost: unitPrice,
    totalCost: parseFloat(purchase.totalAmount.toString()),
    quantity: purchase.quantity,
    currency: purchase.package.currency || 'USD',
  }

  return respond(request, { success: true, order: sanitized }, 200, startTime, businessId, {
    apiKeyId,
    rateLimit,
  })
}
