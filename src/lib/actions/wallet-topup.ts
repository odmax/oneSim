'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { allocateBusinessCredit } from '@/lib/services/wallet/credit-allocation'
import crypto from 'crypto'
import { handlePrismaError, handleServerActionError } from '@/lib/errors/handle-prisma-error'

function generateReference(): string {
  const ts = Date.now().toString(36).toUpperCase()
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase()
  return `CR-${ts}-${rand}`
}

export async function createTopUpRequest(formData: FormData) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

    const businessId = session.user.businessId
    if (!businessId) redirect('/login')

    const amountStr = formData.get('amount') as string
    const amount = parseFloat(amountStr)

    if (!amountStr || isNaN(amount) || amount <= 0) redirect('/business/wallet/top-up?error=invalid_amount')
    if (amount > 100000) redirect('/business/wallet/top-up?error=amount_too_large')

    const reference = generateReference()

    await prisma.walletTopUpRequest.create({
      data: { businessId, requestedById: session.user.id, amount, currency: 'USD', status: 'PENDING', paymentReference: reference },
    })

    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'TOP_UP_REQUESTED', entity: 'WalletTopUpRequest', entityId: reference, details: `Credit request: $${amount} (ref: ${reference})` },
    })

    revalidatePath('/business/wallet')
    redirect(`/business/wallet/top-up?success=true&ref=${reference}&amount=${amount}`)
  } catch (error: any) {
    handleServerActionError(error, '/business/wallet/top-up', 'request_failed')
  }
}

export async function approveTopUpRequest(requestId: string, formData: FormData) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

    const adminNote = formData.get('adminNote') as string

    const topUp = await prisma.walletTopUpRequest.findUnique({ where: { id: requestId } })
    if (!topUp) redirect('/admin/wallet-topups?error=Request+not+found')
    if (topUp.status !== 'PENDING') redirect('/admin/wallet-topups?error=Request+already+processed')

    const result = await allocateBusinessCredit({
      businessId: topUp.businessId,
      amount: parseFloat(topUp.amount.toString()),
      currency: topUp.currency || 'USD',
      reference: topUp.paymentReference,
      source: 'ADMIN',
      note: adminNote || undefined,
      allocatedById: session.user.id,
      topUpRequestId: requestId,
    })

    if (!result.success) {
      redirect(`/admin/wallet-topups?error=${encodeURIComponent(result.error || 'Allocation failed')}`)
    }

    revalidatePath('/admin/wallet-topups')
    revalidatePath(`/admin/businesses/${topUp.businessId}`)
    redirect(`/admin/wallet-topups?success=Credit+allocated`)
  } catch (error: any) {
    handleServerActionError(error, '/admin/wallet-topups', 'approve_failed')
  }
}

export async function rejectTopUpRequest(requestId: string, formData: FormData) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

    const adminNote = formData.get('adminNote') as string

    const topUp = await prisma.walletTopUpRequest.findUnique({ where: { id: requestId } })
    if (!topUp) redirect('/admin/wallet-topups?error=Request+not+found')
    if (topUp.status !== 'PENDING') redirect('/admin/wallet-topups?error=Request+already+processed')

    await prisma.walletTopUpRequest.update({
      where: { id: requestId },
      data: { status: 'REJECTED', approvedById: session.user.id, approvedAt: new Date(), adminNote: adminNote || null },
    })

    await prisma.auditLog.create({
      data: { userId: session.user.id, action: 'TOP_UP_REJECTED', entity: 'WalletTopUpRequest', entityId: requestId, details: `Top-up rejected: $${topUp.amount} for business ${topUp.businessId} (ref: ${topUp.paymentReference}). Note: ${adminNote || 'none'}` },
    })

    revalidatePath('/admin/wallet-topups')
    redirect(`/admin/wallet-topups?success=Top-up+rejected`)
  } catch (error: any) {
    handleServerActionError(error, '/admin/wallet-topups', 'reject_failed')
  }
}
