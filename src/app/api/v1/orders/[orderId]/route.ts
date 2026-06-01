import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateAndCheck, respond } from '@/lib/api/v1-response'
import { stripPackageProviderFields, stripPurchaseProviderFields, stripEsimProviderFields } from '@/lib/analytics/safe-fields'
import { PurchaseSnapshot } from '@/lib/packages/snapshot-utils'

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

  const snap = purchase.packageSnapshot as PurchaseSnapshot | null
  const pkgInfo = snap ? {
    id: snap.packageId || purchase.package.id,
    displayName: snap.displayName || purchase.packageName || purchase.package.displayName || purchase.package.name,
    dataGB: snap.dataGB || purchase.packageDataGB || purchase.package.dataGB,
    validityDays: snap.validityDays || purchase.packageValidityDays || purchase.package.validityDays,
    priceUSD: snap.priceUSD || parseFloat(purchase.package.priceUSD.toString()),
    currency: snap.currency || purchase.packageCurrency || purchase.package.currency || 'USD',
  } : {
    id: purchase.package.id,
    displayName: purchase.packageName || purchase.package.displayName || purchase.package.name,
    dataGB: purchase.packageDataGB || purchase.package.dataGB,
    validityDays: purchase.packageValidityDays || purchase.package.validityDays,
    priceUSD: parseFloat(purchase.package.priceUSD.toString()),
    currency: purchase.packageCurrency || purchase.package.currency || 'USD',
  }

  const unitPrice = snap?.priceUSD || (purchase.packageUnitPrice ? parseFloat(purchase.packageUnitPrice.toString()) : parseFloat(purchase.package.priceUSD.toString()))

  const sanitized = {
    ...stripPurchaseProviderFields(purchase),
    package: pkgInfo,
    esims: purchase.esims.map(e => stripEsimProviderFields(e)),
    unitCost: unitPrice,
    totalCost: parseFloat(purchase.totalAmount.toString()),
    quantity: purchase.quantity,
    currency: snap?.currency || purchase.packageCurrency || purchase.package.currency || 'USD',
  }

  return respond(request, { success: true, order: sanitized }, 200, startTime, businessId, {
    apiKeyId,
    rateLimit,
  })
}