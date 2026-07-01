'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { handleServerActionError, handlePrismaError } from '@/lib/errors/handle-prisma-error'

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
  } catch (error: any) {
    handleServerActionError(error, '/business/wallet', 'topup_failed')
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

  if (!businessId) {
    redirect('/admin/businesses?error=invalid_business')
  }

  if (isNaN(amount) || amount <= 0) {
    redirect(`/admin/businesses/${businessId}?error=invalid_amount`)
  }

  if (!reason) {
    redirect(`/admin/businesses/${businessId}?error=missing_reason`)
  }

  try {
    // Verify business exists before transaction
    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { id: true } })
    if (!business) {
      redirect(`/admin/businesses?error=not_found`)
    }

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
  } catch (error: any) {
    if (error?.digest?.startsWith('NEXT_REDIRECT')) throw error
    const errMsg = error?.message || ''
    if (errMsg.includes('Insufficient') || errMsg.includes('balance')) {
      redirect(`/admin/businesses/${businessId}?error=insufficient_balance`)
    }
    if (errMsg.includes('not found') || errMsg.includes('Record to update not found')) {
      redirect(`/admin/businesses?error=not_found`)
    }
    if (errMsg.includes('timeout') || errMsg.includes('Connection')) {
      redirect(`/admin/businesses/${businessId}?error=database_error`)
    }
    handleServerActionError(error, `/admin/businesses/${businessId}`, 'wallet_action_failed')
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

  if (!businessId) {
    redirect('/admin/businesses?error=invalid_business')
  }

  if (isNaN(amount) || amount <= 0) {
    redirect(`/admin/businesses/${businessId}?error=invalid_amount`)
  }

  if (!reason) {
    redirect(`/admin/businesses/${businessId}?error=missing_reason`)
  }

  try {
    // Verify business exists before transaction
    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { id: true } })
    if (!business) {
      redirect(`/admin/businesses?error=not_found`)
    }

    await prisma.$transaction(async (tx) => {
      const biz = await tx.business.findUnique({
        where: { id: businessId },
        select: { walletBalance: true },
      })

      if (!biz || Number(biz.walletBalance) < amount) {
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
  } catch (error: any) {
    if (error?.digest?.startsWith('NEXT_REDIRECT')) throw error
    if (error?.message?.includes('Insufficient balance')) {
      redirect(`/admin/businesses/${businessId}?error=insufficient_balance`)
    }
    if (error?.message?.includes('not found') || error?.message?.includes('Record to update not found')) {
      redirect(`/admin/businesses?error=not_found`)
    }
    if (error?.message?.includes('timeout') || error?.message?.includes('Connection')) {
      redirect(`/admin/businesses/${businessId}?error=database_error`)
    }
    handleServerActionError(error, `/admin/businesses/${businessId}`, 'debit_failed')
  }
}
