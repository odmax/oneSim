'use server'

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { revalidatePath } from 'next/cache'

export type ImportedPlanStatus = 'unconfigured' | 'configured' | 'ready_to_publish' | 'published' | 'archived'

export interface ImportedPlanRow {
  providerPackageId: string
  providerId: string
  providerCode: string
  providerName: string
  providerPlanId: string
  providerPlanCode: string | null
  sku: string | null
  name: string
  country: string | null
  region: string | null
  dataGB: number
  validityDays: number
  providerCostPrice: number
  providerCurrency: string
  costPriceUSD: number | null
  costCurrency: string | null
  sellingPrice: number | null
  sellingCurrency: string | null
  markupPercent: number | null
  readyToPublish: boolean
  isActive: boolean
  hiddenFromCatalog: boolean
  archivedAt: string | null
  packageId: string | null
  status: ImportedPlanStatus
  // Cheapest fields
  adminCostPrice: number | null
  effectiveCostPrice: number | null
  costSource: string | null
  comparableKey: string | null
  cheapestRank: number | null
  isCheapestCandidate: boolean
  cheapestReason: string | null
  excludedFromCheapest: boolean
  exclusionReason: string | null
}

function computeStatus(pp: { readyToPublish?: boolean }, esim: { isActive?: boolean; archivedAt?: Date | null; source?: string; costPriceUSD?: any; priceUSD?: any } | null): ImportedPlanStatus {
  if (esim?.archivedAt) return 'archived'
  if (esim?.source === 'CATALOG_PRODUCT' && esim?.isActive) return 'published'
  if (esim?.archivedAt) return 'archived'
  const hasCost = esim?.costPriceUSD != null && Number(esim.costPriceUSD) > 0
  const hasPrice = esim?.priceUSD != null && Number(esim.priceUSD) > 0
  if (!hasCost || !hasPrice) return 'unconfigured'
  if (pp.readyToPublish) return 'ready_to_publish'
  return 'configured'
}

export interface ImportedPlansFilters {
  providerId?: string
  status?: ImportedPlanStatus
  costMissing?: boolean
  sellPriceMissing?: boolean
  readyToPublish?: boolean
  notPublished?: boolean
  recentlySynced?: boolean
  hiddenFromCatalog?: boolean
  cheapestOnly?: boolean
  alternatives?: boolean
  missingEffectiveCost?: boolean
  excludedFromCheapest?: boolean
  comparableKey?: string
  search?: string
}

