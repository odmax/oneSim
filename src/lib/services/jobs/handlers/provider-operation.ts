import { prisma } from '@/lib/prisma'
import { getAdapterForType } from '@/lib/providers/adapter-manager'
import { captureReservedFunds, releaseReservedFunds } from '@/lib/services/orders/wallet-actions'
import { failOrder, createTimelineEvent } from '@/lib/services/orders/order-state-machine'

interface ProviderJobPayload {
  orderId: string
  businessId: string
  providerId: string
  providerRef: string
  totalAmount: number
  operation: string
}

export async function executeProviderOperation(payload: any): Promise<{ completed: boolean; error?: string }> {
  const { orderId, businessId, providerId, providerRef, totalAmount } = payload as ProviderJobPayload
  if (!orderId) return { completed: false, error: 'Missing orderId' }

  try {
    const order = await prisma.eSIMPurchase.findUnique({
      where: { id: orderId },
      include: { esims: true },
    })
    if (!order) return { completed: false, error: 'Order not found' }

    if (['FULFILLED', 'CANCELLED', 'REFUNDED'].includes(order.status)) return { completed: true }
    if (order.status === 'FAILED' && !payload.forceRetry) return { completed: true }

    const provider = await prisma.provider.findUnique({ where: { id: providerId || order.providerId || '' } })
    if (!provider) return { completed: false, error: 'Provider not found' }

    const adapter = await getAdapterForType(provider.type, {
      apiBaseUrl: provider.apiBaseUrl, apiToken: provider.apiToken,
      providerId: provider.id, environment: provider.environment, authUrl: provider.authUrl,
    })

    // Poll provider via activateESIM status check
    let providerStatus = 'PENDING'
    let providerIccids: string[] = []

    if (typeof adapter.getActivationStatus === 'function' && providerRef) {
      const r = await adapter.getActivationStatus(providerRef)
      if (r?.success && r.data) {
        providerStatus = r.data.status || 'PENDING'
        providerIccids = r.data.iccids || []
      }
    }

    if (providerStatus === 'ACTIVE' || providerStatus === 'ACTIVATED') {
      // Provision eSIMs if needed
      if (order.esims.length === 0 && providerIccids.length > 0) {
        const pkg = await prisma.eSIMPackage.findUnique({ where: { id: order.packageId } })
        for (const iccid of providerIccids) {
          await prisma.eSIM.create({
            data: {
              purchaseId: orderId, iccid: String(iccid), imsi: null, status: 'ACTIVE',
              providerActivationId: providerRef || '', providerStatus: 'ACTIVE',
              expiresAt: new Date(Date.now() + (pkg?.validityDays || 30) * 86400000),
              packageSnapshot: (order.packageSnapshot as any) ?? undefined,
              packageName: order.packageName || '', packageDataGB: order.packageDataGB || 0,
              packageValidityDays: order.packageValidityDays || 30,
            },
          })
        }
      }

      if (order.status !== 'FULFILLED') {
        await captureReservedFunds(orderId, businessId || order.businessId, totalAmount || Number(order.totalAmount))
        await prisma.eSIMPurchase.update({
          where: { id: orderId },
          data: { status: 'FULFILLED', providerFulfillId: providerRef || undefined, providerStatus },
        })
        await createTimelineEvent(orderId, { eventType: 'PROVIDER_FULFILLED', message: `Async job completed — ${provider.name}` })
      }

      await prisma.auditLog.create({
        data: { userId: order.userId || '', action: 'PROVIDER_JOB_COMPLETED', entity: 'Purchase', entityId: orderId, details: JSON.stringify({ providerId, providerRef, status: providerStatus }) },
      }).catch(() => {})

      return { completed: true }
    }

    if (providerStatus === 'FAILED' || providerStatus === 'CANCELLED' || providerStatus === 'EXPIRED') {
      await releaseReservedFunds(orderId, businessId || order.businessId, totalAmount || Number(order.totalAmount))
      await failOrder(orderId, `Provider operation ${providerStatus}: ${providerRef}`)
      await prisma.auditLog.create({
        data: { userId: order.userId || '', action: 'PROVIDER_JOB_FAILED', entity: 'Purchase', entityId: orderId, details: JSON.stringify({ providerId, providerRef, status: providerStatus }) },
      }).catch(() => {})
      return { completed: true }
    }

    return { completed: false, error: `Still processing: ${providerStatus}` }
  } catch (error: any) {
    return { completed: false, error: error.message || 'Provider operation handler threw' }
  }
}
