import type { TelnaPackageTemplate, TelnaPackageTemplateDetail, TelnaTimeAllowance, TelnaDataAllowance, TelnaPriceInfo, MappedTelnaPackageTemplate } from '../connectors/telna-endpoints'

const DAYS_PER_UNIT: Record<string, number | null> = {
  DAY: 1,
  WEEK: 7,
  MONTH: 30,
  CALENDAR_MONTH: null,
  HOUR: null,
}

function mapTimeAllowance(ta: TelnaTimeAllowance | null | undefined): { validityDays: number | null; timeAllowance: { value: number; unit: string } | null; warnings: string[] } {
  const warnings: string[] = []
  if (!ta || typeof ta.value !== 'number' || !ta.unit) {
    return { validityDays: null, timeAllowance: null, warnings: [] }
  }
  const mult = DAYS_PER_UNIT[ta.unit]
  if (mult !== undefined) {
    if (mult === null) {
      warnings.push(`Cannot safely convert time allowance unit "${ta.unit}" to days; original value=${ta.value}`)
      return { validityDays: null, timeAllowance: { value: ta.value, unit: ta.unit }, warnings }
    }
    return { validityDays: ta.value * mult, timeAllowance: { value: ta.value, unit: ta.unit }, warnings }
  }
  warnings.push(`Unknown time allowance unit "${ta.unit}"; cannot normalize`)
  return { validityDays: null, timeAllowance: { value: ta.value, unit: ta.unit }, warnings }
}

function mapDataAllowance(da: TelnaDataAllowance | null | undefined): {
  dataBytes: number | null; dataMB: number | null; dataGB: number | null; unlimitedData: boolean; warnings: string[]
} {
  const warnings: string[] = []
  if (!da || typeof da.value !== 'number' || !da.unit) {
    return { dataBytes: null, dataMB: null, dataGB: null, unlimitedData: false, warnings: [] }
  }

  if (da.unit.toUpperCase() === 'UNLIMITED') {
    return { dataBytes: null, dataMB: null, dataGB: null, unlimitedData: true, warnings }
  }

  let dataBytes: number | null = null
  let dataMB: number | null = null
  let dataGB: number | null = null

  switch (da.unit.toUpperCase()) {
    case 'KB':
      dataBytes = Math.round(da.value * 1024)
      dataMB = da.value / 1024
      dataGB = da.value / (1024 * 1024)
      break
    case 'MB':
      dataBytes = Math.round(da.value * 1024 * 1024)
      dataMB = da.value
      dataGB = da.value / 1024
      break
    case 'GB':
      dataBytes = Math.round(da.value * 1024 * 1024 * 1024)
      dataMB = da.value * 1024
      dataGB = da.value
      break
    case 'TB':
      dataBytes = Math.round(da.value * 1024 * 1024 * 1024 * 1024)
      dataMB = da.value * 1024 * 1024
      dataGB = da.value * 1024
      break
    default:
      warnings.push(`Unknown data allowance unit "${da.unit}"; value=${da.value}`)
      return { dataBytes: null, dataMB: null, dataGB: null, unlimitedData: false, warnings }
  }

  return { dataBytes, dataMB, dataGB, unlimitedData: false, warnings }
}

function extractProviderCost(raw: TelnaPackageTemplate | TelnaPackageTemplateDetail): number | null {
  const price = raw.price
  if (typeof price === 'number') return price
  if (price && typeof price === 'object' && 'amount' in price) {
    return (price as TelnaPriceInfo).amount
  }
  const charging = raw.charging
  if (charging && typeof charging.amount === 'number') return charging.amount
  return null
}

function extractCurrency(raw: TelnaPackageTemplate | TelnaPackageTemplateDetail): string {
  if (raw.currency) return raw.currency
  const price = raw.price
  if (price && typeof price === 'object' && 'currency' in price) {
    return (price as TelnaPriceInfo).currency
  }
  const charging = raw.charging
  if (charging?.currency) return charging.currency
  return ''
}

