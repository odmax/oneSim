'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

const TRACKED_FIELDS = ['sellingPrice','sellingCurrency','markupPercent','pricingMode','publishStatus','configurationStatus','tags','notes','isPreferred','preferredReason','preferredAt','excludedFromAutoPick','autoPickReason']

export async function recordChangeSet(actionType: string, packageIds: string[], description?: string) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'INTERNAL_ADMIN') return null

    const packages = await prisma.providerPackage.findMany({ where: { id: { in: packageIds } } })
    if (packages.length === 0) return null

    const changeSet = await prisma.catalogChangeSet.create({
      data: { actionType, description: description || null, createdById: session.user.id, totalChanged: packages.length },
    })

    const items = packages.map(pkg => {
      const before: any = {}
      const after: any = {}
      for (const f of TRACKED_FIELDS) {
        before[f] = (pkg as any)[f] ?? null
        after[f] = (pkg as any)[f] ?? null
      }
      return { changeSetId: changeSet.id, providerPackageId: pkg.id, before, after }
    })

    await prisma.catalogChangeItem.createMany({ data: items })
    return changeSet.id
  } catch { return null }
}

export async function getChangeHistory(page: number = 1) {
  const limit = 25
  const [sets, total] = await Promise.all([
    prisma.catalogChangeSet.findMany({ include: { createdBy: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.catalogChangeSet.count(),
  ])
  return { sets, total, page, totalPages: Math.ceil(total / limit), limit }
}

export async function getChangeSetDetails(changeSetId: string) {
  return prisma.catalogChangeSet.findUnique({
    where: { id: changeSetId },
    include: {
      createdBy: { select: { name: true } },
      items: { include: { pkg: { select: { name: true, providerPlanId: true, dataGB: true, validityDays: true, provider: { select: { name: true } } } } }, orderBy: { createdAt: 'asc' } },
    },
  })
}

export async function rollbackChangeSet(changeSetId: string): Promise<{ success: boolean; rolledBack?: number; skipped?: number; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  const changeSet = await prisma.catalogChangeSet.findUnique({ where: { id: changeSetId }, include: { items: true } })
  if (!changeSet) return { success: false, error: 'Change set not found' }
  if (changeSet.actionType === 'ROLLBACK') return { success: false, error: 'Cannot rollback a rollback' }

  let rolledBack = 0
  let skipped = 0

  for (const item of changeSet.items) {
    const before = (item.before || {}) as Record<string, any>
    const updateData: any = {}
    for (const f of TRACKED_FIELDS) {
      if (before[f] !== undefined) updateData[f] = before[f]
    }
    if (Object.keys(updateData).length > 0) {
      try {
        await prisma.providerPackage.update({ where: { id: item.providerPackageId }, data: updateData })
        rolledBack++
      } catch { skipped++ }
    } else { skipped++ }
  }

  await prisma.catalogChangeSet.create({
    data: { actionType: 'ROLLBACK', description: `Rollback of ${changeSet.actionType}`, createdById: session.user.id, totalChanged: rolledBack, metadata: { originalChangeSetId: changeSetId } },
  })

  await prisma.auditLog.create({ data: { userId: session.user.id, action: 'CATALOG_ROLLBACK', entity: 'CatalogChangeSet', entityId: changeSetId, details: `Rolled back ${rolledBack} packages, skipped ${skipped}` } }).catch(() => {})

  revalidatePath('/admin/provider-catalog')
  revalidatePath('/admin/provider-catalog/history')
  return { success: true, rolledBack, skipped }
}