export async function getImportedPlans(filters: ImportedPlansFilters): Promise<ImportedPlanRow[]> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return []

  const where: any = { isAvailable: true }

  if (filters.providerId) where.providerId = filters.providerId
  if (filters.search) {
    where.OR = [
      { name: { contains: filters.search, mode: 'insensitive' } },
      { providerPlanId: { contains: filters.search, mode: 'insensitive' } },
      { providerPlanCode: { contains: filters.search, mode: 'insensitive' } },
      { country: { contains: filters.search, mode: 'insensitive' } },
    ]
  }
  if (filters.recentlySynced) {
    where.createdAt = { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
  }

  const providerPackages = await prisma.providerPackage.findMany({
    where,
    include: {
      provider: { select: { id: true, name: true, code: true } },
      publishedAs: {
        select: {
          id: true, isActive: true, hiddenFromCatalog: true, archivedAt: true,
          source: true, costPriceUSD: true, costCurrency: true, priceUSD: true,
          currency: true, markupPercent: true, sku: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  let rows: ImportedPlanRow[] = providerPackages.map(pp => {
    const esim = pp.publishedAs
    return {
      providerPackageId: pp.id,
      providerId: pp.providerId,
      providerCode: pp.provider.code,
      providerName: pp.provider.name,
      providerPlanId: pp.providerPlanId,
      providerPlanCode: pp.providerPlanCode,
      sku: esim?.sku || null,
      name: pp.name,
      country: pp.country,
      region: pp.region,
      dataGB: pp.dataGB,
      validityDays: pp.validityDays,
      providerCostPrice: Number(pp.costPrice),
      providerCurrency: pp.currency,
      costPriceUSD: esim?.costPriceUSD ? Number(esim.costPriceUSD) : null,
      costCurrency: esim?.costCurrency || null,
      sellingPrice: esim?.priceUSD ? Number(esim.priceUSD) : null,
      sellingCurrency: esim?.currency || null,
      markupPercent: esim?.markupPercent ? Number(esim.markupPercent) : null,
      readyToPublish: pp.readyToPublish,
      isActive: esim?.isActive || false,
      hiddenFromCatalog: esim?.hiddenFromCatalog || false,
      archivedAt: esim?.archivedAt ? esim.archivedAt.toISOString() : null,
      packageId: esim?.id || null,
      status: computeStatus(pp, esim),
      // Cheapest fields
      adminCostPrice: pp.adminCostPrice ? Number(pp.adminCostPrice) : null,
      effectiveCostPrice: pp.effectiveCostPrice ? Number(pp.effectiveCostPrice) : null,
      costSource: pp.costSource,
      comparableKey: pp.comparableKey,
      cheapestRank: pp.cheapestRank,
      isCheapestCandidate: pp.isCheapestCandidate,
      cheapestReason: pp.cheapestReason,
      excludedFromCheapest: pp.excludedFromCheapest,
      exclusionReason: pp.exclusionReason,
    }
  })

  if (filters.status) rows = rows.filter(r => r.status === filters.status)
  if (filters.costMissing) rows = rows.filter(r => r.costPriceUSD == null || r.costPriceUSD <= 0)
  if (filters.sellPriceMissing) rows = rows.filter(r => r.sellingPrice == null || r.sellingPrice <= 0)
  if (filters.readyToPublish) rows = rows.filter(r => r.readyToPublish && r.status !== 'published' && r.status !== 'archived')
  if (filters.notPublished) rows = rows.filter(r => r.status !== 'published' && r.status !== 'archived')
  if (filters.hiddenFromCatalog) rows = rows.filter(r => r.hiddenFromCatalog)
  if (filters.cheapestOnly) rows = rows.filter(r => r.isCheapestCandidate)
  if (filters.alternatives) rows = rows.filter(r => r.cheapestRank != null && r.cheapestRank > 1)
  if (filters.missingEffectiveCost) rows = rows.filter(r => r.effectiveCostPrice == null || r.effectiveCostPrice <= 0)
  if (filters.excludedFromCheapest) rows = rows.filter(r => r.excludedFromCheapest)

  return rows
}

export async function saveImportedPlanPricing(formData: FormData): Promise<{ success: boolean; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  const providerPackageId = formData.get('providerPackageId') as string
  const costPriceRaw = formData.get('costPriceUSD') as string
  const costCurrencyRaw = formData.get('costCurrency') as string
  const sellingPriceRaw = formData.get('sellingPrice') as string
  const sellingCurrencyRaw = formData.get('sellingCurrency') as string
  const markupRaw = formData.get('markupPercent') as string
  const adminCostRaw = formData.get('adminCostPrice') as string
  const readyRaw = formData.get('readyToPublish') as string

  const pp = await prisma.providerPackage.findUnique({ where: { id: providerPackageId }, include: { provider: true } })
  if (!pp) return { success: false, error: 'Provider package not found' }

  const costPriceUSD = costPriceRaw ? parseFloat(costPriceRaw) : null
  const costCurrency = costCurrencyRaw?.trim().toUpperCase() || 'USD'
  const sellingPrice = sellingPriceRaw ? parseFloat(sellingPriceRaw) : null
  const sellingCurrency = sellingCurrencyRaw?.trim().toUpperCase() || 'USD'
  const markupPercent = markupRaw ? parseFloat(markupRaw) : null
  const adminCostPrice = adminCostRaw ? parseFloat(adminCostRaw) : null

  // Compute effective cost with admin override
  const { computeEffectiveCost } = await import('@/lib/packages/cheapest-utils')
  const rawProviderCost = Number(pp.costPrice)
  const { effectiveCostPrice, costSource } = computeEffectiveCost(rawProviderCost, adminCostPrice)

  // Update ProviderPackage admin cost
  const ppUpdateData: any = {}
  if (adminCostRaw !== '') {
    ppUpdateData.adminCostPrice = adminCostPrice
    ppUpdateData.effectiveCostPrice = effectiveCostPrice
    ppUpdateData.costSource = costSource
  }
  if (Object.keys(ppUpdateData).length > 0) {
    await prisma.providerPackage.update({ where: { id: providerPackageId }, data: ppUpdateData })
  }

  if (adminCostPrice != null && adminCostPrice > 0) {
    await prisma.auditLog.create({
      data: {
        userId: session.user.id, action: 'IMPORTED_PLAN_COST_OVERRIDE_SET',
        entity: 'ProviderPackage', entityId: providerPackageId,
        details: `Admin cost override: ${adminCostPrice} (was provider cost ${rawProviderCost})`,
      },
    })
  }

  let esim = await prisma.eSIMPackage.findFirst({ where: { providerPackageId } })

  const updateData: any = {
    name: pp.name,
    dataGB: pp.dataGB,
    validityDays: pp.validityDays,
    providerName: pp.provider.code,
    providerId: pp.providerId,
    providerPlanId: pp.providerPlanId,
    costPriceUSD,
    costCurrency,
    priceUSD: sellingPrice || 0,
    localPrice: 0,
    currency: sellingCurrency,
    markupPercent,
  }

  if (esim) {
    await prisma.eSIMPackage.update({ where: { id: esim.id }, data: updateData })
  } else {
    esim = await prisma.eSIMPackage.create({
      data: {
        ...updateData,
        source: 'PROVIDER_PLAN',
        providerPackageId,
        sku: pp.providerPlanCode ? `${pp.provider.code}-${pp.providerPlanCode}` : undefined,
      },
    })
  }

  if (costPriceUSD && costPriceUSD > 0 && sellingPrice && sellingPrice > 0) {
    const computed = Math.round(((sellingPrice - costPriceUSD) / costPriceUSD) * 100 * 100) / 100
    await prisma.eSIMPackage.update({ where: { id: esim.id }, data: { markupPercent: computed } })
  }

  // Handle readyToPublish toggle
  if (readyRaw === 'true' || readyRaw === '1') {
    await prisma.providerPackage.update({ where: { id: providerPackageId }, data: { readyToPublish: true } })
  } else if (readyRaw === 'false' || readyRaw === '0') {
    await prisma.providerPackage.update({ where: { id: providerPackageId }, data: { readyToPublish: false } })
  }

  await prisma.auditLog.create({
    data: {
      userId: session.user.id, action: 'IMPORTED_PLAN_PRICE_UPDATED',
      entity: 'ProviderPackage', entityId: providerPackageId,
      details: `Pricing updated for ${pp.name}: cost=${costPriceUSD}, selling=${sellingPrice}, markup=${markupPercent}`,
    },
  })

  // Recalculate cheapest rankings if cost changed
  if (ppUpdateData.adminCostPrice !== undefined || ppUpdateData.effectiveCostPrice !== undefined) {
    const { recalculateCheapestPlans } = await import('@/lib/packages/cheapest-utils')
    await recalculateCheapestPlans().catch(() => {})
  }

  revalidatePath('/admin/imported-plans')
  return { success: true }
}

export async function markReadyToPublish(providerPackageId: string): Promise<{ success: boolean; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  const pp = await prisma.providerPackage.findUnique({ where: { id: providerPackageId }, include: { publishedAs: true } })
  if (!pp) return { success: false, error: 'Not found' }

  const esim = pp.publishedAs
  const hasCost = esim?.costPriceUSD != null && Number(esim.costPriceUSD) > 0
  const hasPrice = esim?.priceUSD != null && Number(esim.priceUSD) > 0
  if (!hasCost || !hasPrice) return { success: false, error: 'Set cost and selling price before marking ready' }

  await prisma.providerPackage.update({ where: { id: providerPackageId }, data: { readyToPublish: true } })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id, action: 'IMPORTED_PLAN_MARKED_READY',
      entity: 'ProviderPackage', entityId: providerPackageId,
      details: `Marked ready to publish: ${pp.name}`,
    },
  })

  revalidatePath('/admin/imported-plans')
  return { success: true }
}

export async function unmarkReadyToPublish(providerPackageId: string): Promise<{ success: boolean; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  await prisma.providerPackage.update({ where: { id: providerPackageId }, data: { readyToPublish: false } })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id, action: 'IMPORTED_PLAN_MARKED_READY',
      entity: 'ProviderPackage', entityId: providerPackageId,
      details: `Unmarked ready to publish`,
    },
  })

  revalidatePath('/admin/imported-plans')
  return { success: true }
}

