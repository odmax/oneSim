'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { Prisma } from '@prisma/client'
import { syncProviderPackageToPublishedProducts, revalidateCatalogRoutes, recordCatalogPriceSyncAudit } from '@/lib/services/catalog-price-sync'

export async function resetPricing(packageIds: string[]): Promise<{ success: boolean; updated?: number; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  if (!packageIds || packageIds.length === 0) return { success: false, error: 'No packages selected' }

  try {
    const beforePackages = await prisma.providerPackage.findMany({
      where: { id: { in: packageIds } },
      select: { id: true, name: true, dataGB: true, validityDays: true, costPrice: true, currency: true, sellingPrice: true, sellingCurrency: true, markupPercent: true, providerPlanId: true, providerId: true, publishStatus: true },
    })

    await prisma.$transaction(async (tx) => {
      await tx.providerPackage.updateMany({
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
          tags: Prisma.JsonNull,
          notes: null,
          isPreferred: false,
          preferredReason: null,
          preferredAt: null,
          excludedFromAutoPick: false,
          autoPickReason: null,
        },
      })

      for (const bp of beforePackages) {
        const merged = {
          ...bp,
          sellingPrice: null,
          sellingCurrency: 'USD',
          markupPercent: null,
          publishStatus: 'DRAFT',
        }
        await syncProviderPackageToPublishedProducts(tx, merged as any)
      }
    })

    await prisma.auditLog.create({ data: { userId: session.user.id, action: 'RESET_TO_FACTORY', entity: 'ProviderPackage', details: `Reset ${packageIds.length} packages to factory defaults` } }).catch(() => {})

    await revalidateCatalogRoutes()
    return { success: true, updated: packageIds.length }
  } catch (error: any) {
    return { success: false, error: error.message || 'Reset pricing failed' }
  }
}