'use server'

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { revalidatePath } from 'next/cache'

const CSV_COLUMNS = [
  'packageId', 'source', 'providerCode', 'providerName', 'providerPlanId',
  'sku', 'name', 'dataGB', 'validityDays', 'country',
  'costPriceUSD', 'costCurrency', 'sellingPrice', 'sellingCurrency',
  'markupPercent', 'isActive', 'hiddenFromCatalog', 'archivedAt',
]

function sanitizeCsvValue(val: any): string {
  const str = val == null ? '' : String(val)
  if (str === '') return '""'
  if (/^[=+\-@]/.test(str)) return `"'${str}"`
  if (/[,"\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

function exportPricesAsCsv(rows: any[]): string {
  const header = CSV_COLUMNS.map(sanitizeCsvValue).join(',')
  const lines = rows.map(row =>
    CSV_COLUMNS.map(col => sanitizeCsvValue(row[col])).join(',')
  )
  return [header, ...lines].join('\r\n')
}

function parseBoolean(val: string): boolean | null {
  const lower = val.trim().toLowerCase()
  if (['true', '1', 'yes'].includes(lower)) return true
  if (['false', '0', 'no'].includes(lower)) return false
  return null
}

function parseNumeric(val: string): number | null {
  const trimmed = val.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return isNaN(n) ? null : n
}

function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; continue }
      inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current.trim())
  return result
}

export async function exportPricingCsv(): Promise<string> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    throw new Error('Unauthorized')
  }

  const packages = await prisma.eSIMPackage.findMany({
    orderBy: { name: 'asc' },
  })

  const rows = packages.map(pkg => ({
    packageId: pkg.id,
    source: pkg.source,
    providerCode: pkg.providerName || '',
    providerName: pkg.providerName || '',
    providerPlanId: pkg.providerPlanId || '',
    sku: pkg.sku || '',
    name: pkg.name,
    dataGB: pkg.dataGB,
    validityDays: pkg.validityDays,
    country: '',
    costPriceUSD: pkg.costPriceUSD != null ? Number(pkg.costPriceUSD) : '',
    costCurrency: pkg.costCurrency || 'USD',
    sellingPrice: Number(pkg.priceUSD),
    sellingCurrency: pkg.currency || 'USD',
    markupPercent: pkg.markupPercent != null ? Number(pkg.markupPercent) : '',
    isActive: pkg.isActive ? '1' : '0',
    hiddenFromCatalog: pkg.hiddenFromCatalog ? '1' : '0',
    archivedAt: pkg.archivedAt ? pkg.archivedAt.toISOString() : '',
  }))

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'PRICING_CSV_EXPORTED',
      entity: 'ESIMPackage',
      details: `Pricing CSV exported — ${rows.length} packages`,
    },
  })

  return exportPricesAsCsv(rows)
}

