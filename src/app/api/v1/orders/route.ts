export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateAndCheck, respond } from '@/lib/api/v1-response'
import { stripPackageProviderFields, stripPurchaseProviderFields, stripEsimProviderFields } from '@/lib/analytics/safe-fields'
import { PurchaseSnapshot } from '@/lib/packages/snapshot-utils'

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
    const snap = p.packageSnapshot as PurchaseSnapshot | null

    const pkgInfo = snap ? {
      id: snap.packageId || p.package.id,
      displayName: snap.displayName || p.packageName || p.package.displayName || p.package.name,
      dataGB: snap.dataGB || p.packageDataGB || p.package.dataGB,
      validityDays: snap.validityDays || p.packageValidityDays || p.package.validityDays,
      priceUSD: snap.priceUSD || parseFloat(p.package.priceUSD.toString()),
      currency: snap.currency || p.packageCurrency || p.package.currency || 'USD',
    } : {
      id: p.package.id,
      displayName: p.packageName || p.package.displayName || p.package.name,
      dataGB: p.packageDataGB || p.package.dataGB,
      validityDays: p.packageValidityDays || p.package.validityDays,
      priceUSD: parseFloat(p.package.priceUSD.toString()),
      currency: p.packageCurrency || p.package.currency || 'USD',
    }

    const unitPrice = snap?.priceUSD || (p.packageUnitPrice ? parseFloat(p.packageUnitPrice.toString()) : parseFloat(p.package.priceUSD.toString()))

    return {
      ...base,
      package: pkgInfo,
      esims: p.esims.map(e => stripEsimProviderFields(e)),
      unitCost: unitPrice,
      totalCost: parseFloat(p.totalAmount.toString()),
      quantity: p.quantity,
      currency: snap?.currency || p.packageCurrency || p.package.currency || 'USD',
    }
  })

  return respond(request, { success: true, orders: sanitized }, 200, startTime, businessId, {
    apiKeyId,
    rateLimit,
  })
}