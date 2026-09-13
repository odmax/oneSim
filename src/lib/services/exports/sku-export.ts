import { prisma } from '@/lib/prisma'
import { derivePublicSku } from '@/lib/catalog/public-sku'
import { derivePublicPackagePresentation } from '@/lib/catalog/public-package-presentation'

export interface SkuExportRow {
  sku: string
  packageCode: string
  name: string
  displayName: string | null
  description: string | null
  customerDescription: string | null
  dataGB: number
  validityDays: number
  currency: string
  price: number
  country: string | null
  region: string | null
  productType: string
  isActive: boolean
}

/**
 * Client-facing SKU export. The `sku`/`packageCode` values are the canonical
 * provider-neutral public SKU (derivePublicSku) — a provider-identifying
 * persisted SKU is never surfaced. `providerName` is intentionally NOT part of
 * the export: clients must never learn the upstream provider.
 */
export async function getSkuExportData(): Promise<SkuExportRow[]> {
  const packages = await prisma.eSIMPackage.findMany({
    where: { isActive: true, source: { in: ['CATALOG_PRODUCT', 'MANUAL'] }, archivedAt: null, hiddenFromCatalog: false },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      providerPackageId: true,
      sku: true,
      packageCode: true,
      name: true,
      displayName: true,
      description: true,
      customerDescription: true,
      dataGB: true,
      validityDays: true,
      currency: true,
      priceUSD: true,
      productType: true,
      isActive: true,
      providerName: true,
      providerPackage: { select: { country: true, region: true } },
    },
  })

  return packages.map(pkg => {
    const publicSku = derivePublicSku({
      id: pkg.id,
      providerPackageId: pkg.providerPackageId,
      country: pkg.providerPackage?.country,
      region: pkg.providerPackage?.region,
      dataGB: pkg.dataGB,
      validityDays: pkg.validityDays,
    })
    // Client-facing NAME fields must be provider-neutral as well (the SKU alone
    // is not enough — package copy may carry the upstream brand).
    const presentation = derivePublicPackagePresentation({
      name: pkg.name,
      displayName: pkg.displayName,
      description: pkg.description,
      customerDescription: pkg.customerDescription,
      country: pkg.providerPackage?.country,
      region: pkg.providerPackage?.region,
      dataGB: pkg.dataGB,
      validityDays: pkg.validityDays,
      providerName: pkg.providerName,
    })
    return {
      sku: publicSku,
      packageCode: publicSku,
      name: presentation.name,
      displayName: presentation.displayName,
      description: presentation.description,
      customerDescription: presentation.customerDescription,
      dataGB: pkg.dataGB,
      validityDays: pkg.validityDays,
      currency: pkg.currency || 'USD',
      price: parseFloat(pkg.priceUSD.toString()),
      country: pkg.providerPackage?.country || null,
      region: pkg.providerPackage?.region || null,
      productType: pkg.productType,
      isActive: pkg.isActive,
    }
  })
}

export function skuToJson(data: SkuExportRow[]): string {
  return JSON.stringify(data, null, 2)
}

export function skuToCsv(data: SkuExportRow[]): string {
  const headers = ['sku', 'packageCode', 'name', 'displayName', 'description', 'dataGB', 'validityDays', 'currency', 'price', 'country', 'region', 'productType', 'isActive']
  const lines = [headers.join(',')]

  for (const row of data) {
    const vals = headers.map(h => {
      const v = (row as any)[h]
      if (v === null || v === undefined) return ''
      const s = String(v)
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
    })
    lines.push(vals.join(','))
  }

  return lines.join('\n')
}

export function skuToXlsx(data: SkuExportRow[]): string {
  const headers = ['sku', 'packageCode', 'name', 'displayName', 'description', 'dataGB', 'validityDays', 'currency', 'price', 'country', 'region', 'productType', 'isActive']

  let html = '<table>'
  html += '<tr>' + headers.map(h => '<th>' + h + '</th>').join('') + '</tr>'

  for (const row of data) {
    html += '<tr>'
    for (const h of headers) {
      const v = (row as any)[h]
      html += '<td>' + (v !== null && v !== undefined ? String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : '') + '</td>'
    }
    html += '</tr>'
  }

  html += '</table>'
  return html
}