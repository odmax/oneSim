'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { testProviderConnection } from './providers'
import { syncProviderPlans } from './provider-sync'

export async function getActiveProviders() {
  return prisma.provider.findMany({
    where: { status: 'ACTIVE' },
    orderBy: { name: 'asc' },
  })
}

export async function getDefaultProviderId(): Promise<string | null> {
  const setting = await prisma.setting.findUnique({
    where: { key: 'default_esim_provider_id' },
  })
  return setting?.value || null
}

export async function setDefaultProvider(providerId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, error: 'Unauthorized' }
  }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) {
    return { success: false, error: 'Provider not found' }
  }

  // Also set isDefaultFallback on the new provider and clear it on the old one
  await prisma.provider.updateMany({
    where: { isDefaultFallback: true },
    data: { isDefaultFallback: false },
  })
  await prisma.provider.update({
    where: { id: providerId },
    data: { isDefaultFallback: true },
  })

  await prisma.setting.upsert({
    where: { key: 'default_esim_provider_id' },
    update: { value: providerId },
    create: { key: 'default_esim_provider_id', value: providerId },
  })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'DEFAULT_PROVIDER_UPDATED',
      entity: 'Setting',
      entityId: 'default_esim_provider_id',
      details: `Default fallback provider set to "${provider.name}" (${provider.code})`,
    },
  })

  revalidatePath('/admin/settings')
  return { success: true, message: `Default fallback provider set to "${provider.name}"` }
}

export async function testDefaultProviderConnection() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, error: 'Unauthorized' }
  }

  const providerId = await getDefaultProviderId()
  if (!providerId) {
    return { success: false, error: 'No default provider selected.' }
  }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) {
    return { success: false, error: 'Default provider not found in database.' }
  }

  if (provider.status !== 'ACTIVE') {
    await prisma.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'DEFAULT_PROVIDER_TESTED_FAILED',
        entity: 'Provider',
        entityId: provider.code,
        details: `Default provider "${provider.name}" test skipped: provider is inactive`,
      },
    })
    return { success: false, error: `Selected provider "${provider.name}" is inactive.` }
  }

  const result = await testProviderConnection(providerId)

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: result.success ? 'DEFAULT_PROVIDER_TESTED_SUCCESS' : 'DEFAULT_PROVIDER_TESTED_FAILED',
      entity: 'Provider',
      entityId: provider.code,
      details: result.success
        ? `Default provider "${provider.name}" connection test: ${result.message}`
        : `Default provider "${provider.name}" connection test failed: ${result.error}`,
    },
  })

  return result
}

export async function syncPlansFromDefaultProvider() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, error: 'Unauthorized' }
  }

  const providerId = await getDefaultProviderId()
  if (!providerId) {
    return { success: false, error: 'No default provider selected.' }
  }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) {
    return { success: false, error: 'Default provider not found in database.' }
  }

  if (provider.status !== 'ACTIVE') {
    return { success: false, error: `Default provider "${provider.name}" is inactive.` }
  }

  return syncProviderPlans(providerId)
}
