'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'

export interface ProviderDependencies {
  packages: number
  purchases: number
  esims: number
  pricingRules: number
  total: number
  hasDependencies: boolean
}

export async function getProviderDependencies(providerId: string): Promise<ProviderDependencies> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { packages: 0, purchases: 0, esims: 0, pricingRules: 0, total: 0, hasDependencies: false }
  }

  const [packages] = await Promise.all([
    prisma.eSIMPackage.count({ where: { providerId } }),
  ])
  const pricingRules = 0

  const packageIds = await prisma.eSIMPackage.findMany({
    where: { providerId },
    select: { id: true },
  })
  const pkgIds = packageIds.map(p => p.id)

  const [purchases, esims] = await Promise.all([
    pkgIds.length > 0
      ? prisma.eSIMPurchase.count({ where: { packageId: { in: pkgIds } } })
      : Promise.resolve(0),
    pkgIds.length > 0
      ? prisma.eSIM.count({ where: { purchase: { packageId: { in: pkgIds } } } })
      : Promise.resolve(0),
  ])

  const total = packages + purchases + esims + pricingRules
  return { packages, purchases, esims, pricingRules, total, hasDependencies: total > 0 }
}

export async function archiveProvider(providerId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, error: 'Unauthorized' }
  }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { success: false, error: 'Provider not found' }

  if (provider.status === 'ARCHIVED') {
    return { success: false, error: 'Provider is already archived' }
  }

  const deps = await getProviderDependencies(providerId)

  if (provider.isDefaultFallback) {
    await prisma.provider.updateMany({
      where: { isDefaultFallback: true, id: { not: providerId } },
      data: { isDefaultFallback: false },
    })
  }

  await prisma.provider.update({
    where: { id: providerId },
    data: {
      status: 'ARCHIVED' as any,
      isDefaultFallback: false,
    },
  })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'PROVIDER_ARCHIVED',
      entity: 'Provider',
      entityId: provider.code,
      details: `Provider "${provider.name}" archived. Linked records preserved: ${deps.packages} packages, ${deps.purchases} purchases, ${deps.esims} eSIMs, ${deps.pricingRules} pricing rules.`,
    },
  })

  revalidatePath('/admin/providers')
  revalidatePath(`/admin/providers/${providerId}`)
  return { success: true, message: `Provider "${provider.name}" archived. All historical records preserved.`, dependencies: deps }
}

export async function resetProviderConfiguration(providerId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, error: 'Unauthorized' }
  }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { success: false, error: 'Provider not found' }

  await prisma.provider.update({
    where: { id: providerId },
    data: {
      apiToken: null,
      apiBaseUrl: null,
      authUrl: null,
      config: {},
      lastSuccessfulConnection: null,
      lastFailedConnection: null,
      activationSuccessRate: null,
      averageActivationTimeMs: null,
      errorCount: null,
      lastError: null,
      lastSyncAt: null,
      lastSyncResult: null,
    },
  })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'PROVIDER_CONFIG_RESET',
      entity: 'Provider',
      entityId: provider.code,
      details: `Provider "${provider.name}" configuration reset by ${session.user.email}`,
    },
  })

  revalidatePath('/admin/providers')
  revalidatePath(`/admin/providers/${providerId}`)
  return { success: true, message: `Provider "${provider.name}" configuration has been reset. Re-authenticate to rebuild the integration.` }
}

export async function hardDeleteProvider(providerId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, error: 'Unauthorized' }
  }

  if (session.user.internalAdminRole !== 'SUPER_ADMIN') {
    return { success: false, error: 'Only SUPER_ADMIN can hard-delete providers' }
  }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { success: false, error: 'Provider not found' }

  const deps = await getProviderDependencies(providerId)
  if (deps.hasDependencies) {
    return {
      success: false,
      error: `Cannot hard-delete provider with ${deps.total} linked records. Archive instead to preserve historical data.`,
      dependencies: deps,
    }
  }

  await prisma.provider.delete({ where: { id: providerId } })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'PROVIDER_HARD_DELETED',
      entity: 'Provider',
      entityId: provider.code,
      details: `Provider "${provider.name}" permanently deleted by SUPER_ADMIN ${session.user.email}`,
    },
  })

  revalidatePath('/admin/providers')
  return { success: true, message: `Provider "${provider.name}" permanently deleted.` }
}
