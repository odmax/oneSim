import type { TelnaPackage, TelnaTimeAllowance, TelnaDataAllowance, MappedTelnaPackage } from '../connectors/telna-endpoints'
import { buildComparableKey } from '@/lib/packages/cheapest-utils'

const DAYS_PER_UNIT: Record<string, number | null> = {
  DAY: 1,
  WEEK: 7,
  MONTH: 30,
  CALENDAR_MONTH: null,
  HOUR: null,
}

function mapTimeAllowance(ta: TelnaTimeAllowance | null | undefined): { validityDays: number | null; warnings: string[] } {
  const warnings: string[] = []
  if (!ta || typeof ta.value !== 'number' || !ta.unit) {
    return { validityDays: null, warnings: [] }
  }
  const mult = DAYS_PER_UNIT[ta.unit]
  if (mult !== undefined) {
    if (mult === null) {
      warnings.push(`Cannot safely convert time allowance unit "${ta.unit}" to days; original value=${ta.value}`)
      return { validityDays: null, warnings }
    }
    return { validityDays: ta.value * mult, warnings }
  }
  warnings.push(`Unknown time allowance unit "${ta.unit}"; cannot normalize`)
  return { validityDays: null, warnings }
}

function mapDataAllowance(da: TelnaDataAllowance | null | undefined): { dataBytes: number | null; dataGB: number | null; warnings: string[] } {
  const warnings: string[] = []
  if (!da || typeof da.value !== 'number' || !da.unit) {
    return { dataBytes: null, dataGB: null, warnings: [] }
  }
  if (da.unit.toUpperCase() === 'UNLIMITED') {
    return { dataBytes: null, dataGB: null, warnings }
  }
  let dataBytes: number | null = null
  let dataGB: number | null = null
  switch (da.unit.toUpperCase()) {
    case 'KB':
      dataBytes = Math.round(da.value * 1024)
      dataGB = da.value / (1024 * 1024)
      break
    case 'MB':
      dataBytes = Math.round(da.value * 1024 * 1024)
      dataGB = da.value / 1024
      break
    case 'GB':
      dataBytes = Math.round(da.value * 1024 * 1024 * 1024)
      dataGB = da.value
      break
    case 'TB':
      dataBytes = Math.round(da.value * 1024 * 1024 * 1024 * 1024)
      dataGB = da.value * 1024
      break
    default:
      warnings.push(`Unknown data allowance unit "${da.unit}"; value=${da.value}`)
      return { dataBytes: null, dataGB: null, warnings }
  }
  return { dataBytes, dataGB, warnings }
}

function extractCostPrice(raw: TelnaPackage): number | null {
  const price = raw.price
  if (typeof price === 'number') return price
  if (price && typeof price === 'object' && 'amount' in price) return price.amount
  return null
}

function extractCurrency(raw: TelnaPackage): string {
  if (raw.currency) return raw.currency
  const price = raw.price
  if (price && typeof price === 'object' && 'currency' in price) return price.currency
  return ''
}

function mapCoverage(raw: TelnaPackage): { country: string | null; region: string | null; countryCodes: string[]; warnings: string[] } {
  const warnings: string[] = []
  let country: string | null = null
  let region: string | null = null
  const countryCodes: string[] = []

  const rawCountries = raw.countries
  if (Array.isArray(rawCountries)) {
    for (const c of rawCountries) {
      if (c && typeof c === 'object') {
        if (!country && c.name) country = c.name
        if (c.iso) countryCodes.push(c.iso)
        if (c.code) countryCodes.push(c.code)
      }
    }
  }
  const rawZones = raw.zones
  if (Array.isArray(rawZones)) {
    for (const zone of rawZones) {
      if (!region && zone.name) region = zone.name
      if (zone.countryCodes && Array.isArray(zone.countryCodes)) {
        for (const cc of zone.countryCodes) {
          if (cc && !countryCodes.includes(cc)) countryCodes.push(cc)
        }
      }
      if (zone.countries && Array.isArray(zone.countries)) {
        for (const c of zone.countries) {
          if (c && typeof c === 'object') {
            if (!country && c.name) country = c.name
            if (c.iso && !countryCodes.includes(c.iso)) countryCodes.push(c.iso)
          }
        }
      }
    }
  }
  if (rawCountries && !Array.isArray(rawCountries)) {
    warnings.push('countries field present but not an array')
  }
  if (rawZones && !Array.isArray(rawZones)) {
    warnings.push('zones field present but not an array')
  }
  if (!country && !region && countryCodes.length === 0) {
    warnings.push('No coverage information found on package')
  }
  return { country, region, countryCodes: [...new Set(countryCodes)], warnings }
}

export function mapTelnaPackage(pkg: TelnaPackage): MappedTelnaPackage {
  const warnings: string[] = []

  const id = String(pkg.id ?? '')
  if (!id) warnings.push('Package has no id')

  const ta = pkg.time_allowance
  const timeResult = mapTimeAllowance(ta)
  warnings.push(...timeResult.warnings)

  const da = pkg.data_allowance
  const dataResult = mapDataAllowance(da)
  warnings.push(...dataResult.warnings)

  const coverage = mapCoverage(pkg)
  warnings.push(...coverage.warnings)

  const costPrice = extractCostPrice(pkg)
  const currency = extractCurrency(pkg)

  const planType = pkg.coverage_type || pkg.type || null
  const coverageType = pkg.coverage_type || null
  const isAvailable = pkg.status === 'ACTIVE'

  const { ...rest } = pkg
  const rawData: Record<string, unknown> = { ...rest }

  return {
    providerPackageId: id,
    providerTemplateId: pkg.package_template_id != null ? String(pkg.package_template_id) : null,
    name: pkg.name ?? '',
    status: pkg.status ?? 'UNKNOWN',
    currency,
    costPrice,
    dataGB: dataResult.dataGB != null ? Math.round(dataResult.dataGB * 100) / 100 : null,
    dataBytes: dataResult.dataBytes,
    validityDays: timeResult.validityDays,
    country: coverage.country,
    region: coverage.region,
    countryCodes: coverage.countryCodes,
    coverageType,
    planType,
    isAvailable,
    warnings,
    rawData,
  }
}

export function computePackageComparableKey(mapped: MappedTelnaPackage): string {
  return buildComparableKey({
    country: mapped.country,
    region: mapped.region,
    planType: mapped.planType,
    dataGB: mapped.dataGB ?? 0,
    validityDays: mapped.validityDays ?? 30,
  })
}
