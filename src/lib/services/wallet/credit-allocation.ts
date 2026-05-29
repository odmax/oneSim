import { prisma } from '@/lib/prisma'

export interface CreditAllocationParams {
  businessId: string
  amount: number
  currency?: string
  reference: string
  source: 'ADMIN' | 'ACCOUNTING_SYSTEM'
  note?: string
  allocatedById?: string
  topUpRequestId?: string
}

export async function allocateBusinessCredit(params: CreditAllocationParams): Promise<{ success: boolean; error?: string }> {
  const { businessId, amount, currency = 'USD', reference, source, note, allocatedById, topUpRequestId } = params

  if (amount <= 0) return { success: false, error: 'Amount must be greater than 0' }

  try {
    await prisma.$transaction(async (tx) => {
      if (topUpRequestId) {
        await tx.walletTopUpRequest.update({
          where: { id: topUpRequestId },
          data: { status: 'APPROVED', approvedById: allocatedById || null, approvedAt: new Date(), adminNote: note || null },
        })
      }

      await tx.business.update({
        where: { id: businessId },
        data: { walletBalance: { increment: amount } },
      })

      await tx.walletTransaction.create({
        data: {
          businessId,
          amount,
          type: 'TOPUP',
          description: `Credit allocation — ref: ${reference}${note ? ` (${note})` : ''}`,
        },
      })

      const ts = Date.now().toString(36).toUpperCase()
      const rand = Math.random().toString(36).substring(2, 6).toUpperCase()

      await tx.invoice.create({
        data: {
          invoiceNumber: `CRD-${ts}-${rand}`,
          businessId,
          type: 'TOPUP',
          amount,
          currency,
          status: 'PAID',
          paidAt: new Date(),
          metadata: { allocationReference: reference, source },
        },
      })

      await tx.auditLog.create({
        data: {
          userId: allocatedById || null,
          action: 'CREDIT_ALLOCATED',
          entity: 'Business',
          entityId: businessId,
          details: `Credit allocated: $${amount} (ref: ${reference}) via ${source}`,
        },
      })
    })

    return { success: true }
  } catch (error: any) {
    return { success: false, error: error.message || 'Allocation failed' }
  }
}
