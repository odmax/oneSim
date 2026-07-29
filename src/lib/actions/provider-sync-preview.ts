'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { buildAdapter } from '@/lib/providers/adapter-manager'
import { buildComparableKey, computeEffectiveCost } from '@/lib/packages/cheapest-utils'

interface SyncPreviewItem {
  providerPlanId: string
  providerPlanCode?: string
  name: string
  dataGB: number
  validityDays: number
  costPrice: number
  currency: string
  country?: string | null
  region?: string | null
  impact: 'NEW' | 'UPDATED' | 'UNCHANGED' | 'REMOVED'
  existingPackage?: { id: string; name: string }
  changes?: Record<string, { from: any; to: any }>
  isDuplicate?: boolean
}

interface SyncPreviewResult {
  providerId: string
  providerName: string
  totalIncoming: number
  newCount: number
  updatedCount: number
  unchangedCount: number
  removedCount: number
  duplicateCount: number
  items: SyncPreviewItem[]
}

import { TRACKED_FIELDS as SAFE_FIELDS } from './catalog-history'

export async function previewSync(providerId: string): Promise<SyncPreviewResult | { error: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { error: 'Unauthorized' }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { error: 'Provider not found' }

  const adapter = await buildAdapter(provider)
  if (!adapter) return { error: 'No adapter available' }

  const result = await adapter.syncPlans()
  if (!result.success) return { error: result.error?.message || 'Sync failed' }

  const incomingPlans = result.data || []
  const existing = await prisma.providerPackage.findMany({ where: { providerId } })

  const items: SyncPreviewItem[] = []
  const seen = new Set<string>()

  for (const plan of incomingPlans) {
    const raw = plan.raw_data || {}
    const planId = plan.id || raw.id || raw.planCode || ''
    const planCode = raw.planCode || raw.sku || plan.sku || ''
    seen.add(planId)

    const match = existing.find(e => e.providerPlanId === planId)
    const matchByCode = !match ? existing.find(e => e.providerPlanCode && e.providerPlanCode === planCode) : match

    if (match || matchByCode) {
      const ex = match || matchByCode!
      const changes: Record<string, { from: any; to: any }> = {}
      const costPrice = plan.price_usd || parseFloat(raw.retailPrice) || 0

      if (ex.name !== (plan.name || raw.planName || '')) changes.name = { from: ex.name, to: plan.name || raw.planName || '' }
      if (ex.dataGB !== plan.data_gb) changes.dataGB = { from: ex.dataGB, to: plan.data_gb }
      if (ex.validityDays !== plan.validity_days) changes.validityDays = { from: ex.validityDays, to: plan.validity_days }
      if (parseFloat(ex.costPrice.toString()) !== costPrice) changes.costPrice = { from: parseFloat(ex.costPrice.toString()), to: costPrice }

      const impact = Object.keys(changes).length > 0 ? 'UPDATED' : 'UNCHANGED'
      items.push({
        providerPlanId: planId, providerPlanCode: planCode, name: plan.name || raw.planName || '',
        dataGB: plan.data_gb, validityDays: plan.validity_days, costPrice, currency: plan.currency || 'USD',
        country: raw.country || raw.region || null, region: raw.region || null,
        impact, existingPackage: { id: ex.id, name: ex.name },
        changes: Object.keys(changes).length > 0 ? changes : undefined,
      })
    } else {
      // Check for duplicates by name/GB/validity
      const duplicate = existing.find(e => e.name === (plan.name || raw.planName) && e.dataGB === plan.data_gb && e.validityDays === plan.validity_days)
      items.push({
        providerPlanId: planId, providerPlanCode: planCode, name: plan.name || raw.planName || '',
        dataGB: plan.data_gb, validityDays: plan.validity_days, costPrice: plan.price_usd || 0,
        currency: plan.currency || 'USD', country: raw.country || null, region: raw.region || null,
        impact: 'NEW', isDuplicate: !!duplicate,
        existingPackage: duplicate ? { id: duplicate.id, name: duplicate.name } : undefined,
      })
    }
  }

  // Removed packages
  const removed = existing.filter(e => !seen.has(e.providerPlanId))
  for (const rm of removed) {
    items.push({
      providerPlanId: rm.providerPlanId, providerPlanCode: rm.providerPlanCode || undefined,
      name: rm.name, dataGB: rm.dataGB, validityDays: rm.validityDays,
      costPrice: parseFloat(rm.costPrice.toString()), currency: rm.currency,
      country: rm.country, region: rm.region,
      impact: 'REMOVED', existingPackage: { id: rm.id, name: rm.name },
    })
  }

  await prisma.auditLog.create({ data: { userId: session.user.id, action: 'SYNC_PREVIEW_RUN', entity: 'Provider', entityId: provider.code, details: `${incomingPlans.length} incoming, ${existing.length} existing` } }).catch(() => {})

  return {
    providerId, providerName: provider.name,
    totalIncoming: incomingPlans.length,
    newCount: items.filter(i => i.impact === 'NEW').length,
    updatedCount: items.filter(i => i.impact === 'UPDATED').length,
    unchangedCount: items.filter(i => i.impact === 'UNCHANGED').length,
    removedCount: items.filter(i => i.impact === 'REMOVED').length,
    duplicateCount: items.filter(i => i.isDuplicate).length,
    items,
  }
}

