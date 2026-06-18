'use server'

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

export type ImportedPlanStatus = 'unconfigured' | 'configured' | 'published' | 'archived'

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
  isActive: boolean
  hiddenFromCatalog: boolean
  archivedAt: string | null
  packageId: string | null
  status: ImportedPlanStatus
}

function computeStatus(esim: { isActive?: boolean; hiddenFromCatalog?: boolean; archivedAt?: Date | null; source?: string; costPriceUSD?: any; priceUSD?: any } | null): ImportedPlanStatus {
  if (!esim) return 'unconfigured'
  if (esim.archivedAt) return 'archived'
  if (esim.source === 'CATALOG_PRODUCT' && esim.isActive) return 'published'
  const hasCost = esim.costPriceUSD != null && Number(esim.costPriceUSD) > 0
  const hasPrice = esim.priceUSD != null && Number(esim.priceUSD) > 0
  if (hasCost && hasPrice) return 'configured'
  return 'unconfigured'
}

export interface ImportedPlansFilters {
  providerId?: string
  status?: ImportedPlanStatus
  costMissing?: boolean
  hiddenFromCatalog?: boolean
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
    const costPriceUSD = esim?.costPriceUSD ? Number(esim.costPriceUSD) : null
    const sellingPrice = esim?.priceUSD ? Number(esim.priceUSD) : null
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
      costPriceUSD,
      costCurrency: esim?.costCurrency || null,
      sellingPrice,
      sellingCurrency: esim?.currency || null,
      markupPercent: esim?.markupPercent ? Number(esim.markupPercent) : null,
      isActive: esim?.isActive || false,
      hiddenFromCatalog: esim?.hiddenFromCatalog || false,
      archivedAt: esim?.archivedAt ? esim.archivedAt.toISOString() : null,
      packageId: esim?.id || null,
      status: computeStatus(esim),
    }
  })

  // Client-side filters
  if (filters.status) {
    rows = rows.filter(r => r.status === filters.status)
  }
  if (filters.costMissing) {
    rows = rows.filter(r => r.costPriceUSD == null || r.costPriceUSD <= 0)
  }
  if (filters.hiddenFromCatalog) {
    rows = rows.filter(r => r.hiddenFromCatalog)
  }

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

  const pp = await prisma.providerPackage.findUnique({ where: { id: providerPackageId }, include: { provider: true } })
  if (!pp) return { success: false, error: 'Provider package not found' }

  // Find existing ESIMPackage linked via providerPackageId or create one
  let esim = await prisma.eSIMPackage.findFirst({
    where: { providerPackageId },
  })

  const costPriceUSD = costPriceRaw ? parseFloat(costPriceRaw) : null
  const costCurrency = costCurrencyRaw?.trim().toUpperCase() || 'USD'
  const sellingPrice = sellingPriceRaw ? parseFloat(sellingPriceRaw) : null
  const sellingCurrency = sellingCurrencyRaw?.trim().toUpperCase() || 'USD'
  const markupPercent = markupRaw ? parseFloat(markupRaw) : null

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
    currency: sellingCurrency,
    markupPercent,
  }

  if (esim) {
    await prisma.eSIMPackage.update({ where: { id: esim.id }, data: updateData })
  } else {
    // Create with source='PROVIDER_PLAN' and link
    esim = await prisma.eSIMPackage.create({
      data: {
        ...updateData,
        source: 'PROVIDER_PLAN',
        providerPackageId,
        sku: pp.providerPlanCode ? `${pp.provider.code}-${pp.providerPlanCode}` : undefined,
      },
    })
  }

  // Recompute markupPercent if both prices known
  if (costPriceUSD && costPriceUSD > 0 && sellingPrice && sellingPrice > 0) {
    const computed = Math.round(((sellingPrice - costPriceUSD) / costPriceUSD) * 100 * 100) / 100
    await prisma.eSIMPackage.update({
      where: { id: esim.id },
      data: { markupPercent: computed },
    })
  }

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'IMPORTED_PLAN_PRICE_UPDATED',
      entity: 'ProviderPackage',
      entityId: providerPackageId,
      details: `Pricing updated for ${pp.name}: cost=${costPriceUSD}, selling=${sellingPrice}, markup=${markupPercent}`,
    },
  })

  revalidatePath('/admin/imported-plans')
  return { success: true }
}

