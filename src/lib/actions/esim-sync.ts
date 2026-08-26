'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getAdapterForProvider } from '@/lib/providers/adapter-manager'

export async function syncEsimUsage(esimId: string) {
  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: { purchase: { include: { package: true } } },
  })
  if (!esim) return { success: false, error: 'eSIM not found' }

  const providerId = esim.purchase.package.providerId
  if (!providerId) return { success: false, error: 'No linked provider' }

  // Route through the SAME canonical usage sync service as background jobs and
  // the client refresh — never a separate direct-provider fetch path (Part 7).
  const { syncESIMUsage } = await import('@/lib/services/usage/sync-usage')
  const result = await syncESIMUsage(esimId)

  if (result.success && result.skipped) {
    return { success: false, error: result.skipReason === 'CAPABILITY_NOT_SUPPORTED' ? 'Usage not supported by provider' : (result.skipReason || 'Usage unavailable') }
  }
  if (!result.success) return { success: false, error: result.error || 'Usage sync failed' }

  revalidatePath(`/admin/esims/${esimId}`)
  return { success: true, data: result }
}

export async function getQrCode(esimId: string) {
  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: { purchase: { include: { package: true } } },
  })
  if (!esim) return { success: false, error: 'eSIM not found' }

  if (esim.qrCodeUrl) return { success: true, data: { qrCodeUrl: esim.qrCodeUrl } }

  const providerId = esim.purchase.package.providerId
  if (!providerId) return { success: false, error: 'No linked provider' }

  const adapter = await getAdapterForProvider(providerId)
  if (!adapter) return { success: false, error: 'Provider not available' }

  const result = await adapter.getQRCode(esim.iccid)
  if (!result.success) return { success: false, error: result.error?.message }

  if (result.data?.qrCodeUrl) {
    await prisma.eSIM.update({
      where: { id: esimId },
      data: { qrCodeUrl: result.data.qrCodeUrl, installationStatus: 'READY', installationLastCheckedAt: new Date() },
    })
  } else if (result.success) {
    // activationCode found but no QR URL
    await prisma.eSIM.update({
      where: { id: esimId },
      data: { installationStatus: 'READY', installationLastCheckedAt: new Date() },
    })
  }

  revalidatePath(`/admin/esims/${esimId}`)
  return result
}

export async function refreshEsimQrCodeAction(esimId: string) {
  const { getServerSession } = await import('next-auth')
  const { authOptions } = await import('@/lib/auth/config')
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'BUSINESS_USER') {
    return { success: false, error: 'Unauthorized' }
  }

  const businessId = session.user.businessId
  if (!businessId) {
    return { success: false, error: 'No business associated with this account' }
  }

  const { refreshEsimQrCode } = await import('@/lib/services/esims/refresh-qr')
  const result = await refreshEsimQrCode({ esimId, businessId, requestedBy: session.user.id })

  if (result.success) {
    revalidatePath(`/business/esims/${esimId}`)
  }

  return result
}
