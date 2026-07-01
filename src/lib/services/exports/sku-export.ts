import { prisma } from '@/lib/prisma'

export interface SkuExportRow {
  sku: string | null
  packageCode: string | null
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
  providerName: string | null
  isActive: boolean
}

export async function getSkuExportData(): Promise<SkuExportRow[]> {
  const packages = await prisma.eSIMPackage.findMany({
    where: { isActive: true, source: { in: ['CATALOG_PRODUCT', 'MANUAL'] }, archivedAt: null, hiddenFromCatalog: false },
    orderBy: { name: 'asc' },
    select: {
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
      providerName: true,
      productType: true,
      isActive: true,
    },
  })

  return packages.map(pkg => ({
    sku: pkg.sku || null,
    packageCode: pkg.packageCode || null,
    name: pkg.name,
    displayName: pkg.displayName || null,
    description: pkg.description || null,
    customerDescription: pkg.customerDescription || null,
    dataGB: pkg.dataGB,
    validityDays: pkg.validityDays,
    currency: pkg.currency || 'USD',
    price: parseFloat(pkg.priceUSD.toString()),
    country: null,
    region: null,
    productType: pkg.productType,
    providerName: pkg.providerName || null,
    isActive: pkg.isActive,
  }))
}

export function skuToJson(data: SkuExportRow[]): string {
  return JSON.stringify(data, null, 2)
}

export function skuToCsv(data: SkuExportRow[]): string {
  const headers = ['sku', 'packageCode', 'name', 'displayName', 'description', 'customerDescription', 'dataGB', 'validityDays', 'currency', 'price', 'productType', 'providerName', 'isActive']
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
  const headers = ['sku', 'packageCode', 'name', 'displayName', 'description', 'customerDescription', 'dataGB', 'validityDays', 'currency', 'price', 'productType', 'providerName', 'isActive']

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