export async function publishImportedPlan(formData: FormData): Promise<{ success: boolean; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  const providerPackageId = formData.get('providerPackageId') as string

  const pp = await prisma.providerPackage.findUnique({ where: { id: providerPackageId }, include: { provider: true, publishedAs: true } })
  if (!pp) return { success: false, error: 'Provider package not found' }

  let esim = pp.publishedAs || await prisma.eSIMPackage.findFirst({ where: { providerPackageId } })
    if (!esim) {
    esim = await prisma.eSIMPackage.create({
      data: {
        name: pp.name, dataGB: pp.dataGB, validityDays: pp.validityDays,
        providerName: pp.provider.code, providerId: pp.providerId, providerPlanId: pp.providerPlanId,
        providerPackageId, source: 'CATALOG_PRODUCT', isActive: true, hiddenFromCatalog: false,
        costPriceUSD: Number(pp.costPrice) || undefined, costCurrency: pp.currency,
        priceUSD: 0, localPrice: 0, currency: 'USD',
        sku: pp.providerPlanCode ? `${pp.provider.code}-${pp.providerPlanCode}` : undefined,
      },
    })
  }

  const hasCost = esim.costPriceUSD != null && Number(esim.costPriceUSD) > 0
  const hasPrice = esim.priceUSD != null && Number(esim.priceUSD) > 0
  if (!hasCost) return { success: false, error: 'Cost price must be set before publishing' }
  if (!hasPrice) return { success: false, error: 'Selling price must be set before publishing' }

  await prisma.eSIMPackage.update({
    where: { id: esim.id },
    data: { source: 'CATALOG_PRODUCT', isActive: true, hiddenFromCatalog: false, archivedAt: null },
  })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id, action: 'IMPORTED_PLAN_PUBLISHED',
      entity: 'ProviderPackage', entityId: providerPackageId, details: `Published to catalog: ${pp.name}`,
    },
  })

  revalidatePath('/admin/imported-plans')
  revalidatePath('/admin/packages')
  return { success: true }
}