export async function importPricingCsvPreview(formData: FormData): Promise<{
  totalRows: number
  validRows: number
  errors: { line: number; message: string }[]
  preview: { packageId: string; name: string; changes: Record<string, { from: any; to: any }> }[]
}> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    throw new Error('Unauthorized')
  }

  const file = formData.get('file') as File
  if (!file) throw new Error('No file provided')
  if (!file.name.endsWith('.csv')) throw new Error('File must be CSV')
  if (file.size > 5 * 1024 * 1024) throw new Error('File too large (max 5MB)')

  const text = await file.text()
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '')
  if (lines.length < 2) throw new Error('CSV must have header + at least one data row')

  const header = parseCsvLine(lines[0])
  const colIndex: Record<string, number> = {}
  for (let i = 0; i < header.length; i++) {
    colIndex[header[i].trim()] = i
  }

  const requiredCols = ['packageId']
  for (const col of requiredCols) {
    if (!(col in colIndex)) throw new Error(`Missing required column: ${col}`)
  }

  const errors: { line: number; message: string }[] = []
  const preview: { packageId: string; name: string; changes: Record<string, { from: any; to: any }> }[] = []

  const existing = await prisma.eSIMPackage.findMany({
    select: {
      id: true, name: true, costPriceUSD: true, costCurrency: true,
      priceUSD: true, currency: true, markupPercent: true,
      isActive: true, hiddenFromCatalog: true,
    },
  })
  const existingMap = new Map(existing.map(p => [p.id, p]))

  for (let i = 1; i < lines.length; i++) {
    const lineNum = i + 1
    const cols = parseCsvLine(lines[i])
    const getCol = (name: string): string => {
      const idx = colIndex[name]
      return idx !== undefined && idx < cols.length ? cols[idx] : ''
    }

    const packageId = getCol('packageId').trim()
    if (!packageId) { errors.push({ line: lineNum, message: 'Missing packageId' }); continue }

    const pkg = existingMap.get(packageId)
    if (!pkg) { errors.push({ line: lineNum, message: `Package not found: ${packageId}` }); continue }

    const changes: Record<string, { from: any; to: any }> = {}

    const costPriceRaw = getCol('costPriceUSD')
    if (costPriceRaw.trim() !== '') {
      const n = parseNumeric(costPriceRaw)
      if (n === null || n < 0) { errors.push({ line: lineNum, message: `Invalid costPriceUSD: "${costPriceRaw}"` }); continue }
      if (n !== Number(pkg.costPriceUSD)) changes.costPriceUSD = { from: pkg.costPriceUSD, to: n }
    }

    const costCurrencyRaw = getCol('costCurrency')
    if (costCurrencyRaw.trim() !== '') {
      if (!/^[A-Z]{3}$/.test(costCurrencyRaw.trim().toUpperCase())) { errors.push({ line: lineNum, message: `Invalid costCurrency: "${costCurrencyRaw}"` }); continue }
      if (costCurrencyRaw.trim().toUpperCase() !== (pkg.costCurrency || 'USD')) changes.costCurrency = { from: pkg.costCurrency || 'USD', to: costCurrencyRaw.trim().toUpperCase() }
    }

    const sellingPriceRaw = getCol('sellingPrice')
    if (sellingPriceRaw.trim() !== '') {
      const n = parseNumeric(sellingPriceRaw)
      if (n === null || n < 0) { errors.push({ line: lineNum, message: `Invalid sellingPrice: "${sellingPriceRaw}"` }); continue }
      if (n !== Number(pkg.priceUSD)) changes.sellingPrice = { from: Number(pkg.priceUSD), to: n }
    }

    const sellingCurrencyRaw = getCol('sellingCurrency')
    if (sellingCurrencyRaw.trim() !== '') {
      if (!/^[A-Z]{3}$/.test(sellingCurrencyRaw.trim().toUpperCase())) { errors.push({ line: lineNum, message: `Invalid sellingCurrency: "${sellingCurrencyRaw}"` }); continue }
      if (sellingCurrencyRaw.trim().toUpperCase() !== pkg.currency) changes.sellingCurrency = { from: pkg.currency, to: sellingCurrencyRaw.trim().toUpperCase() }
    }

    const markupRaw = getCol('markupPercent')
    if (markupRaw.trim() !== '') {
      const n = parseNumeric(markupRaw)
      if (n === null || n < 0) { errors.push({ line: lineNum, message: `Invalid markupPercent: "${markupRaw}"` }); continue }
      if (n !== Number(pkg.markupPercent)) changes.markupPercent = { from: pkg.markupPercent, to: n }
    }

    const isActiveRaw = getCol('isActive')
    if (isActiveRaw.trim() !== '') {
      const b = parseBoolean(isActiveRaw)
      if (b === null) { errors.push({ line: lineNum, message: `Invalid isActive: "${isActiveRaw}"` }); continue }
      if (b !== pkg.isActive) changes.isActive = { from: pkg.isActive, to: b }
    }

    const hiddenRaw = getCol('hiddenFromCatalog')
    if (hiddenRaw.trim() !== '') {
      const b = parseBoolean(hiddenRaw)
      if (b === null) { errors.push({ line: lineNum, message: `Invalid hiddenFromCatalog: "${hiddenRaw}"` }); continue }
      if (b !== pkg.hiddenFromCatalog) changes.hiddenFromCatalog = { from: pkg.hiddenFromCatalog, to: b }
    }

    if (Object.keys(changes).length > 0) {
      preview.push({ packageId, name: pkg.name, changes })
    }
  }

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'PRICING_CSV_PREVIEWED',
      entity: 'ESIMPackage',
      details: `Pricing CSV import previewed — ${lines.length - 1} total rows, ${errors.length} errors, ${preview.length} rows with changes`,
    },
  })

  return {
    totalRows: lines.length - 1,
    validRows: lines.length - 1 - errors.length,
    errors,
    preview,
  }
}