export async function publishImportedPlan(formData: FormData): Promise<{ success: boolean; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { success: false, error: 'Unauthorized' }

  const providerPackageId = formData.get('providerPackageId') as string

  const pp = await prisma.providerPackage.findUnique({
    where: { id: providerPackageId },
    include: { provider: true },
  })
  if (!pp) return { success: false, error: 'Provider package not found' }

  // Find or create ESIMPackage
  let esim = await prisma.eSIMPackage.findFirst({ where: { providerPackageId } })

  const baseData: any = {
    name: pp.name,
    dataGB: pp.dataGB,
    validityDays: pp.validityDays,
    providerName: pp.provider.code,
    providerId: pp.providerId,
    providerPlanId: pp.providerPlanId,
    providerPackageId,
    source: 'CATALOG_PRODUCT',
    isActive: true,
    hiddenFromCatalog: false,
    archivedAt: null,
  }

  if (!esim) {
    esim = await prisma.eSIMPackage.create({
      data: {
        ...baseData,
        costPriceUSD: Number(pp.costPrice) || undefined,
        costCurrency: pp.currency,
        priceUSD: 0,
        currency: 'USD',
        sku: pp.providerPlanCode ? `${pp.provider.code}-${pp.providerPlanCode}` : undefined,
      },
    })
  }

  // Validate pricing exists
  const hasCost = esim.costPriceUSD != null && Number(esim.costPriceUSD) > 0
  const hasPrice = esim.priceUSD != null && Number(esim.priceUSD) > 0
  if (!hasCost) return { success: false, error: 'Cost price must be set before publishing' }
  if (!hasPrice) return { success: false, error: 'Selling price must be set before publishing' }

  // Publish
  await prisma.eSIMPackage.update({
    where: { id: esim.id },
    data: {
      source: 'CATALOG_PRODUCT',
      isActive: true,
      hiddenFromCatalog: false,
      archivedAt: null,
    },
  })

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'IMPORTED_PLAN_PUBLISHED',
      entity: 'ProviderPackage',
      entityId: providerPackageId,
      details: `Published to catalog: ${pp.name}`,
    },
  })

  revalidatePath('/admin/imported-plans')
  revalidatePath('/admin/packages')
  return { success: true }
}

// --- CSV ---

const CSV_COLS = [
  'packageId', 'source', 'providerCode', 'providerName', 'providerPlanId',
  'sku', 'name', 'dataGB', 'validityDays', 'country',
  'providerPrice', 'providerCurrency', 'costPriceUSD', 'costCurrency',
  'sellingPrice', 'sellingCurrency', 'markupPercent',
  'isActive', 'hiddenFromCatalog', 'archivedAt', 'publishToCatalog',
]

function sanitize(val: any): string {
  const str = val == null ? '' : String(val)
  if (str === '') return '""'
  if (/^[=+\-@]/.test(str)) return `"'${str}"`
  if (/[,"\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; continue }
      inQ = !inQ
    } else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = '' }
    else { cur += ch }
  }
  result.push(cur.trim())
  return result
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
  const lines = rows.map(r =>
    CSV_COLS.map(col => {
      switch (col) {
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
        case 'costPriceUSD': return sanitize(r.costPriceUSD != null ? r.costPriceUSD : '')
        case 'costCurrency': return sanitize(r.costCurrency || r.providerCurrency)
        case 'sellingPrice': return sanitize(r.sellingPrice != null ? r.sellingPrice : '')
        case 'sellingCurrency': return sanitize(r.sellingCurrency || 'USD')
        case 'markupPercent': return sanitize(r.markupPercent != null ? r.markupPercent : '')
        case 'isActive': return sanitize(r.isActive ? '1' : '0')
        case 'hiddenFromCatalog': return sanitize(r.hiddenFromCatalog ? '1' : '0')
        case 'archivedAt': return sanitize(r.archivedAt || '')
        case 'publishToCatalog': return sanitize('')
        default: return ''
      }
    }).join(',')
  )

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'IMPORTED_PLAN_CSV_EXPORTED',
      entity: 'ProviderPackage',
      details: `Imported plans CSV exported — ${rows.length} rows`,
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

  if (!('packageId' in ci) && !('providerPlanId' in ci)) throw new Error('Missing packageId column')

  const errors: { line: number; message: string }[] = []
  const preview: any[] = []

  // Load existing linked ESIMPackages
  const allLinked = await prisma.eSIMPackage.findMany({
    where: { providerPackageId: { not: null } },
    select: { id: true, providerPackageId: true, costPriceUSD: true, costCurrency: true, priceUSD: true, currency: true, markupPercent: true, isActive: true, hiddenFromCatalog: true, name: true },
  })
  const linkedMap = new Map(allLinked.filter(e => e.providerPackageId).map(e => [e.providerPackageId!, e]))

  // Also load all provider packages by packageId field (the ESIMPackage id)
  const allEsim = await prisma.eSIMPackage.findMany({
    select: { id: true, costPriceUSD: true, costCurrency: true, priceUSD: true, currency: true, markupPercent: true, isActive: true, hiddenFromCatalog: true, name: true },
  })
  const esimMap = new Map(allEsim.map(e => [e.id, e]))

  for (let i = 1; i < lines.length; i++) {
    const ln = i + 1
    const cols = parseCsvLine(lines[i])
    const g = (n: string) => { const idx = ci[n]; return idx !== undefined && idx < cols.length ? cols[idx] : '' }

    const packageId = g('packageId').trim()
    const providerPlanId = g('providerPlanId').trim()

    // Resolve to a ProviderPackage
    let pp = packageId ? await prisma.providerPackage.findFirst({ where: { publishedAs: { id: packageId } } }) : null
    if (!pp && packageId) {
      // Maybe packageId is the ESIMPackage id — find via inverse relation
      pp = await prisma.providerPackage.findFirst({ where: { publishedAs: { id: packageId } } })
    }
    if (!pp && providerPlanId) {
      pp = await prisma.providerPackage.findFirst({ where: { providerPlanId } })
    }
    if (!pp) { errors.push({ line: ln, message: `No provider package found for packageId=${packageId} providerPlanId=${providerPlanId}` }); continue }

    const esim = linkedMap.get(pp.id)
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

    if (Object.keys(changes).length > 0) {
      preview.push({ providerPackageId: pp.id, name: pp.name, changes })
    }
  }

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'IMPORTED_PLAN_CSV_IMPORTED',
      entity: 'ProviderPackage',
      details: `Imported plans CSV preview — ${lines.length - 1} rows, ${errors.length} errors, ${preview.length} changes`,
    },
  })

  return { totalRows: lines.length - 1, validRows: lines.length - 1 - errors.length, errors, preview }
}

