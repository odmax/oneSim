'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

export async function resetPricing(packageIds: string[]): Promise<{ success: boolean; updated?: number; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  if (!packageIds || packageIds.length === 0) return { success: false, error: 'No packages selected' }

  await prisma.providerPackage.updateMany({
    where: { id: { in: packageIds } },
    data: {
      sellingPrice: null,
      sellingCurrency: 'USD',
      markupPercent: null,
      pricingMode: 'MARKUP_PERCENT',
      publishStatus: 'DRAFT',
      configurationStatus: 'UNCONFIGURED',
      autoConfiguredByRuleId: null,
      lastConfiguredAt: null,
    },
  })

  await prisma.auditLog.create({ data: { userId: session.user.id, action: 'PRICING_RESET', entity: 'ProviderPackage', details: `Reset pricing for ${packageIds.length} packages` } }).catch(() => {})

  revalidatePath('/admin/provider-catalog')
  return { success: true, updated: packageIds.length }
}