export async function applyPricingCsvImport(formData: FormData): Promise<{
  applied: number
  errors: { line: number; message: string }[]
}> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    throw new Error('Unauthorized')
  }

  const previewResult = await importPricingCsvPreview(formData)
  if (previewResult.errors.length > 0 && previewResult.preview.length === 0) {
    return { applied: 0, errors: previewResult.errors }
  }

  let applied = 0
  const errors: { line: number; message: string }[] = []

  const file = formData.get('file') as File
  const text = await file.text()
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '')
  const header = parseCsvLine(lines[0])
  const colIndex: Record<string, number> = {}
  for (let i = 0; i < header.length; i++) colIndex[header[i].trim()] = i

  for (let i = 1; i < lines.length; i++) {
    const lineNum = i + 1
    const cols = parseCsvLine(lines[i])
    const getCol = (name: string): string => {
      const idx = colIndex[name]
      return idx !== undefined && idx < cols.length ? cols[idx] : ''
    }

    const packageId = getCol('packageId').trim()
    if (!packageId) { errors.push({ line: lineNum, message: 'Missing packageId' }); continue }

    const pkg = await prisma.eSIMPackage.findUnique({ where: { id: packageId } })
    if (!pkg) { errors.push({ line: lineNum, message: `Package not found: ${packageId}` }); continue }

    const updateData: any = {}

    const costPriceRaw = getCol('costPriceUSD')
    if (costPriceRaw.trim() !== '') {
      const n = parseNumeric(costPriceRaw)
      if (n !== null && n >= 0 && n !== Number(pkg.costPriceUSD)) updateData.costPriceUSD = n
    }

    const costCurrencyRaw = getCol('costCurrency')
    if (costCurrencyRaw.trim() !== '') {
      if (/^[A-Z]{3}$/.test(costCurrencyRaw.trim().toUpperCase())) {
        const v = costCurrencyRaw.trim().toUpperCase()
        if (v !== (pkg.costCurrency || 'USD')) updateData.costCurrency = v
      }
    }

    const sellingPriceRaw = getCol('sellingPrice')
    if (sellingPriceRaw.trim() !== '') {
      const n = parseNumeric(sellingPriceRaw)
      if (n !== null && n >= 0 && n !== Number(pkg.priceUSD)) updateData.priceUSD = n
    }

    const sellingCurrencyRaw = getCol('sellingCurrency')
    if (sellingCurrencyRaw.trim() !== '') {
      if (/^[A-Z]{3}$/.test(sellingCurrencyRaw.trim().toUpperCase())) {
        const v = sellingCurrencyRaw.trim().toUpperCase()
        if (v !== pkg.currency) updateData.currency = v
      }
    }

    const markupRaw = getCol('markupPercent')
    if (markupRaw.trim() !== '') {
      const n = parseNumeric(markupRaw)
      if (n !== null && n >= 0 && n !== Number(pkg.markupPercent)) updateData.markupPercent = n
    }

    const isActiveRaw = getCol('isActive')
    if (isActiveRaw.trim() !== '') {
      const b = parseBoolean(isActiveRaw)
      if (b !== null && b !== pkg.isActive) updateData.isActive = b
    }

    const hiddenRaw = getCol('hiddenFromCatalog')
    if (hiddenRaw.trim() !== '') {
      const b = parseBoolean(hiddenRaw)
      if (b !== null && b !== pkg.hiddenFromCatalog) updateData.hiddenFromCatalog = b
    }

    if (Object.keys(updateData).length > 0) {
      await prisma.eSIMPackage.update({
        where: { id: packageId },
        data: updateData,
      })
      applied++
    }
  }

  await prisma.auditLog.create({
    data: {
      userId: session.user.id,
      action: 'PRICING_CSV_IMPORTED',
      entity: 'ESIMPackage',
      details: `Pricing CSV import applied — ${applied} packages updated, ${errors.length} errors`,
    },
  })

  revalidatePath('/admin/packages')
  return { applied, errors }
}