export async function applyImportedPlansCsvImport(formData: FormData): Promise<{
  applied: number; errors: { line: number; message: string }[]
}> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') return { applied: 0, errors: [] }

  const preview = await importImportedPlansCsvPreview(formData)
  if (preview.errors.length > 0 && preview.preview.length === 0) {
    return { applied: 0, errors: preview.errors }
  }

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

    let pp: any = packageId ? await prisma.providerPackage.findFirst({ where: { publishedAs: { id: packageId } }, include: { provider: true } }) : null
    if (!pp && packageId) {
      pp = await prisma.providerPackage.findFirst({ where: { publishedAs: { id: packageId } }, include: { provider: true } })
    }
    if (!pp && providerPlanId) pp = await prisma.providerPackage.findFirst({ where: { providerPlanId }, include: { provider: true } })
    if (!pp) { errors.push({ line: ln, message: `Package not found` }); continue }

    let esim = await prisma.eSIMPackage.findFirst({ where: { providerPackageId: pp.id } })
    const updateData: any = {}

    const costRaw = g('costPriceUSD')
    if (costRaw.trim()) {
      const n = parseNum(costRaw)
      if (n != null && n >= 0) updateData.costPriceUSD = n
    }

    const ccRaw = g('costCurrency')
    if (ccRaw.trim() && /^[A-Z]{3}$/i.test(ccRaw.trim())) updateData.costCurrency = ccRaw.trim().toUpperCase()

    const spRaw = g('sellingPrice')
    if (spRaw.trim()) {
      const n = parseNum(spRaw)
      if (n != null && n >= 0) updateData.priceUSD = n
    }

    const scRaw = g('sellingCurrency')
    if (scRaw.trim() && /^[A-Z]{3}$/i.test(scRaw.trim())) updateData.currency = scRaw.trim().toUpperCase()

    const mpRaw = g('markupPercent')
    if (mpRaw.trim()) {
      const n = parseNum(mpRaw)
      if (n != null && n >= 0) updateData.markupPercent = n
    }

    const iaRaw = g('isActive')
    if (iaRaw.trim()) {
      const b = parseBool(iaRaw)
      if (b != null) updateData.isActive = b
    }

    const hcRaw = g('hiddenFromCatalog')
    if (hcRaw.trim()) {
      const b = parseBool(hcRaw)
      if (b != null) updateData.hiddenFromCatalog = b
    }

    const ptcRaw = g('publishToCatalog')
    const shouldPublish = ptcRaw.trim() ? parseBool(ptcRaw) : null

    if (esim && Object.keys(updateData).length > 0) {
      await prisma.eSIMPackage.update({ where: { id: esim.id }, data: updateData })
    } else if (!esim && Object.keys(updateData).length > 0) {
      const name = g('name') || pp.name
      esim = await prisma.eSIMPackage.create({
        data: {
          name,
          dataGB: pp.dataGB,
          validityDays: pp.validityDays,
          providerName: pp.provider?.code || '',
          providerId: pp.providerId,
          providerPlanId: pp.providerPlanId,
          providerPackageId: pp.id,
          source: 'PROVIDER_PLAN',
          ...updateData,
          priceUSD: updateData.priceUSD || 0,
          currency: updateData.currency || 'USD',
        },
      })
    }

    if (shouldPublish === true && esim) {
      const hasCost = esim.costPriceUSD != null && Number(esim.costPriceUSD) > 0
      const hasPrice = esim.priceUSD != null && Number(esim.priceUSD) > 0
      if (hasCost && hasPrice) {
        await prisma.eSIMPackage.update({
          where: { id: esim.id },
          data: { source: 'CATALOG_PRODUCT', isActive: true, hiddenFromCatalog: false, archivedAt: null },
        })
      } else {
        errors.push({ line: ln, message: `publishToCatalog=true but cost/selling price missing` })
      }
    }

    applied++
  }

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'IMPORTED_PLAN_CSV_IMPORTED',
      entity: 'ProviderPackage',
      details: `Imported plans CSV import applied — ${applied} rows, ${errors.length} errors`,
    },
  })

  revalidatePath('/admin/imported-plans')
  revalidatePath('/admin/packages')
  return { applied, errors }
}
