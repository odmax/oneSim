import { prisma } from '@/lib/prisma'
import { getAdapterForType } from '@/lib/providers/adapter-manager'
import { completeProviderOperation, failProviderOperation } from '../provider-finalizer'
import { normalizeConnectorInstallData, type ProviderInstallData } from '@/lib/esim/installation-data'

export async function executeProviderOperation(payload: any): Promise<{ completed: boolean; error?: string }> {
  const { orderId, businessId, providerId, providerRef, totalAmount } = payload
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

    let providerStatus = 'PENDING'
    let providerIccids: string[] = []
    let installData: ProviderInstallData = {}

    if (typeof adapter.getActivationStatus === 'function' && providerRef) {
      const r = await adapter.getActivationStatus(providerRef)
      if (r?.success && r.data) {
        providerStatus = r.data.status || 'PENDING'
        providerIccids = r.data.iccids || []
        installData = normalizeConnectorInstallData(r.data)
      }
    }

    if (providerStatus === 'ACTIVE' || providerStatus === 'ACTIVATED') {
      await completeProviderOperation({
        orderId, businessId: businessId || order.businessId, providerId: provider.id,
        providerRef, providerName: provider.name, totalAmount: totalAmount || Number(order.totalAmount),
        iccids: providerIccids, userId: order.userId || undefined,
        packageSnapshot: (order.packageSnapshot as any) ?? undefined,
        packageName: order.packageName || undefined,
        packageDataGB: order.packageDataGB ?? undefined,
        packageValidityDays: order.packageValidityDays ?? undefined,
        ...installData,
      })
      return { completed: true }
    }

    if (providerStatus === 'FAILED' || providerStatus === 'CANCELLED' || providerStatus === 'EXPIRED') {
      await failProviderOperation({
        orderId, businessId: businessId || order.businessId, providerId: provider.id,
        providerRef, totalAmount: totalAmount || Number(order.totalAmount),
        reason: `Provider operation ${providerStatus}: ${providerRef}`,
        userId: order.userId || undefined,
      })
      return { completed: true }
    }

    return { completed: false, error: `Still processing: ${providerStatus}` }
  } catch (error: any) {
    return { completed: false, error: error.message || 'Provider operation handler threw' }
  }
}