function extractFees(raw: TelnaPackageTemplate | TelnaPackageTemplateDetail): Array<{ type: string; amount: number; currency: string; chargeTiming: string }> {
  const fees: Array<{ type: string; amount: number; currency: string; chargeTiming: string }> = []
  const currency = extractCurrency(raw) || 'USD'

  // Activation/one-time charge from charging field
  if (raw.charging && typeof raw.charging.amount === 'number' && raw.charging.amount > 0) {
    fees.push({ type: 'ACTIVATION', amount: raw.charging.amount, currency: raw.charging.currency || currency, chargeTiming: 'AT_ACTIVATION' })
  }

  // Recurring fee
  if (raw.recurring?.enabled && raw.recurring?.renewal_price != null && raw.recurring.renewal_price > 0) {
    fees.push({ type: 'RECURRING', amount: raw.recurring.renewal_price, currency: raw.recurring.period?.unit ? currency : 'USD', chargeTiming: 'MONTHLY' })
  }

  return fees
}

function mapCoverage(raw: TelnaPackageTemplate | TelnaPackageTemplateDetail): {
  countries: string[]; countryCodes: string[]; regions: string[]; warnings: string[]
} {
  const warnings: string[] = []
  const countryNames: string[] = []
  const countryCodes: string[] = []
  const regions: string[] = []

  const rawCountries = raw.countries
  if (Array.isArray(rawCountries)) {
    for (const c of rawCountries) {
      if (c && typeof c === 'object') {
        if (c.name) countryNames.push(c.name)
        if (c.iso) countryCodes.push(c.iso)
        if (c.code) countryCodes.push(c.code)
      }
    }
  }

  const rawZones = raw.zones
  if (Array.isArray(rawZones)) {
    for (const zone of rawZones) {
      if (zone.name) regions.push(zone.name)
      if (zone.type) regions.push(zone.type)
      if (zone.countryCodes && Array.isArray(zone.countryCodes)) {
        for (const cc of zone.countryCodes) {
          if (cc && !countryCodes.includes(cc)) countryCodes.push(cc)
        }
      }
      if (zone.countries && Array.isArray(zone.countries)) {
        for (const c of zone.countries) {
          if (c && typeof c === 'object') {
            if (c.name && !countryNames.includes(c.name)) countryNames.push(c.name)
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

  if (countryNames.length === 0 && countryCodes.length === 0 && regions.length === 0) {
    warnings.push('No coverage information found on template')
  }

  return { countries: countryNames, countryCodes: [...new Set(countryCodes)], regions: [...new Set(regions)], warnings }
}

export function mapTelnaPackageTemplate(template: TelnaPackageTemplate | TelnaPackageTemplateDetail): MappedTelnaPackageTemplate {
  const warnings: string[] = []

  const id = String(template.id ?? '')
  if (!id) warnings.push('Template has no id')

  const ta = template.time_allowance
  const timeResult = mapTimeAllowance(ta)
  warnings.push(...timeResult.warnings)

  const da = template.data_allowance
  const dataResult = mapDataAllowance(da)
  warnings.push(...dataResult.warnings)

  const coverage = mapCoverage(template)
  warnings.push(...coverage.warnings)

  const providerCost = extractProviderCost(template)
  const currency = extractCurrency(template)

  const { ...rest } = template
  const rawData: Record<string, unknown> = { ...rest }

  return {
    providerTemplateId: id,
    name: template.name ?? '',
    description: template.description ?? null,
    inventoryId: template.inventory_id != null ? Number(template.inventory_id) : null,
    status: template.status ?? 'UNKNOWN',
    currency,
    providerCost,
    dataAllowance: da ? { value: da.value, unit: da.unit } : null,
    dataBytes: dataResult.dataBytes,
    dataMB: dataResult.dataMB,
    dataGB: dataResult.dataGB,
    unlimitedData: dataResult.unlimitedData,
    timeAllowance: timeResult.timeAllowance,
    validityDays: timeResult.validityDays,
    countries: coverage.countries,
    countryCodes: coverage.countryCodes,
    regions: coverage.regions,
    trafficPolicyId: template.traffic_policy_id != null ? String(template.traffic_policy_id) : null,
    routePolicyId: template.route_policy_id != null ? String(template.route_policy_id) : null,
    warnings,
    fees: extractFees(template), // Phase 5C — extracted fees
    rawData,
  }
}