export async function archiveImportedPlan(providerPackageId: string): Promise<{ success: boolean; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  const esim = await prisma.eSIMPackage.findFirst({ where: { providerPackageId } })
  if (esim) {
    await prisma.eSIMPackage.update({ where: { id: esim.id }, data: { archivedAt: new Date(), isActive: false, hiddenFromCatalog: true } })
  }

  await prisma.auditLog.create({
    data: {
      userId: session.user.id, action: 'ARCHIVE',
      entity: 'ProviderPackage', entityId: providerPackageId, details: `Imported plan archived`,
    },
  })

  revalidatePath('/admin/imported-plans')
  return { success: true }
}

// Bulk Pricing Rules
export interface PricingRuleInput {
  providerCode?: string
  country?: string
  minCost?: number
  maxCost?: number
  markupPercent: number
  applyToMissingSellingPriceOnly: boolean
}

export async function previewPricingRules(formData: FormData): Promise<{
  matched: number; willUpdate: number; skippedMissingCost: number; skippedExistingSell: number; preview: { providerPackageId: string; name: string; currentSell: number | null; newSell: number }[]
}> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const providerCode = (formData.get('providerCode') as string) || undefined
  const country = (formData.get('country') as string) || undefined
  const minCostRaw = formData.get('minCost') as string
  const maxCostRaw = formData.get('maxCost') as string
  const markupPercent = parseFloat(formData.get('markupPercent') as string)
  const applyToMissingOnly = formData.get('applyToMissingSellingPriceOnly') === 'on'

  if (!markupPercent || markupPercent <= 0) throw new Error('Markup percent must be > 0')

  const where: any = { isAvailable: true }
  if (providerCode) {
    where.provider = { code: { equals: providerCode, mode: 'insensitive' } }
  }
  if (country) where.country = { contains: country, mode: 'insensitive' }

  const pps = await prisma.providerPackage.findMany({
    where,
    include: {
      provider: { select: { code: true } },
      publishedAs: { select: { id: true, costPriceUSD: true, priceUSD: true } },
    },
  })

  const minCost = minCostRaw ? parseFloat(minCostRaw) : null
  const maxCost = maxCostRaw ? parseFloat(maxCostRaw) : null

  let matched = 0
  let willUpdate = 0
  let skippedMissingCost = 0
  let skippedExistingSell = 0
  const preview: any[] = []

  for (const pp of pps) {
    const costRaw = pp.publishedAs?.costPriceUSD ?? pp.costPrice
    const cost = costRaw ? Number(costRaw) : 0

    if (minCost && cost < minCost) continue
    if (maxCost && cost > maxCost) continue

    matched++

    if (!cost || cost <= 0) { skippedMissingCost++; continue }

    const newSell = Math.round(cost * (1 + markupPercent / 100) * 100) / 100
    const currentSell = pp.publishedAs?.priceUSD ? Number(pp.publishedAs.priceUSD) : null

    if (applyToMissingOnly && currentSell != null && currentSell > 0) {
      skippedExistingSell++
      continue
    }

    willUpdate++
    preview.push({ providerPackageId: pp.id, name: pp.name, currentSell, newSell })
  }

  return { matched, willUpdate, skippedMissingCost, skippedExistingSell, preview }
}

