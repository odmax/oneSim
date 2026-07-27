import { prisma } from '@/lib/prisma'
import { captureReservedFunds, releaseReservedFunds } from '@/lib/services/orders/wallet-actions'
import { failOrder, createTimelineEvent } from '@/lib/services/orders/order-state-machine'

export async function completeProviderOperation(params: {
  orderId: string
  businessId: string
  providerId: string
  providerRef: string
  providerName: string
  totalAmount: number
  iccids: string[]
  userId?: string
  validityDays?: number
  packageSnapshot?: any
  packageName?: string
  packageDataGB?: number
  packageValidityDays?: number
}) {
  const { orderId, businessId, providerId, providerRef, providerName, totalAmount, iccids, userId, validityDays = 30, packageSnapshot, packageName, packageDataGB, packageValidityDays } = params

  const order = await prisma.eSIMPurchase.findUnique({ where: { id: orderId }, include: { esims: true } })
  if (!order) return { success: false, error: 'Order not found' }
  if (order.status === 'FULFILLED') return { success: true, alreadyDone: true }

  // Provision eSIMs
  if (order.esims.length === 0 && iccids.length > 0) {
    const pkg = order.packageId ? await prisma.eSIMPackage.findUnique({ where: { id: order.packageId } }) : null
    for (const iccid of iccids) {
      await prisma.eSIM.create({
        data: {
          purchaseId: orderId, iccid: String(iccid), imsi: null, status: 'ACTIVE',
          providerActivationId: providerRef || '', providerStatus: 'ACTIVE',
          expiresAt: new Date(Date.now() + (pkg?.validityDays || validityDays) * 86400000),
          packageSnapshot: (packageSnapshot ?? (order.packageSnapshot as any)) ?? undefined,
          packageName: packageName || order.packageName || '',
          packageDataGB: packageDataGB ?? order.packageDataGB ?? 0,
          packageValidityDays: packageValidityDays ?? order.packageValidityDays ?? validityDays,
        },
      }).catch(() => {})
    }
  }

  // Capture wallet
  await captureReservedFunds(orderId, businessId || order.businessId, totalAmount || Number(order.totalAmount))
  await prisma.eSIMPurchase.update({
    where: { id: orderId },
    data: { status: 'FULFILLED', providerFulfillId: providerRef || undefined, providerStatus: 'ACTIVE' },
  })
  await createTimelineEvent(orderId, { eventType: 'PROVIDER_FULFILLED', message: `Job completed — ${providerName}` })

  // Audit
  await prisma.auditLog.create({
    data: { userId: userId || order.userId || '', action: 'PROVIDER_JOB_COMPLETED', entity: 'Purchase', entityId: orderId, details: JSON.stringify({ providerId, providerRef, via: 'job' }) },
  }).catch(() => {})

  return { success: true }
}

export async function failProviderOperation(params: {
  orderId: string
  businessId: string
  providerId: string
  providerRef: string
  totalAmount: number
  reason: string
  userId?: string
}) {
  const { orderId, businessId, providerId, providerRef, totalAmount, reason, userId } = params

  const order = await prisma.eSIMPurchase.findUnique({ where: { id: orderId } })
  if (!order) return { success: false, error: 'Order not found' }
  if (order.status === 'FULFILLED') return { success: true, alreadyDone: true }

  await releaseReservedFunds(orderId, businessId || order.businessId, totalAmount || Number(order.totalAmount))
  await failOrder(orderId, reason)
  await prisma.auditLog.create({
    data: { userId: userId || order.userId || '', action: 'PROVIDER_JOB_FAILED', entity: 'Purchase', entityId: orderId, details: JSON.stringify({ providerId, providerRef, reason }) },
  }).catch(() => {})

  return { success: true }
}
