'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

export interface BulkConfigureParams {
  packageIds: string[]
  markupPercent?: number
  pricingMode?: string
  sellingCurrency?: string
  publishStatus?: string
  configurationStatus?: string
  tags?: string[]
  notes?: string
}

export async function bulkConfigurePackages(params: BulkConfigureParams): Promise<{ success: boolean; updated?: number; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, error: 'Unauthorized' }
  }

  const { packageIds, ...configUpdates } = params

  if (!packageIds || packageIds.length === 0) {
    return { success: false, error: 'No packages selected' }
  }

  const updateData: any = {}

  if (configUpdates.markupPercent != null) {
    updateData.markupPercent = configUpdates.markupPercent
  }
  if (configUpdates.pricingMode) {
    updateData.pricingMode = configUpdates.pricingMode
  }
  if (configUpdates.sellingCurrency) {
    updateData.sellingCurrency = configUpdates.sellingCurrency
  }
  if (configUpdates.publishStatus) {
    updateData.publishStatus = configUpdates.publishStatus
  }
  if (configUpdates.configurationStatus) {
    updateData.configurationStatus = configUpdates.configurationStatus
    updateData.lastConfiguredAt = new Date()
  }
  if (configUpdates.notes != null) {
    updateData.notes = configUpdates.notes
  }
  if (configUpdates.tags && configUpdates.tags.length > 0) {
    updateData.tags = configUpdates.tags
  }

  if (Object.keys(updateData).length === 0) {
    return { success: false, error: 'No configuration options provided' }
  }

  try {
    const result = await prisma.providerPackage.updateMany({
      where: { id: { in: packageIds } },
      data: updateData,
    })

    await prisma.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'BULK_CONFIGURE_PACKAGES',
        entity: 'ProviderPackage',
        details: `Bulk configured ${result.count} packages: ${Object.keys(updateData).join(', ')}`,
      },
    }).catch(() => {})

    revalidatePath('/admin/provider-catalog')
    return { success: true, updated: result.count }
  } catch (e: any) {
    return { success: false, error: e.message || 'Bulk configuration failed' }
  }
}