export async function applySafeSync(providerId: string, mode: 'all' | 'new_only' | 'updates_only' | 'ignore_removals') {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { error: 'Unauthorized' }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { error: 'Provider not found' }

  const adapter = await buildAdapter(provider)
  if (!adapter) return { error: 'No adapter' }

  const result = await adapter.syncPlans()
  if (!result.success) return { error: result.error?.message || 'Sync failed' }

  const incomingPlans = result.data || []
  const existing = await prisma.providerPackage.findMany({ where: { providerId } })
  let imported = 0, updated = 0

  for (const plan of incomingPlans) {
    const raw = plan.raw_data || {}
    const planId = plan.id || raw.id || raw.planCode || ''
    if (!planId) continue
    const planCode = raw.planCode || raw.sku || plan.sku || ''

    if (mode === 'updates_only') {
      const match = existing.find(e => e.providerPlanId === planId || (planCode && e.providerPlanCode === planCode))
      if (!match) continue
      const update: any = { name: plan.name || raw.planName || match.name, dataGB: plan.data_gb || match.dataGB, validityDays: plan.validity_days || match.validityDays, costPrice: plan.price_usd || match.costPrice, currency: plan.currency || 'USD', isAvailable: true, providerRawData: raw }
      await prisma.providerPackage.update({ where: { id: match.id }, data: update })
      updated++
      continue
    }

    if (mode === 'new_only') {
      const match = existing.find(e => e.providerPlanId === planId || (planCode && e.providerPlanCode === planCode))
      if (match) continue
    }

    const match = existing.find(e => e.providerPlanId === planId || (planCode && e.providerPlanCode === planCode))
    if (match) {
      const update: any = { name: plan.name || raw.planName || match.name, dataGB: plan.data_gb || match.dataGB, validityDays: plan.validity_days || match.validityDays, costPrice: plan.price_usd || match.costPrice, currency: plan.currency || 'USD', isAvailable: true, providerPlanCode: planCode || match.providerPlanCode, providerRawData: raw }
      await prisma.providerPackage.update({ where: { id: match.id }, data: update })
      updated++
    } else {
      await prisma.providerPackage.create({
        data: { providerId, providerPlanId: planId, providerPlanCode: planCode || null,
          name: plan.name || raw.planName || '', dataGB: plan.data_gb || 1, validityDays: plan.validity_days || 30,
          costPrice: plan.price_usd || 0, currency: plan.currency || 'USD',
          country: raw.country || raw.region || null, region: raw.region || null,
          isAvailable: true, providerRawData: raw },
      })
      imported++
    }
  }

  // Mark removed as unavailable unless ignore_removals
  if (mode !== 'ignore_removals') {
    const seen = new Set(incomingPlans.map(p => p.id || p.raw_data?.id || p.raw_data?.planCode || '').filter(Boolean))
    const removed = existing.filter(e => !seen.has(e.providerPlanId))
    if (removed.length > 0) {
      await prisma.providerPackage.updateMany({ where: { id: { in: removed.map(r => r.id) } }, data: { isAvailable: false } })
    }
  }

  await prisma.auditLog.create({ data: { userId: session.user.id, action: 'PROVIDER_SYNC_APPLIED', entity: 'Provider', entityId: provider.code, details: `${imported} imported, ${updated} updated, mode=${mode}` } }).catch(() => {})
  revalidatePath(`/admin/providers/${providerId}`)
  revalidatePath('/admin/provider-catalog')
  return { success: true, imported, updated, mode }
}
