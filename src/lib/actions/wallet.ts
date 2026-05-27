'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'

export async function topUpWallet(formData: FormData) {
  const session = await getServerSession(authOptions)
  
  if (!session || session.user.role !== 'BUSINESS_USER') {
    redirect('/login')
  }

  const amount = parseFloat(formData.get('amount') as string)

  if (isNaN(amount) || amount <= 0) {
    redirect('/business/wallet?error=invalid_amount')
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.business.update({
        where: { id: session.user.businessId! },
        data: { walletBalance: { increment: amount } },
      })

      await tx.walletTransaction.create({
        data: {
          businessId: session.user.businessId!,
          amount: amount,
          type: 'TOP_UP',
          description: `Wallet top-up of $${amount}`,
        },
      })

      await tx.auditLog.create({
        data: {
          userId: session.user.id,
          action: 'TOP_UP',
          entity: 'Business',
          entityId: session.user.businessId!,
          details: `Topped up wallet with $${amount}`,
        },
      })
    })

    revalidatePath('/business/wallet')
    revalidatePath('/business/dashboard')
  } catch (error) {
    console.error('Top-up error:', error)
    redirect('/business/wallet?error=topup_failed')
  }
}

export async function adminCreditWallet(formData: FormData) {
  const session = await getServerSession(authOptions)

  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    redirect('/login')
  }

  const businessId = formData.get('businessId') as string
  const amount = parseFloat(formData.get('amount') as string)
  const reason = (formData.get('reason') as string)?.trim()

  if (!businessId || isNaN(amount) || amount <= 0) {
    redirect(`/admin/businesses/${businessId}?error=invalid_amount`)
  }

  if (!reason) {
    redirect(`/admin/businesses/${businessId}?error=missing_reason`)
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.business.update({
        where: { id: businessId },
        data: { walletBalance: { increment: amount } },
      })

      await tx.walletTransaction.create({
        data: {
          businessId,
          amount,
          type: 'CREDIT',
          description: reason,
        },
      })

      await tx.auditLog.create({
        data: {
          userId: session.user.id,
          action: 'CREDIT',
          entity: 'Business',
          entityId: businessId,
          details: `Wallet credited $${amount}: ${reason}`,
        },
      })
    })

    revalidatePath('/admin/businesses')
    revalidatePath(`/admin/businesses/${businessId}`)
    redirect(`/admin/businesses/${businessId}?success=wallet_credited`)
  } catch (error) {
    console.error('Wallet credit error:', error)
    redirect(`/admin/businesses/${businessId}?error=wallet_action_failed`)
  }
}

export async function adminDebitWallet(formData: FormData) {
  const session = await getServerSession(authOptions)

  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    redirect('/login')
  }

  const businessId = formData.get('businessId') as string
  const amount = parseFloat(formData.get('amount') as string)
  const reason = (formData.get('reason') as string)?.trim()

  if (!businessId || isNaN(amount) || amount <= 0) {
    redirect(`/admin/businesses/${businessId}?error=invalid_amount`)
  }

  if (!reason) {
    redirect(`/admin/businesses/${businessId}?error=missing_reason`)
  }

  try {
    await prisma.$transaction(async (tx) => {
      const business = await tx.business.findUnique({
        where: { id: businessId },
        select: { walletBalance: true },
      })

      if (!business || Number(business.walletBalance) < amount) {
        throw new Error('Insufficient balance')
      }

      await tx.business.update({
        where: { id: businessId },
        data: { walletBalance: { decrement: amount } },
      })

      await tx.walletTransaction.create({
        data: {
          businessId,
          amount: -amount,
          type: 'DEBIT',
          description: reason,
        },
      })

      await tx.auditLog.create({
        data: {
          userId: session.user.id,
          action: 'DEBIT',
          entity: 'Business',
          entityId: businessId,
          details: `Wallet debited $${amount}: ${reason}`,
        },
      })
    })

    revalidatePath('/admin/businesses')
    revalidatePath(`/admin/businesses/${businessId}`)
    redirect(`/admin/businesses/${businessId}?success=wallet_debited`)
  } catch (error) {
    console.error('Wallet debit error:', error)
    redirect(`/admin/businesses/${businessId}?error=insufficient_balance`)
  }
}
