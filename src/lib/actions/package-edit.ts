'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

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

  const updateData: any = {}
  if (data.costPrice !== undefined) updateData.costPrice = data.costPrice
  if (data.sellingPrice !== undefined) updateData.sellingPrice = data.sellingPrice
  if (data.sellingCurrency !== undefined) updateData.sellingCurrency = data.sellingCurrency
  if (data.markupPercent !== undefined) updateData.markupPercent = data.markupPercent
  if (data.pricingMode !== undefined) updateData.pricingMode = data.pricingMode
  if (data.publishStatus !== undefined) updateData.publishStatus = data.publishStatus
  if (data.configurationStatus !== undefined) { updateData.configurationStatus = data.configurationStatus; updateData.lastConfiguredAt = new Date() }
  if (data.notes !== undefined) updateData.notes = data.notes

  if (Object.keys(updateData).length === 0) return { success: false, error: 'No fields to update' }

  await prisma.providerPackage.update({ where: { id: packageId }, data: updateData })
  revalidatePath('/admin/provider-catalog')
  return { success: true }
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
