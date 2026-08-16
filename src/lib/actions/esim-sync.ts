'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getAdapterForProvider } from '@/lib/providers/adapter-manager'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'

async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')
  return session.user.id
}

export async function syncEsimStatus(esimId: string) {
  const userId = await requireAdmin()
  const esim = await prisma.eSIM.findUnique({
    where: { id: esimId },
    include: { purchase: { include: { package: true } } },
  })
  if (!esim) return { success: false, error: 'eSIM not found' }

  if (!esim.providerActivationId) {
    return { success: false, error: 'No provider activation ID' }
  }

  const providerId = esim.purchase.package.providerId
  if (!providerId) return { success: false, error: 'No linked provider' }

  const adapter = await getAdapterForProvider(providerId)
  if (!adapter) return { success: false, error: 'Provider not available' }

  // Provider-neutral, SAFE identifier — Choice gets the structured package_detail
  // lookup; string connectors get their provider reference. A local OneSIM id is
  // never sent upstream, and we skip when no safe identifier exists.
  const lookup = adapter.resolveStatusLookup?.(esim)
    ?? (esim.providerSubscriptionId || esim.providerActivationId || esim.iccid || null)
  if (!lookup) return { success: false, error: 'No provider identifier available for status lookup' }

  const result = await adapter.getActivationStatus(lookup)
  if (!result.success) return { success: false, error: result.error?.message }

  await prisma.eSIM.update({
    where: { id: esimId },
    data: {
      providerStatus: result.data?.status,
      status: result.data?.status === 'ACTIVE' ? 'ACTIVE' : esim.status,
      lastSyncAt: new Date(),
      providerResponse: result.data,
    },
  })

  revalidatePath(`/admin/esims/${esimId}`)
  revalidatePath('/admin/esims')
  return { success: true, data: result.data }
}

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
