'use server'

import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

const SAFE_FIELDS = ['sellingPrice', 'sellingCurrency', 'markupPercent', 'pricingMode', 'publishStatus', 'configurationStatus', 'tags', 'notes'] as const
type SafeField = typeof SAFE_FIELDS[number]

const FIELD_MAP: Record<string, SafeField> = {
  sellingPrice: 'sellingPrice',
  sellingCurrency: 'sellingCurrency',
  markupPercent: 'markupPercent',
  pricingMode: 'pricingMode',
  publishStatus: 'publishStatus',
  configurationStatus: 'configurationStatus',
  tags: 'tags',
  notes: 'notes',
}

interface ImportRow {
  providerPackageId: string
  changes: Record<string, string>
}

function parseCSV(text: string): ImportRow[] {
  const lines = text.trim().split('\n')
  if (lines.length < 2) return []

  const headerLine = lines[0]
  const headers = parseCSVLine(headerLine)
  const idIdx = headers.indexOf('providerPackageId')
  if (idIdx < 0) return []

  const rows: ImportRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i])
    const id = values[idIdx]?.trim()
    if (!id) continue

    const changes: Record<string, string> = {}
    for (const h of headers) {
      const fieldKey = FIELD_MAP[h]
      if (!fieldKey) continue
      const idx = headers.indexOf(h)
      const val = values[idx]?.trim()
      if (val === '' || val === undefined) continue
      // Only include if value differs from header (meaningful change)
      changes[fieldKey] = val
    }

    if (Object.keys(changes).length > 0) {
      rows.push({ providerPackageId: id, changes })
    }
  }

  return rows
}

function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++ }
        else inQuotes = false
      } else { current += ch }
    } else {
      if (ch === '"') { inQuotes = true }
      else if (ch === ',') { result.push(current); current = '' }
      else { current += ch }
    }
  }
  result.push(current)
  return result
}

export async function importCatalogCSV(formData: FormData): Promise<{ success: boolean; total?: number; updated?: number; errors?: number; error?: string }> {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') {
    return { success: false, error: 'Unauthorized' }
  }

  const file = formData.get('file') as File
  if (!file) return { success: false, error: 'No file provided' }

  let text: string
  try {
    text = await file.text()
  } catch {
    return { success: false, error: 'Failed to read file' }
  }

  const rows = parseCSV(text)
  if (rows.length === 0) return { success: false, error: 'No valid rows found. Ensure CSV has providerPackageId column.' }

  let updated = 0
  let errors = 0

  for (const row of rows) {
    try {
      const updateData: any = {}
      if (row.changes.sellingPrice) updateData.sellingPrice = parseFloat(row.changes.sellingPrice)
      if (row.changes.sellingCurrency) updateData.sellingCurrency = row.changes.sellingCurrency
      if (row.changes.markupPercent) updateData.markupPercent = parseFloat(row.changes.markupPercent)
      if (row.changes.pricingMode) updateData.pricingMode = row.changes.pricingMode
      if (row.changes.publishStatus) updateData.publishStatus = row.changes.publishStatus
      if (row.changes.configurationStatus) { updateData.configurationStatus = row.changes.configurationStatus; updateData.lastConfiguredAt = new Date() }
      if (row.changes.tags) updateData.tags = row.changes.tags.split(/[;,]/).map(s => s.trim()).filter(Boolean)
      if (row.changes.notes) updateData.notes = row.changes.notes

      if (Object.keys(updateData).length === 0) { errors++; continue }

      await prisma.providerPackage.update({
        where: { id: row.providerPackageId },
        data: updateData,
      })
      updated++
    } catch { errors++ }
  }

  await prisma.auditLog.create({
    data: { userId: session.user.id, action: 'CATALOG_CSV_IMPORT', entity: 'ProviderPackage', details: `Imported ${rows.length} rows: ${updated} updated, ${errors} errors` },
  }).catch(() => {})

  revalidatePath('/admin/provider-catalog')
  return { success: true, total: rows.length, updated, errors }
}