export async function applyPricingRules(formData: FormData): Promise<{
  applied: number; errors: string[]
}> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { applied: 0, errors: [] }

  const preview = await previewPricingRules(formData)
  const errors: string[] = []

  let applied = 0
  for (const item of preview.preview) {
    try {
      let esim = await prisma.eSIMPackage.findFirst({ where: { providerPackageId: item.providerPackageId } })
      if (esim) {
        await prisma.eSIMPackage.update({
          where: { id: esim.id },
          data: { priceUSD: item.newSell },
        })
      } else {
        const pp = await prisma.providerPackage.findUnique({ where: { id: item.providerPackageId }, include: { provider: true } })
        if (pp) {
          esim = await prisma.eSIMPackage.create({
            data: {
              name: pp.name, dataGB: pp.dataGB, validityDays: pp.validityDays,
              providerName: pp.provider.code, providerId: pp.providerId, providerPlanId: pp.providerPlanId,
              providerPackageId: item.providerPackageId, source: 'PROVIDER_PLAN',
              costPriceUSD: Number(pp.costPrice) || undefined, priceUSD: item.newSell, localPrice: 0, currency: 'USD',
              sku: pp.providerPlanCode ? `${pp.provider.code}-${pp.providerPlanCode}` : undefined,
            },
          })
        }
      }
      applied++
    } catch (e: any) {
      errors.push(`Error on ${item.name}: ${e.message}`)
    }
  }

  await prisma.auditLog.create({
    data: {
      userId: session.user.id, action: 'IMPORTED_PLAN_RULE_APPLIED',
      entity: 'ProviderPackage',
      details: `Pricing rules applied: ${applied} updates, ${preview.willUpdate} targeted, ${preview.skippedMissingCost} missing cost, ${preview.skippedExistingSell} skipped existing`,
    },
  })

  revalidatePath('/admin/imported-plans')
  return { applied, errors }
}

// CSV
const CSV_COLS = [
  'packageId', 'source', 'providerCode', 'providerName', 'providerPlanId',
  'sku', 'name', 'dataGB', 'validityDays', 'country',
  'providerPrice', 'providerCurrency', 'adminCostPrice', 'effectiveCostPrice', 'costSource',
  'costPriceUSD', 'costCurrency',
  'sellingPrice', 'sellingCurrency', 'markupPercent',
  'readyToPublish', 'isActive', 'hiddenFromCatalog', 'archivedAt', 'publishToCatalog',
  'comparableKey', 'cheapestRank', 'isCheapestCandidate', 'excludedFromCheapest', 'exclusionReason',
]

function sanitize(v: any): string {
  const s = v == null ? '' : String(v)
  if (s === '') return '""'
  if (/^[=+\-@]/.test(s)) return `"'${s}"`
  if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function parseCsvLine(line: string): string[] {
  const r: string[] = []
  let c = '', q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (q && line[i + 1] === '"') { c += '"'; i++; continue }
      q = !q
    } else if (ch === ',' && !q) { r.push(c.trim()); c = '' } else c += ch
  }
  r.push(c.trim())
  return r
}

function parseBool(v: string): boolean | null {
  const l = v.trim().toLowerCase()
  if (['true', '1', 'yes'].includes(l)) return true
  if (['false', '0', 'no'].includes(l)) return false
  return null
}

function parseNum(v: string): number | null {
  const t = v.trim()
  if (t === '') return null
  const n = Number(t)
  return isNaN(n) ? null : n
}

