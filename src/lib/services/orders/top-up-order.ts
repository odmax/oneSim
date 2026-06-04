import { prisma } from '@/lib/prisma'
import { getAdapterForProvider } from '@/lib/providers/adapter-manager'

export interface TopUpOrderParams {
  businessId: string
  userId: string
  esimId: string
  topUpPackageId: string
  quantity?: number
}

export interface TopUpOrderResult {
  success: boolean
  topUpId?: string
  status?: string
  amount?: number
  currency?: string
  dataAddedMB?: number
  validityDaysAdded?: number
  error?: string
  errorStatus?: number
}

export async function createTopUpOrder(params: TopUpOrderParams): Promise<TopUpOrderResult> {
  const { businessId, userId, esimId, topUpPackageId, quantity = 1 } = params

  // Fetch eSIM with relations
  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: {
      purchase: { include: { business: true, package: true } },
    },
  })

  if (!esim) return { success: false, error: 'eSIM not found', errorStatus: 404 }
  if (esim.purchase.businessId !== businessId) return { success: false, error: 'eSIM does not belong to this business', errorStatus: 403 }

  const allowedStatuses = ['ACTIVE', 'PENDING_ACTIVATION', 'PENDING']
  if (!allowedStatuses.includes(esim.status)) {
    return { success: false, error: 'eSIM status does not allow top-up', errorStatus: 400 }
  }

  if (!esim.iccid) return { success: false, error: 'eSIM has no ICCID', errorStatus: 400 }

  // Fetch top-up package
  const topUpPkg = await prisma.eSIMPackage.findUnique({ where: { id: topUpPackageId } })
  if (!topUpPkg || !topUpPkg.isActive) return { success: false, error: 'Top-up package not found or inactive', errorStatus: 404 }

  const productType = topUpPkg.productType || 'NEW_ESIM'
  if (productType !== 'TOP_UP' && productType !== 'BOTH') {
    return { success: false, error: 'Package is not a top-up package', errorStatus: 400 }
  }

  const providerId = topUpPkg.providerId || esim.purchase.package.providerId
  if (!providerId) return { success: false, error: 'No provider configured for top-up', errorStatus: 400 }

  // Check provider supports top-up
  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider || !provider.supportsTopUp) {
    return { success: false, error: 'Provider does not support top-up', errorStatus: 400 }
  }

  // Check wallet
  const business = await prisma.business.findUnique({ where: { id: businessId } })
  if (!business) return { success: false, error: 'Business not found', errorStatus: 404 }
  if (business.status === 'SUSPENDED') return { success: false, error: 'Business account is suspended', errorStatus: 403 }

  const amount = parseFloat(topUpPkg.priceUSD.toString()) * quantity
  if (parseFloat(business.walletBalance.toString()) < amount) {
    return { success: false, error: 'Insufficient wallet balance', errorStatus: 402 }
  }

  // Call provider top-up
  const adapter = await getAdapterForProvider(providerId)
  if (!adapter) return { success: false, error: 'Provider adapter unavailable', errorStatus: 502 }

  const providerResult = await adapter.topUpESIM({
    iccid: esim.iccid,
    imsi: esim.imsi,
    planId: topUpPkg.providerPlanId || topUpPkg.id,
    sku: topUpPkg.sku || topUpPkg.packageCode || undefined,
    packageName: topUpPkg.displayName || topUpPkg.name,
    quantity,
  })

  if (!providerResult.success) {
    ;(async () => {
      try {
        const { enqueueBusinessWebhooks } = await import('@/lib/services/business-webhooks/dispatcher')
        await enqueueBusinessWebhooks(businessId, 'topup.failed', {
          esimId: params.esimId, iccid: esim.iccid,
          topUpPackageId, error: providerResult.error?.message,
        })
      } catch { }
    })()
    return { success: false, error: providerResult.error?.message || 'Provider top-up failed', errorStatus: 502 }
  }

  const topUpData = providerResult.data!

  // Determine added data/validity
  const dataAddedMB = topUpData.dataAddedMB ?? (topUpPkg.dataGB ? topUpPkg.dataGB * 1024 : undefined)
  const validityDaysAdded = topUpData.validityDaysAdded ?? topUpPkg.validityDays ?? undefined

  // Atomic transaction
  try {
    const result = await prisma.$transaction(async (tx) => {
      const topUp = await tx.eSIMTopUp.create({
        data: {
          businessId,
          esimId,
          packageId: topUpPackageId,
          providerId,
          providerReference: topUpData.providerReference || null,
          amount,
          currency: topUpPkg.currency || 'USD',
          status: 'COMPLETED',
          dataAddedMB: dataAddedMB || null,
          validityDaysAdded: validityDaysAdded || null,
          providerResponse: topUpData as any,
          completedAt: new Date(),
        },
      })

      // Update eSIM expiry and data
      const updateData: any = {}
      if (validityDaysAdded && esim.expiresAt) {
        updateData.expiresAt = new Date(esim.expiresAt.getTime() + validityDaysAdded * 24 * 60 * 60 * 1000)
      } else if (validityDaysAdded) {
        updateData.expiresAt = new Date(Date.now() + validityDaysAdded * 24 * 60 * 60 * 1000)
      }
      if (topUpData.newDataTotalMB) updateData.dataTotalMB = topUpData.newDataTotalMB
      if (topUpData.newDataRemainingMB) updateData.dataRemainingMB = topUpData.newDataRemainingMB

      if (Object.keys(updateData).length > 0) {
        await tx.eSIM.update({ where: { id: esimId }, data: updateData })
      }

      // Deduct wallet
      await tx.business.update({
        where: { id: businessId },
        data: { walletBalance: { decrement: amount } },
      })

      await tx.walletTransaction.create({
        data: {
          businessId,
          amount: -amount,
          type: 'TOPUP_ESIM',
          description: `Top-up: ${topUpPkg.displayName || topUpPkg.name} for eSIM ${esim.iccid}`,
        },
      })

      const ts = Date.now().toString(36).toUpperCase()
      const rand = Math.random().toString(36).substring(2, 6).toUpperCase()

      await tx.invoice.create({
        data: {
          invoiceNumber: `TOP-${ts}-${rand}`,
          businessId,
          topUpId: topUp.id,
          type: 'TOPUP',
          amount,
          currency: topUpPkg.currency || 'USD',
          status: 'PAID',
          paidAt: new Date(),
        },
      })

      await tx.auditLog.create({
        data: {
          userId,
          action: 'ESIM_TOPUP',
          entity: 'ESIMTopUp',
          entityId: topUp.id,
          details: `Top-up: ${topUpPkg.displayName || topUpPkg.name} on ${esim.iccid} for $${amount}`,
        },
      })

      return topUp
    })

    ;(async () => {
      try {
        const { enqueueBusinessWebhooks } = await import('@/lib/services/business-webhooks/dispatcher')
        await enqueueBusinessWebhooks(businessId, 'topup.completed', {
          topUpId: result.id, esimId: params.esimId, iccid: esim.iccid,
          topUpPackageId, amount, dataAddedMB, validityDaysAdded,
        })
      } catch { }
    })()

    return {
      success: true,
      topUpId: result.id,
      status: 'COMPLETED',
      amount,
      currency: topUpPkg.currency || 'USD',
      dataAddedMB: dataAddedMB || undefined,
      validityDaysAdded: validityDaysAdded || undefined,
    }
  } catch (error: any) {
    return { success: false, error: `Transaction failed: ${error.message || 'Unknown error'}`, errorStatus: 500 }
  }
}