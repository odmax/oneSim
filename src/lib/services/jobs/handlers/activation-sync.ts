import { prisma } from '@/lib/prisma'
import { enqueueJob } from '../queue'

export async function syncActivationStatus(purchaseId: string) {
  const purchase = await prisma.eSIMPurchase.findUnique({
    where: { id: purchaseId },
    include: { esims: true, package: true, business: { select: { id: true } } },
  })

  if (!purchase) return { completed: false, error: 'Purchase not found' }

  if (purchase.status === 'COMPLETED' || purchase.status === 'FAILED') {
    return { completed: true }
  }

  if (purchase.status === 'PENDING_ACTIVATION' || purchase.status === 'PENDING') {
    const hasInactiveEsims = purchase.esims.some(
      (e) => e.status === 'PENDING_ACTIVATION' || e.status === 'PENDING',
    )

    if (!hasInactiveEsims) {
      const allActive = purchase.esims.every((e) => e.status === 'ACTIVE')
      const anyFailed = purchase.esims.some((e) => e.status === 'FAILED' || e.status === 'REJECTED')

      if (allActive) {
        await prisma.eSIMPurchase.update({
          where: { id: purchaseId },
          data: { status: 'COMPLETED', providerStatus: 'ACTIVE' },
        })
        return { completed: true }
      }

      if (anyFailed) {
        await prisma.eSIMPurchase.update({
          where: { id: purchaseId },
          data: { status: 'FAILED', providerStatus: 'FAILED' },
        })
        return { completed: true }
      }
    }

    // Still pending — re-enqueue for later check
    await enqueueJob(
      'ACTIVATION_SYNC',
      { purchaseId },
      new Date(Date.now() + 2 * 60 * 1000), // 2 minutes
      10,
    )

    return { completed: false, error: 'Activation still pending, re-enqueued' }
  }

  return { completed: true }
}
