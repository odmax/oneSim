'use server'

import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { refreshEsimStatus, refreshEsimUsage, topUpEsimWithWallet } from '@/lib/services/esims/esim-service'
import { prisma } from '@/lib/prisma'

export async function refreshEsimStatusAction(esimId: string) {
  const session = await getServerSession(authOptions)
  if (!session) redirect('/login')

  const result = await refreshEsimStatus(esimId)

  revalidatePath(`/admin/esims/${esimId}`)
  revalidatePath('/admin/esims')
  revalidatePath(`/business/esims`)

  return result
}

export async function refreshEsimUsageAction(esimId: string) {
  const session = await getServerSession(authOptions)
  if (!session) redirect('/login')

  const result = await refreshEsimUsage(esimId)

  revalidatePath(`/admin/esims/${esimId}`)
  revalidatePath(`/admin/esims/${esimId}/usage`)
  revalidatePath('/admin/esims')
  revalidatePath(`/business/esims`)
  revalidatePath(`/admin/orders`)
  revalidatePath(`/business/esims`)

  return result
}

export async function businessTopUpEsim(formData: FormData) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') redirect('/login')

  const esimId = formData.get('esimId') as string
  const packageId = formData.get('packageId') as string
  const quantity = parseInt(formData.get('quantity') as string) || 1

  if (!esimId || !packageId) redirect(`/business/esims?error=missing_params`)

  const result = await topUpEsimWithWallet(esimId, session.user.businessId!, session.user.id, packageId, quantity)

  if (result.success) {
    revalidatePath('/business/esims')
    revalidatePath('/business/wallet')
    revalidatePath('/business/dashboard')
    redirect(`/business/esims?success=topup_completed`)
  } else {
    let msg = 'topup_failed'
    if (result.error?.includes('wallet') || result.error?.includes('Insufficient')) msg = 'insufficient_balance'
    redirect(`/business/esims?error=${msg}`)
  }
}

export async function adminTopUpEsim(esimId: string, packageId: string, businessId: string, userId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  return await topUpEsimWithWallet(esimId, businessId, userId, packageId)
}

export async function getEsimForAdmin(esimId: string) {
  return await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: {
      purchase: { include: { business: true, package: true } },
      customer: true,
      usageRecords: { orderBy: { timestamp: 'desc' }, take: 20 },
    },
  })
}
