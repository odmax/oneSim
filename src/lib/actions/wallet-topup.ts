'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { generatePaymentReference, getPaymentProvider } from '@/lib/payments/payment-provider'

export async function createTopUpRequest(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

  const businessId = session.user.businessId
  if (!businessId) redirect('/login')

  const amountStr = formData.get('amount') as string
  const amount = parseFloat(amountStr)

  if (!amountStr || isNaN(amount) || amount <= 0) {
    redirect('/business/wallet/top-up?error=invalid_amount')
  }

  if (amount > 100000) {
    redirect('/business/wallet/top-up?error=amount_too_large')
  }

  const business = await prisma.business.findUnique({ where: { id: businessId } })
  if (!business) redirect('/login')

  const paymentReference = generatePaymentReference()
  const provider = getPaymentProvider()

  const topUp = await prisma.walletTopUpRequest.create({
    data: {
      businessId,
      requestedById: session.user.id,
      amount,
      currency: 'USD',
      status: 'PENDING',
      paymentReference,
      paymentMethod: 'MANUAL',
    },
  })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'TOP_UP_REQUESTED',
      entity: 'WalletTopUpRequest',
      entityId: topUp.id,
      details: `Top-up requested: $${amount} (ref: ${paymentReference})`,
    },
  })

  const paymentIntent = await provider.createPaymentIntent({
    amount,
    currency: 'USD',
    paymentReference,
    businessName: business.name,
  })

  revalidatePath('/business/wallet')
  redirect(`/business/wallet/top-up?success=true&ref=${paymentReference}&amount=${amount}`)
}

export async function approveTopUpRequest(requestId: string, formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const adminNote = formData.get('adminNote') as string

  const topUp = await prisma.walletTopUpRequest.findUnique({ where: { id: requestId } })
  if (!topUp) redirect('/admin/wallet-topups?error=Request+not+found')
  if (topUp.status !== 'PENDING') redirect('/admin/wallet-topups?error=Request+already+processed')

  await prisma.$transaction(async (tx) => {
    await tx.walletTopUpRequest.update({
      where: { id: requestId },
      data: {
        status: 'APPROVED',
        approvedById: session.user.id,
        approvedAt: new Date(),
        adminNote: adminNote || null,
      },
    })

    await tx.business.update({
      where: { id: topUp.businessId },
      data: { walletBalance: { increment: topUp.amount } },
    })

    await tx.walletTransaction.create({
      data: {
        businessId: topUp.businessId,
        amount: topUp.amount,
        type: 'TOPUP',
        description: `Wallet top-up approved — ref: ${topUp.paymentReference}`,
      },
    })

    await tx.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'TOP_UP_APPROVED',
        entity: 'WalletTopUpRequest',
        entityId: requestId,
        details: `Top-up approved: $${topUp.amount} for business ${topUp.businessId} (ref: ${topUp.paymentReference})`,
      },
    })
  })

  revalidatePath('/admin/wallet-topups')
  revalidatePath(`/admin/businesses/${topUp.businessId}`)
  redirect(`/admin/wallet-topups?success=Top-up+approved`)
}

export async function rejectTopUpRequest(requestId: string, formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') redirect('/login')

  const adminNote = formData.get('adminNote') as string

  const topUp = await prisma.walletTopUpRequest.findUnique({ where: { id: requestId } })
  if (!topUp) redirect('/admin/wallet-topups?error=Request+not+found')
  if (topUp.status !== 'PENDING') redirect('/admin/wallet-topups?error=Request+already+processed')

  await prisma.walletTopUpRequest.update({
    where: { id: requestId },
    data: {
      status: 'REJECTED',
      approvedById: session.user.id,
      approvedAt: new Date(),
      adminNote: adminNote || null,
    },
  })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'TOP_UP_REJECTED',
      entity: 'WalletTopUpRequest',
      entityId: requestId,
      details: `Top-up rejected: $${topUp.amount} for business ${topUp.businessId} (ref: ${topUp.paymentReference}). Note: ${adminNote || 'none'}`,
    },
  })

  revalidatePath('/admin/wallet-topups')
  redirect(`/admin/wallet-topups?success=Top-up+rejected`)
}