export async function exportImportedPlansCsv(): Promise<string> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')
  const rows = await getImportedPlans({})
  const header = CSV_COLS.map(sanitize).join(',')
  const lines = rows.map(r => CSV_COLS.map(c => {
    switch (c) {
      case 'packageId': return sanitize(r.packageId || '')
      case 'source': return sanitize('PROVIDER_PLAN')
      case 'providerCode': return sanitize(r.providerCode)
      case 'providerName': return sanitize(r.providerName)
      case 'providerPlanId': return sanitize(r.providerPlanId)
      case 'sku': return sanitize(r.sku || '')
      case 'name': return sanitize(r.name)
      case 'dataGB': return sanitize(r.dataGB)
      case 'validityDays': return sanitize(r.validityDays)
      case 'country': return sanitize(r.country || '')
      case 'providerPrice': return sanitize(r.providerCostPrice)
      case 'providerCurrency': return sanitize(r.providerCurrency)
      case 'adminCostPrice': return sanitize(r.adminCostPrice != null ? r.adminCostPrice : '')
      case 'effectiveCostPrice': return sanitize(r.effectiveCostPrice != null ? r.effectiveCostPrice : '')
      case 'costSource': return sanitize(r.costSource || '')
      case 'costPriceUSD': return sanitize(r.costPriceUSD != null ? r.costPriceUSD : '')
      case 'costCurrency': return sanitize(r.costCurrency || r.providerCurrency)
      case 'sellingPrice': return sanitize(r.sellingPrice != null ? r.sellingPrice : '')
      case 'sellingCurrency': return sanitize(r.sellingCurrency || 'USD')
      case 'markupPercent': return sanitize(r.markupPercent != null ? r.markupPercent : '')
      case 'readyToPublish': return sanitize(r.readyToPublish ? '1' : '0')
      case 'isActive': return sanitize(r.isActive ? '1' : '0')
      case 'hiddenFromCatalog': return sanitize(r.hiddenFromCatalog ? '1' : '0')
      case 'archivedAt': return sanitize(r.archivedAt || '')
      case 'publishToCatalog': return sanitize('')
      case 'comparableKey': return sanitize(r.comparableKey || '')
      case 'cheapestRank': return sanitize(r.cheapestRank != null ? r.cheapestRank : '')
      case 'isCheapestCandidate': return sanitize(r.isCheapestCandidate ? '1' : '0')
      case 'excludedFromCheapest': return sanitize(r.excludedFromCheapest ? '1' : '0')
      case 'exclusionReason': return sanitize(r.exclusionReason || '')
      default: return ''
    }
  }).join(','))

  await prisma.auditLog.create({
    data: {
      userId: session.user.id, action: 'IMPORTED_PLAN_CSV_EXPORTED',
      entity: 'ProviderPackage', details: `Imported plans CSV exported — ${rows.length} rows`,
    },
  })

  return [header, ...lines].join('\r\n')
}

