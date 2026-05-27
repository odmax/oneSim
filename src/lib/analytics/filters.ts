export type DateRangePreset = 'all' | 'today' | '7d' | '30d' | 'thisMonth' | 'lastMonth' | 'custom'

export interface AnalyticsFilters {
  dateRange: DateRangePreset
  dateFrom?: string
  dateTo?: string
  providers: string[]
  regions: string[]
  countries: string[]
  businessId?: string
  packageId?: string
  statuses: string[]
}

export function parseFilters(searchParams: Record<string, string | string[] | undefined>): AnalyticsFilters {
  return {
    dateRange: (searchParams.dateRange as DateRangePreset) || 'all',
    dateFrom: searchParams.dateFrom as string | undefined,
    dateTo: searchParams.dateTo as string | undefined,
    providers: parseMultiParam(searchParams.providers),
    regions: parseMultiParam(searchParams.regions),
    countries: parseMultiParam(searchParams.countries),
    businessId: searchParams.businessId as string | undefined,
    packageId: searchParams.packageId as string | undefined,
    statuses: parseMultiParam(searchParams.statuses),
  }
}

function parseMultiParam(val: string | string[] | undefined): string[] {
  if (!val) return []
  if (Array.isArray(val)) return val
  return val.split(',').filter(Boolean)
}

export function computeDateRange(filters: AnalyticsFilters): { from?: Date; to?: Date } {
  const now = new Date()
  switch (filters.dateRange) {
    case 'today':
      return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()) }
    case '7d':
      return { from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) }
    case '30d':
      return { from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) }
    case 'thisMonth':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1) }
    case 'lastMonth':
      return {
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        to: new Date(now.getFullYear(), now.getMonth(), 0),
      }
    case 'custom':
      return {
        from: filters.dateFrom ? new Date(filters.dateFrom) : undefined,
        to: filters.dateTo ? new Date(filters.dateTo) : undefined,
      }
    default:
      return {}
  }
}

const countryRegionMap: Record<string, string> = {
  'South Africa': 'Africa', 'Nigeria': 'Africa', 'Kenya': 'Africa',
  'Ghana': 'Africa', 'Egypt': 'Africa', 'Morocco': 'Africa',
  'Tanzania': 'Africa', 'Uganda': 'Africa', 'Rwanda': 'Africa',
  'Zambia': 'Africa', 'Botswana': 'Africa', 'Mauritius': 'Africa',
  'United Kingdom': 'Europe', 'Germany': 'Europe', 'France': 'Europe',
  'Spain': 'Europe', 'Italy': 'Europe', 'Netherlands': 'Europe',
  'Switzerland': 'Europe', 'Sweden': 'Europe', 'Norway': 'Europe',
  'Denmark': 'Europe', 'Portugal': 'Europe', 'Ireland': 'Europe',
  'Poland': 'Europe', 'India': 'Asia', 'China': 'Asia', 'Japan': 'Asia',
  'South Korea': 'Asia', 'Singapore': 'Asia', 'Malaysia': 'Asia',
  'Indonesia': 'Asia', 'Thailand': 'Asia', 'Vietnam': 'Asia',
  'Philippines': 'Asia', 'Pakistan': 'Asia', 'Bangladesh': 'Asia',
  'United Arab Emirates': 'Asia', 'Saudi Arabia': 'Asia', 'Turkey': 'Asia',
  'Israel': 'Asia', 'United States': 'Americas', 'Canada': 'Americas',
  'Brazil': 'Americas', 'Mexico': 'Americas', 'Argentina': 'Americas',
  'Chile': 'Americas', 'Colombia': 'Americas', 'Peru': 'Americas',
  'Australia': 'Oceania', 'New Zealand': 'Oceania',
}

export function getRegionForCountry(country: string): string {
  return countryRegionMap[country] || 'Other'
}

export const REGIONS = ['Africa', 'Europe', 'Asia', 'Americas', 'Oceania', 'Other'] as const

export function getCountriesForRegions(regions: string[]): string[] {
  if (regions.length === 0) return []
  const result = new Set<string>()
  for (const [country, region] of Object.entries(countryRegionMap)) {
    if (regions.includes(region)) result.add(country)
  }
  if (regions.includes('Other')) {
    // Other includes any country not in the map - handled at query time
  }
  return Array.from(result)
}

export function buildPurchaseWhere(filters: AnalyticsFilters): any {
  const where: any = { status: 'COMPLETED' }
  const dateRange = computeDateRange(filters)
  if (dateRange.from || dateRange.to) {
    where.createdAt = {}
    if (dateRange.from) where.createdAt.gte = dateRange.from
    if (dateRange.to) where.createdAt.lte = dateRange.to
  }
  if (filters.businessId) where.businessId = filters.businessId
  if (filters.packageId) where.packageId = filters.packageId
  if (filters.providers.length > 0) {
    where.package = { providerId: { in: filters.providers } }
  }
  return where
}

export function buildDateClause(filters: AnalyticsFilters, alias: string): { clause: string; params: any[] } {
  const dateRange = computeDateRange(filters)
  const parts: string[] = []
  const params: any[] = []
  if (dateRange.from) {
    params.push(dateRange.from.toISOString())
    parts.push(`${alias}."createdAt" >= $${params.length}::timestamp`)
  }
  if (dateRange.to) {
    params.push(dateRange.to.toISOString())
    parts.push(`${alias}."createdAt" <= $${params.length}::timestamp`)
  }
  return { clause: parts.join(' AND '), params }
}

export function parseStatusFilterValue(val: string): string[] {
  switch (val.toUpperCase()) {
    case 'ACTIVE': return ['ACTIVE']
    case 'PENDING': return ['PENDING_ACTIVATION']
    case 'FAILED': return ['FAILED', 'ACTIVATION_FAILED']
    case 'EXPIRED': return ['EXPIRED']
    default: return [val]
  }
}

export function buildEsimStatusClause(filters: AnalyticsFilters): { clause: string; params: any[] } {
  if (filters.statuses.length === 0) return { clause: '', params: [] }
  const expanded: string[] = []
  for (const s of filters.statuses) {
    expanded.push(...parseStatusFilterValue(s))
  }
  const params = expanded.map(s => s)
  const placeholders = expanded.map((_, i) => `$${i + 1}`).join(', ')
  return { clause: `e."status" IN (${placeholders})`, params }
}

export function getCsvFilename(): string {
  const now = new Date()
  return `analytics-export-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.csv`
}

export function formatCsvValue(val: any): string {
  if (val === null || val === undefined) return ''
  const str = String(val)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

export function generateCsv(headers: string[], rows: any[][]): string {
  const headerRow = headers.map(h => formatCsvValue(h)).join(',')
  const dataRows = rows.map(row => row.map(cell => formatCsvValue(cell)).join(','))
  return [headerRow, ...dataRows].join('\n')
}
