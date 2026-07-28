'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { runCatalogAutomation } from '@/lib/catalog/catalog-automation'
import type { AutomationResult } from '@/lib/catalog/catalog-automation'

export async function triggerCatalogAutomation(
  providerId?: string,
): Promise<{ success: boolean; data?: AutomationResult; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  const where: any = { isAvailable: true }
  if (providerId) where.providerId = providerId

  const packages = await prisma.providerPackage.findMany({
    where,
    include: { provider: { select: { id: true, name: true, code: true, status: true } } },
  })

  const inputs = packages.map(pp => ({
    packageId: pp.id,
    packageName: pp.name,
    providerId: pp.providerId,
    providerName: pp.provider.name,
    providerCode: pp.provider.code,
    before: null, // No previous snapshot stored in this phase — treated as NEW
    after: {
      cost: parseFloat(pp.costPrice.toString()),
      data: pp.dataGB,
      validity: pp.validityDays,
      country: pp.country || undefined,
      name: pp.name,
    },
    hasPricing: !!(pp.sellingPrice && parseFloat(pp.sellingPrice.toString()) > 0),
    isPublished: pp.publishStatus === 'PUBLISHED',
  }))

  const result = runCatalogAutomation(inputs)
  return { success: true, data: result }
}