export async function importImportedPlansCsvPreview(formData: FormData): Promise<{
  totalRows: number; validRows: number; errors: { line: number; message: string }[]
  preview: { providerPackageId: string; name: string; changes: Record<string, { from: any; to: any }> }[]
}> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const file = formData.get('file') as File
  if (!file) throw new Error('No file')
  if (!file.name.endsWith('.csv')) throw new Error('Must be CSV')
  if (file.size > 5 * 1024 * 1024) throw new Error('File too large')

  const text = await file.text()
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '')
  if (lines.length < 2) throw new Error('Need header + data')

  const header = parseCsvLine(lines[0])
  const ci: Record<string, number> = {}
  for (let i = 0; i < header.length; i++) ci[header[i].trim()] = i

  const errors: { line: number; message: string }[] = []
  const preview: any[] = []

  for (let i = 1; i < lines.length; i++) {
    const ln = i + 1
    const cols = parseCsvLine(lines[i])
    const g = (n: string) => { const idx = ci[n]; return idx !== undefined && idx < cols.length ? cols[idx] : '' }

    const packageId = g('packageId').trim()
    const providerPlanId = g('providerPlanId').trim()

    let pp: any = packageId ? await prisma.providerPackage.findFirst({ where: { publishedAs: { id: packageId } }, include: { provider: true, publishedAs: true } }) : null
    if (!pp && providerPlanId) pp = await prisma.providerPackage.findFirst({ where: { providerPlanId }, include: { provider: true, publishedAs: true } })
    if (!pp) { errors.push({ line: ln, message: `No provider package found` }); continue }

    const esim = pp.publishedAs
    const changes: Record<string, { from: any; to: any }> = {}

    const costRaw = g('costPriceUSD')
    if (costRaw.trim()) {
      const n = parseNum(costRaw)
      if (n == null || n < 0) { errors.push({ line: ln, message: `Invalid costPriceUSD: "${costRaw}"` }); continue }
      if (n !== (esim?.costPriceUSD != null ? Number(esim.costPriceUSD) : null)) changes.costPriceUSD = { from: esim?.costPriceUSD, to: n }
    }
    const ccRaw = g('costCurrency')
    if (ccRaw.trim()) {
      if (!/^[A-Z]{3}$/i.test(ccRaw.trim())) { errors.push({ line: ln, message: `Invalid costCurrency: "${ccRaw}"` }); continue }
      const v = ccRaw.trim().toUpperCase()
      if (v !== (esim?.costCurrency || 'USD')) changes.costCurrency = { from: esim?.costCurrency || 'USD', to: v }
    }
    const spRaw = g('sellingPrice')
    if (spRaw.trim()) {
      const n = parseNum(spRaw)
      if (n == null || n < 0) { errors.push({ line: ln, message: `Invalid sellingPrice: "${spRaw}"` }); continue }
      if (n !== (esim?.priceUSD != null ? Number(esim.priceUSD) : null)) changes.sellingPrice = { from: esim?.priceUSD, to: n }
    }
    const scRaw = g('sellingCurrency')
    if (scRaw.trim()) {
      if (!/^[A-Z]{3}$/i.test(scRaw.trim())) { errors.push({ line: ln, message: `Invalid sellingCurrency: "${scRaw}"` }); continue }
      const v = scRaw.trim().toUpperCase()
      if (v !== (esim?.currency || 'USD')) changes.sellingCurrency = { from: esim?.currency || 'USD', to: v }
    }
    const mpRaw = g('markupPercent')
    if (mpRaw.trim()) {
      const n = parseNum(mpRaw)
      if (n == null || n < 0) { errors.push({ line: ln, message: `Invalid markupPercent: "${mpRaw}"` }); continue }
      if (n !== (esim?.markupPercent != null ? Number(esim.markupPercent) : null)) changes.markupPercent = { from: esim?.markupPercent, to: n }
    }
    const rtpRaw = g('readyToPublish')
    if (rtpRaw.trim()) {
      const b = parseBool(rtpRaw)
      if (b == null) { errors.push({ line: ln, message: `Invalid readyToPublish: "${rtpRaw}"` }); continue }
      if (b !== pp.readyToPublish) changes.readyToPublish = { from: pp.readyToPublish, to: b }
    }
    const iaRaw = g('isActive')
    if (iaRaw.trim()) {
      const b = parseBool(iaRaw)
      if (b == null) { errors.push({ line: ln, message: `Invalid isActive: "${iaRaw}"` }); continue }
      if (b !== esim?.isActive) changes.isActive = { from: esim?.isActive, to: b }
    }
    const hcRaw = g('hiddenFromCatalog')
    if (hcRaw.trim()) {
      const b = parseBool(hcRaw)
      if (b == null) { errors.push({ line: ln, message: `Invalid hiddenFromCatalog: "${hcRaw}"` }); continue }
      if (b !== esim?.hiddenFromCatalog) changes.hiddenFromCatalog = { from: esim?.hiddenFromCatalog, to: b }
    }
    const ptcRaw = g('publishToCatalog')
    if (ptcRaw.trim()) {
      const b = parseBool(ptcRaw)
      if (b == null) { errors.push({ line: ln, message: `Invalid publishToCatalog: "${ptcRaw}"` }); continue }
      changes.publishToCatalog = { from: false, to: b }
    }

    if (Object.keys(changes).length > 0) preview.push({ providerPackageId: pp.id, name: pp.name, changes })
  }

  return { totalRows: lines.length - 1, validRows: lines.length - 1 - errors.length, errors, preview }
}

