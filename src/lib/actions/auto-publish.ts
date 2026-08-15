'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { startPipelineRun, recordStageFromCounts, completePipelineRun, failPipelineRun } from '@/lib/catalog-pipeline'
import { publishProviderPackageToRetailCatalog } from '@/lib/services/catalog/publish-to-retail'
import { isPackagePublishEligible } from '@/lib/catalog/publish-eligibility'

export async function autoPickAndPublishWinners() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return
  const pipelineRunId = await startPipelineRun({ trigger: 'MANUAL' }).catch(() => '')
  const startTime = Date.now()
  try {

  // Find all duplicate groups
  const all = await prisma.providerPackage.findMany({
    where: { publishStatus: { not: 'ARCHIVED' } },
    include: { provider: { select: { id: true, name: true, catalogPriority: true, autoPublishEnabled: true } } },
  })

  const groups = new Map<string, typeof all>()
  for (const pkg of all) {
    const key = `${pkg.country || 'XX'}|${pkg.dataGB}|${pkg.validityDays}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(pkg)
  }

  const duplicates = Array.from(groups.entries()).filter(([, pkgs]) => pkgs.length > 1)
  let published = 0
  let skipped = 0
  let skippedReasons: string[] = []

  for (const [, pkgs] of duplicates) {
    const candidates = pkgs.filter(p => !p.excludedFromAutoPick && p.publishStatus !== 'ARCHIVED' && p.publishStatus !== 'HIDDEN')
    if (candidates.length < 2) continue

    // Tiebreak: cost > configured > published > catalogPriority > newest
    candidates.sort((a, b) => {
      const aCost = parseFloat(a.costPrice.toString())
      const bCost = parseFloat(b.costPrice.toString())
      if (aCost !== bCost) return aCost - bCost
      const aConf = (a.configurationStatus === 'CONFIGURED' || a.configurationStatus === 'AUTO_CONFIGURED') ? 1 : 0
      const bConf = (b.configurationStatus === 'CONFIGURED' || b.configurationStatus === 'AUTO_CONFIGURED') ? 1 : 0
      if (bConf !== aConf) return bConf - aConf
      const aPub = a.publishStatus === 'PUBLISHED' ? 1 : 0
      const bPub = b.publishStatus === 'PUBLISHED' ? 1 : 0
      if (bPub !== aPub) return bPub - aPub
      const aPri = a.provider?.catalogPriority ?? 100
      const bPri = b.provider?.catalogPriority ?? 100
      if (aPri !== bPri) return aPri - bPri
      return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()
    })

    const winner = candidates[0]
    await prisma.providerPackage.update({ where: { id: winner.id }, data: { isPreferred: true, preferredReason: 'Cheapest cost in duplicate group (auto-pick)', preferredAt: new Date() } })
    const others = candidates.filter(p => p.id !== winner.id)
    await prisma.providerPackage.updateMany({ where: { id: { in: others.map(p => p.id) } }, data: { isPreferred: false, autoPickReason: 'Not cheapest in duplicate group' } })

    // Auto-publish the winner if provider allows or admin overrides
    if (!winner.provider?.autoPublishEnabled) {
      skipped++
      skippedReasons.push(`${winner.name}: provider ${winner.provider?.name || 'unknown'} has autoPublishEnabled=false`)
      continue
    }

    const canPublish = winner.costPrice && parseFloat(winner.costPrice.toString()) > 0
      && winner.sellingPrice && parseFloat(winner.sellingPrice.toString()) > 0
      && winner.sellingCurrency
      && isPackagePublishEligible({ configurationStatus: winner.configurationStatus, publishStatus: winner.publishStatus })

    if (!canPublish) {
      skipped++
      skippedReasons.push(`${winner.name}: missing price or not configured`)
      // Still hide non-preferred
      await prisma.providerPackage.updateMany({ where: { id: { in: others.map(p => p.id) } }, data: { publishStatus: 'HIDDEN' } })
      continue
    }

    // Publish the winner — canonical service
    const result = await publishProviderPackageToRetailCatalog(winner.id, { reason: 'AUTO_PICK' })
    if (!result.success) {
      skipped++
      skippedReasons.push(`${winner.name}: publish failed — ${result.error}`)
      await prisma.providerPackage.updateMany({ where: { id: { in: others.map(p => p.id) } }, data: { publishStatus: 'HIDDEN' } })
      continue
    }
    // Hide the non-preferred
    await prisma.providerPackage.updateMany({ where: { id: { in: others.map(p => p.id) } }, data: { publishStatus: 'HIDDEN' } })
    published++
  }

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'AUTO_PICK_AND_PUBLISH_WINNERS', entity: 'ProviderPackage',
      details: `Published ${published}, skipped ${skipped} out of ${duplicates.length} groups` },
  }).catch(() => {})

  await recordStageFromCounts({
    pipelineRunId, stage: 'PUBLISH', startTime,
    total: duplicates.length, passed: published, failed: 0, skipped,
    metadata: { published, skipped, skippedReasons: skippedReasons.slice(0, 10) },
  })
  await completePipelineRun(pipelineRunId, skipped > 0 && published === 0 ? 'FAILED' : skipped > 0 ? 'PARTIAL' : 'SUCCESS', published)

  revalidatePath('/admin/provider-catalog/health')
  revalidatePath('/admin/provider-catalog')
  revalidatePath('/admin/packages')

  // Return summary for UI
  return { success: true, published, skipped, skippedReasons: skippedReasons.slice(0, 10) }
  } catch (error: any) {
    if (pipelineRunId) await failPipelineRun(pipelineRunId, error.message || 'Auto-pick + publish failed').catch(() => {})
    console.error('autoPickAndPublishWinners error:', error)
    return { success: false, published: 0, skipped: 0, error: error.message || 'Auto-pick + publish failed' }
  }
}

export async function publishPreferredOnly() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return
  try {
  const preferred = await prisma.providerPackage.findMany({ where: { isPreferred: true, publishStatus: { notIn: ['PUBLISHED', 'ARCHIVED', 'HIDDEN'] } } })

  let published = 0
  for (const pp of preferred) {
    const costPrice = pp.costPrice ? parseFloat(pp.costPrice.toString()) : null
    const sellPrice = pp.sellingPrice ? parseFloat(pp.sellingPrice.toString()) : null
    if (!costPrice || costPrice <= 0 || !sellPrice || sellPrice <= 0 || !pp.sellingCurrency) continue
    if (!isPackagePublishEligible({ configurationStatus: pp.configurationStatus, publishStatus: pp.publishStatus })) continue

    const result = await publishProviderPackageToRetailCatalog(pp.id, { reason: 'PREFERRED' })
    if (result.success) published++
  }

  await prisma.auditLog.create({ data: { userId: session.user.id, action: 'PUBLISH_PREFERRED_PACKAGES', entity: 'ProviderPackage', details: `Published ${published} preferred packages` } }).catch(() => {})
  revalidatePath('/admin/provider-catalog/health')
  revalidatePath('/admin/provider-catalog')
  revalidatePath('/admin/packages')
  return { success: true, published }
  } catch (error: any) {
    console.error('publishPreferredOnly error:', error)
    return { success: false, published: 0, error: error.message || 'Publish preferred failed' }
  }
}
