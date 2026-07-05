'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

export async function autoPickAndPublishWinners() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return

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

    const canPublish = winner.sellingPrice && parseFloat(winner.sellingPrice.toString()) > 0
      && winner.sellingCurrency
      && (winner.configurationStatus === 'CONFIGURED' || winner.configurationStatus === 'AUTO_CONFIGURED')

    if (!canPublish) {
      skipped++
      skippedReasons.push(`${winner.name}: missing price or not configured`)
      // Still hide non-preferred
      await prisma.providerPackage.updateMany({ where: { id: { in: others.map(p => p.id) } }, data: { publishStatus: 'HIDDEN' } })
      continue
    }

    // Publish the winner
    const sellPrice = parseFloat((winner.sellingPrice ?? 0).toString())
    const existing = await prisma.eSIMPackage.findFirst({ where: { providerPackageId: winner.id } })
    if (existing) {
      await prisma.eSIMPackage.update({ where: { id: existing.id }, data: { priceUSD: sellPrice, localPrice: sellPrice, currency: winner.sellingCurrency || 'USD', isActive: true } })
    } else {
      await prisma.eSIMPackage.create({
        data: {
          name: winner.name, displayName: winner.name, dataGB: winner.dataGB, validityDays: winner.validityDays,
          priceUSD: sellPrice, localPrice: sellPrice, currency: winner.sellingCurrency || 'USD',
          providerName: winner.provider?.name || null, providerPlanId: winner.providerPlanId,
          providerId: winner.providerId, sku: winner.providerPlanCode || undefined,
          packageCode: winner.providerPlanCode || undefined, costPriceUSD: winner.costPrice,
          costCurrency: winner.currency, markupPercent: winner.markupPercent ? parseFloat(winner.markupPercent.toString()) : null,
          source: 'CATALOG_PRODUCT', isActive: true, providerPackageId: winner.id,
        },
      })
    }
    await prisma.providerPackage.update({ where: { id: winner.id }, data: { publishStatus: 'PUBLISHED' } })
    // Hide the non-preferred
    await prisma.providerPackage.updateMany({ where: { id: { in: others.map(p => p.id) } }, data: { publishStatus: 'HIDDEN' } })
    published++
  }

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'AUTO_PICK_AND_PUBLISH_WINNERS', entity: 'ProviderPackage',
      details: `Published ${published}, skipped ${skipped} out of ${duplicates.length} groups` },
  }).catch(() => {})

  revalidatePath('/admin/provider-catalog/health')
  revalidatePath('/admin/provider-catalog')
  revalidatePath('/admin/packages')

  // Return summary for UI
  return { success: true, published, skipped, skippedReasons: skippedReasons.slice(0, 10) }
}

export async function publishPreferredOnly() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return
  const preferred = await prisma.providerPackage.findMany({ where: { isPreferred: true, publishStatus: { notIn: ['PUBLISHED', 'ARCHIVED', 'HIDDEN'] } } })

  let published = 0
  for (const pp of preferred) {
    const sellPrice = pp.sellingPrice ? parseFloat(pp.sellingPrice.toString()) : null
    if (!sellPrice || sellPrice <= 0 || !pp.sellingCurrency) continue
    if (pp.configurationStatus !== 'CONFIGURED' && pp.configurationStatus !== 'AUTO_CONFIGURED') continue

    const existing = await prisma.eSIMPackage.findFirst({ where: { providerPackageId: pp.id } })
    if (existing) {
      await prisma.eSIMPackage.update({ where: { id: existing.id }, data: { priceUSD: sellPrice, isActive: true } })
    } else {
      await prisma.eSIMPackage.create({
        data: {
          name: pp.name, displayName: pp.name, dataGB: pp.dataGB, validityDays: pp.validityDays,
          priceUSD: sellPrice, localPrice: sellPrice, currency: pp.sellingCurrency,
          providerName: null, providerPlanId: pp.providerPlanId,
          providerId: pp.providerId, source: 'CATALOG_PRODUCT', isActive: true, providerPackageId: pp.id,
        },
      })
    }
    await prisma.providerPackage.update({ where: { id: pp.id }, data: { publishStatus: 'PUBLISHED' } })
    published++
  }

  await prisma.auditLog.create({ data: { userId: session.user.id, action: 'PUBLISH_PREFERRED_PACKAGES', entity: 'ProviderPackage', details: `Published ${published} preferred packages` } }).catch(() => {})
  revalidatePath('/admin/provider-catalog/health')
  revalidatePath('/admin/provider-catalog')
  revalidatePath('/admin/packages')
  return { success: true, published }
}
