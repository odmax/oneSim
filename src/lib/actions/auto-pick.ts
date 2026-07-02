'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

export async function markPreferred(packageId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return
  await prisma.providerPackage.update({ where: { id: packageId }, data: { isPreferred: true, preferredReason: 'Manually selected', preferredAt: new Date() } })
  await prisma.auditLog.create({ data: { userId: session.user.id, action: 'PACKAGE_MARKED_PREFERRED', entity: 'ProviderPackage', entityId: packageId } }).catch(() => {})
  revalidatePath('/admin/provider-catalog/health')
  revalidatePath('/admin/provider-catalog')
}

export async function hideDuplicatesInGroup(groupKey: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return
  const [country, data, validity] = groupKey.split('|')
  const packages = await prisma.providerPackage.findMany({
    where: { country: country === 'XX' ? null : country, dataGB: parseInt(data), validityDays: parseInt(validity) },
  })
  const preferred = packages.find(p => p.isPreferred) || packages[0]
  const toHide = packages.filter(p => p.id !== preferred.id)
  if (toHide.length === 0) return
  await prisma.providerPackage.updateMany({ where: { id: { in: toHide.map(p => p.id) } }, data: { publishStatus: 'HIDDEN' } })
  await prisma.auditLog.create({ data: { userId: session.user.id, action: 'PACKAGE_HIDE_DUPLICATES', entity: 'ProviderPackage', details: `Hid ${toHide.length} duplicates in group ${groupKey}` } }).catch(() => {})
  revalidatePath('/admin/provider-catalog/health')
  revalidatePath('/admin/provider-catalog')
}

export async function autoPickCheapestForGroup(groupKey: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return
  const [country, data, validity] = groupKey.split('|')

  const packages = await prisma.providerPackage.findMany({
    where: {
      country: country === 'XX' ? null : country,
      dataGB: parseInt(data),
      validityDays: parseInt(validity),
      publishStatus: { not: 'ARCHIVED' },
    },
  })

  const candidates = packages.filter(p => !p.excludedFromAutoPick && p.publishStatus !== 'ARCHIVED')
  if (candidates.length < 2) return

  // Sort by: configured > published > provider priority > newest
  candidates.sort((a, b) => {
    const aConf = (a.configurationStatus === 'CONFIGURED' || a.configurationStatus === 'AUTO_CONFIGURED') ? 1 : 0
    const bConf = (b.configurationStatus === 'CONFIGURED' || b.configurationStatus === 'AUTO_CONFIGURED') ? 1 : 0
    if (bConf !== aConf) return bConf - aConf
    const aPub = a.publishStatus === 'PUBLISHED' ? 1 : 0
    const bPub = b.publishStatus === 'PUBLISHED' ? 1 : 0
    if (bPub !== aPub) return bPub - aPub
    const aCost = parseFloat(a.costPrice.toString())
    const bCost = parseFloat(b.costPrice.toString())
    return aCost - bCost
  })

  const chosen = candidates[0]
  await prisma.providerPackage.update({ where: { id: chosen.id }, data: { isPreferred: true, preferredReason: 'Cheapest cost in duplicate group', preferredAt: new Date() } })
  const others = candidates.filter(p => p.id !== chosen.id)
  await prisma.providerPackage.updateMany({ where: { id: { in: others.map(p => p.id) } }, data: { isPreferred: false, autoPickReason: 'Not cheapest in duplicate group' } })

  await prisma.auditLog.create({ data: { userId: session.user.id, action: 'PACKAGE_AUTO_PICK_CHEAPEST', entity: 'ProviderPackage', entityId: chosen.id, details: `Auto-picked cheapest from ${candidates.length} packages in group ${groupKey}` } }).catch(() => {})
  revalidatePath('/admin/provider-catalog/health')
  revalidatePath('/admin/provider-catalog')
}

export async function autoPickAllGroups() {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return

  const all = await prisma.providerPackage.findMany({ where: { publishStatus: { not: 'ARCHIVED' } } })
  const groups = new Map<string, typeof all>()
  for (const pkg of all) {
    const key = `${pkg.country || 'XX'}|${pkg.dataGB}|${pkg.validityDays}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(pkg)
  }

  const duplicates = Array.from(groups.entries()).filter(([, pkgs]) => pkgs.length > 1)
  let total = 0

  for (const [key, pkgs] of duplicates) {
    const candidates = pkgs.filter(p => !p.excludedFromAutoPick && p.publishStatus !== 'ARCHIVED')
    if (candidates.length < 2) continue
    candidates.sort((a, b) => parseFloat(a.costPrice.toString()) - parseFloat(b.costPrice.toString()))
    const chosen = candidates[0]
    await prisma.providerPackage.update({ where: { id: chosen.id }, data: { isPreferred: true, preferredReason: 'Cheapest cost in duplicate group', preferredAt: new Date() } })
    await prisma.providerPackage.updateMany({ where: { id: { in: candidates.filter(p => p.id !== chosen.id).map(p => p.id) } }, data: { isPreferred: false, autoPickReason: 'Not cheapest in duplicate group' } })
    total++
  }

  await prisma.auditLog.create({ data: { userId: session.user.id, action: 'PACKAGE_AUTO_PICK_CHEAPEST', entity: 'ProviderPackage', details: `Auto-picked cheapest for ${total} duplicate groups` } }).catch(() => {})
  revalidatePath('/admin/provider-catalog/health')
  revalidatePath('/admin/provider-catalog')
}

export async function excludeFromAutoPick(packageId: string) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return
  await prisma.providerPackage.update({ where: { id: packageId }, data: { excludedFromAutoPick: true } })
  await prisma.auditLog.create({ data: { userId: session.user.id, action: 'PACKAGE_EXCLUDED_FROM_AUTOPICK', entity: 'ProviderPackage', entityId: packageId } }).catch(() => {})
  revalidatePath('/admin/provider-catalog/health')
}
