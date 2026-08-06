'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { syncProviderPackageToPublishedProducts, revalidateCatalogRoutes, recordCatalogPriceSyncAudit } from '@/lib/services/catalog-price-sync'
import { publishProviderPackageToRetailCatalog } from '@/lib/services/catalog/publish-to-retail'

export async function updateSinglePackage(packageId: string, data: {
  costPrice?: number
  sellingPrice?: number
  sellingCurrency?: string
  markupPercent?: number
  pricingMode?: string
  publishStatus?: string
  configurationStatus?: string
  notes?: string
}): Promise<{ success: boolean; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  // Route PUBLISHED through canonical publish service
  if (data.publishStatus === 'PUBLISHED') {
    const result = await publishProviderPackageToRetailCatalog(packageId, { reason: 'MANUAL_EDIT' })
    if (!result.success) return { success: false, error: result.error || 'Publish failed' }
    await revalidateCatalogRoutes()
    return { success: true }
  }

  try {
    const { updated, before } = await prisma.$transaction(async (tx) => {
      const before = await tx.providerPackage.findUnique({ where: { id: packageId } })
      if (!before) throw new Error('Package not found')

      const updateData: any = {}
      if (data.costPrice !== undefined) updateData.costPrice = data.costPrice
      if (data.sellingPrice !== undefined) updateData.sellingPrice = data.sellingPrice
      if (data.sellingCurrency !== undefined) updateData.sellingCurrency = data.sellingCurrency
      if (data.markupPercent !== undefined) updateData.markupPercent = data.markupPercent
      if (data.pricingMode !== undefined) updateData.pricingMode = data.pricingMode
      if (data.publishStatus !== undefined && data.publishStatus !== 'PUBLISHED') updateData.publishStatus = data.publishStatus
      if (data.configurationStatus !== undefined) { updateData.configurationStatus = data.configurationStatus; updateData.lastConfiguredAt = new Date() }
      if (data.notes !== undefined) updateData.notes = data.notes

      if (Object.keys(updateData).length === 0) throw new Error('No fields to update')

      const updated = await tx.providerPackage.update({ where: { id: packageId }, data: updateData })

      await syncProviderPackageToPublishedProducts(tx, updated)

      return { updated, before }
    })

    await recordCatalogPriceSyncAudit(
      'MANUAL_EDIT',
      packageId,
      { matchedProducts: 1, updatedProducts: 1, skippedProducts: 0, productIds: [], oldSellingPrice: before.sellingPrice?.toString() ?? null, newSellingPrice: updated.sellingPrice?.toString() ?? null, oldMarkup: before.markupPercent?.toString() ?? null, newMarkup: updated.markupPercent?.toString() ?? null, status: 'SYNCED' },
      before.sellingPrice?.toString() ?? null,
      updated.sellingPrice?.toString() ?? null,
      before.markupPercent?.toString() ?? null,
      updated.markupPercent?.toString() ?? null,
    )

    await revalidateCatalogRoutes()
    return { success: true }
  } catch (e: any) {
    if (e.message === 'Package not found' || e.message === 'No fields to update') {
      return { success: false, error: e.message }
    }
    return { success: false, error: e.message || 'Update failed' }
  }
}

export async function undoLastRules(): Promise<{ success: boolean; rolledBack?: number; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  const lastRules = await prisma.catalogChangeSet.findFirst({
    where: { actionType: 'RULES_APPLIED' },
    orderBy: { createdAt: 'desc' },
  })

  if (!lastRules) return { success: false, error: 'No rules application found in history' }

  const { rollbackChangeSet } = await import('./catalog-history')
  return rollbackChangeSet(lastRules.id)
}