export async function applyImportedPlansCsvImport(formData: FormData): Promise<{ applied: number; errors: { line: number; message: string }[] }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { applied: 0, errors: [] }

  const preview = await importImportedPlansCsvPreview(formData)
  if (preview.errors.length > 0 && preview.preview.length === 0) return { applied: 0, errors: preview.errors }

  const file = formData.get('file') as File
  const text = await file.text()
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '')
  const header = parseCsvLine(lines[0])
  const ci: Record<string, number> = {}
  for (let i = 0; i < header.length; i++) ci[header[i].trim()] = i

  let applied = 0
  const errors: { line: number; message: string }[] = []

  for (let i = 1; i < lines.length; i++) {
    const ln = i + 1
    const cols = parseCsvLine(lines[i])
    const g = (n: string) => { const idx = ci[n]; return idx !== undefined && idx < cols.length ? cols[idx] : '' }

    const packageId = g('packageId').trim()
    const providerPlanId = g('providerPlanId').trim()

    let pp: any = packageId ? await prisma.providerPackage.findFirst({ where: { publishedAs: { id: packageId } }, include: { provider: true, publishedAs: true } }) : null
    if (!pp && providerPlanId) pp = await prisma.providerPackage.findFirst({ where: { providerPlanId }, include: { provider: true, publishedAs: true } })
    if (!pp) { errors.push({ line: ln, message: `Package not found` }); continue }

    let esim = pp.publishedAs
    const updateData: any = {}
    const ppUpdateData: any = {}

    const costRaw = g('costPriceUSD')
    if (costRaw.trim()) { const n = parseNum(costRaw); if (n != null && n >= 0) updateData.costPriceUSD = n }
    const ccRaw = g('costCurrency')
    if (ccRaw.trim() && /^[A-Z]{3}$/i.test(ccRaw.trim())) updateData.costCurrency = ccRaw.trim().toUpperCase()
    const spRaw = g('sellingPrice')
    if (spRaw.trim()) { const n = parseNum(spRaw); if (n != null && n >= 0) updateData.priceUSD = n }
    const scRaw = g('sellingCurrency')
    if (scRaw.trim() && /^[A-Z]{3}$/i.test(scRaw.trim())) updateData.currency = scRaw.trim().toUpperCase()
    const mpRaw = g('markupPercent')
    if (mpRaw.trim()) { const n = parseNum(mpRaw); if (n != null && n >= 0) updateData.markupPercent = n }
    const rtpRaw = g('readyToPublish')
    if (rtpRaw.trim()) { const b = parseBool(rtpRaw); if (b != null) ppUpdateData.readyToPublish = b }
    const iaRaw = g('isActive')
    if (iaRaw.trim()) { const b = parseBool(iaRaw); if (b != null) updateData.isActive = b }
    const hcRaw = g('hiddenFromCatalog')
    if (hcRaw.trim()) { const b = parseBool(hcRaw); if (b != null) updateData.hiddenFromCatalog = b }
    const ptcRaw = g('publishToCatalog')
    const shouldPublish = ptcRaw.trim() ? parseBool(ptcRaw) : null

    if (Object.keys(ppUpdateData).length > 0) {
      await prisma.providerPackage.update({ where: { id: pp.id }, data: ppUpdateData })
    }

    if (esim && Object.keys(updateData).length > 0) {
      await prisma.eSIMPackage.update({ where: { id: esim.id }, data: updateData })
    } else if (!esim && Object.keys(updateData).length > 0) {
      esim = await prisma.eSIMPackage.create({
        data: {
          name: g('name') || pp.name, dataGB: pp.dataGB, validityDays: pp.validityDays,
          providerName: pp.provider?.code || '', providerId: pp.providerId, providerPlanId: pp.providerPlanId,
          providerPackageId: pp.id, source: 'PROVIDER_PLAN',
          ...updateData, priceUSD: updateData.priceUSD || 0, localPrice: 0, currency: updateData.currency || 'USD',
        },
      })
    }

    if (shouldPublish === true && esim) {
      const hasC = esim.costPriceUSD != null && Number(esim.costPriceUSD) > 0
      const hasP = esim.priceUSD != null && Number(esim.priceUSD) > 0
      if (hasC && hasP) {
        await prisma.eSIMPackage.update({ where: { id: esim.id }, data: { source: 'CATALOG_PRODUCT', isActive: true, hiddenFromCatalog: false, archivedAt: null } })
      } else {
        errors.push({ line: ln, message: `publishToCatalog=true but cost/selling price missing` })
      }
    }
    applied++
  }

  await prisma.auditLog.create({
    data: {
      userId: session.user.id, action: 'IMPORTED_PLAN_CSV_IMPORTED',
      entity: 'ProviderPackage', details: `Imported plans CSV import applied — ${applied} rows, ${errors.length} errors`,
    },
  })

  revalidatePath('/admin/imported-plans')
  revalidatePath('/admin/packages')
  return { applied, errors }
}
