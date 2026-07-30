export type ImportResult = {
  success: boolean
  planId: string
  planName: string
  reason?: string
  packageId?: string
  normalizedDebug?: NormalizedDebug
  _clientId?: string
}

export type NormalizedDebug = {
  providerPlanId: string
  sku: string
  name: string
  dataGB: number
  validityDays: number
  costPriceUSD: number
  providerId?: string
  missingFields: string[]
  rawKeys: string[]
}

export type NormalizedPlan = {
  providerPlanId: string
  sku: string
  name: string
  dataGB: number
  validityDays: number
  costPriceUSD: number
  description: string
  rawData: any
  templateVersion?: string
  normalizedDebug: NormalizedDebug
  // Phase 5C — Provider Cost Normalization
  providerCost?: {
    amount: number
    currency: string
    source?: string
    isTaxInclusive?: boolean
    taxAmount?: number
    receivedAt?: Date
    expiresAt?: Date
    fees?: Array<{ type: string; amount: number; currency: string; chargeTiming: string; label?: string }>
    derivationMethod?: string
    derivationConfig?: Record<string, unknown>
  }
}

export type ProviderCostMapping = {
  strategy:
    | 'DIRECT_COST'
    | 'WHOLESALE_PRICE'
    | 'NET_PRICE'
    | 'RETAIL_MINUS_COMMISSION'
    | 'RETAIL_MINUS_COMMISSION_PERCENT'
    | 'RETAIL_DISCOUNT_PERCENT'
  amountPath?: string
  currencyPath?: string
  retailPricePath?: string
  commissionAmountPath?: string
  commissionPercentPath?: string
  discountPercentPath?: string
  taxAmountPath?: string
  taxInclusivePath?: string
  activationFeePath?: string
  recurringFeePath?: string
}

const CURRENCY_FIELDS = ['currency', 'currencyCode', 'currency_code', 'Currency', 'planCurrency']

const PLAN_ID_FIELDS = ['id', 'planId', 'plan_id', 'bundle_code', 'code', 'sku', 'productCode', 'product_code', 'ratePlanId', 'bundle_template_id']
const PLAN_NAME_FIELDS = ['name', 'planName', 'plan_name', 'bundle_name', 'productName', 'product_name', 'description', 'title']
const PLAN_DATAGB_FIELDS = ['data_gb', 'dataGB', 'dataGb', 'data', 'volume_gb', 'volumeGB', 'mb', 'dataMB', 'data_mb', 'allowance', 'rate_group_allowance']
const PLAN_VALIDITY_FIELDS = ['validity_days', 'validityDays', 'validity', 'days', 'duration_days', 'durationDays', 'duration', 'period', 'rate_group_allow_days']
const PLAN_PRICE_FIELDS = ['price_usd', 'priceUSD', 'price', 'cost_price', 'costPrice', 'costPriceUSD', 'retail_price', 'selling_price']
const PLAN_DESC_FIELDS = ['description', 'desc', 'notes', 'summary']

function getField(obj: any, fields: string[]): any {
  for (const field of fields) {
    const val = obj?.[field]
    if (val !== undefined && val !== null && val !== '') return val
  }
  return undefined
}

function normalizePlanValue(value: any, toType: 'int' | 'float'): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const cleaned = value.trim()
    if (toType === 'int') return parseInt(cleaned, 10) || 0
    return parseFloat(cleaned) || 0
  }
  return 0
}

function hashString(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

export function getStablePlanId(plan: any): string {
  const primary = plan.providerPlanId || plan.sku || plan.id || plan.code || plan.planId || plan.bundle_code
  if (primary) return String(primary)
  // Fallback: raw_data fields
  const raw = plan.raw_data || plan.providerRawData || plan
  if (raw && typeof raw === 'object') {
    const rawId = raw.bundle_template_id || raw.sku || raw.id || raw.bundle_code || raw.code || raw.planId
    if (rawId) return `raw_${rawId}`
    if (raw.name) return `raw_${raw.name.replace(/\s+/g, '_')}`
    try {
      const json = JSON.stringify(raw)
      if (json && json.length > 2) return `h_${hashString(json)}`
    } catch {}
  }
  return `${plan.name || 'p'}_${plan.data_gb || 0}_${plan.validity_days || 0}`
}

function getRawData(planData: any): any {
  return planData?.raw_data || planData?.providerRawData || null
}

function fallbackField(planData: any, fallbackNames: string[]): any {
  // Check raw_data/providerRawData for the field
  for (const src of ['raw_data', 'providerRawData']) {
    const inner = planData?.[src]
    if (inner && typeof inner === 'object') {
      for (const name of fallbackNames) {
        const val = inner[name]
        if (val !== undefined && val !== null && val !== '') return val
      }
    }
  }
  return undefined
}

export function normalizePlan(raw: any): NormalizedPlan {
  const planData = typeof raw === 'object' ? raw : {}
  const rawKeys = Object.keys(planData)

  // Try top-level fields first, then raw_data/providerRawData
  let providerPlanId = getField(planData, PLAN_ID_FIELDS)
  if (providerPlanId === undefined || providerPlanId === null || providerPlanId === '') {
    providerPlanId = fallbackField(planData, ['bundle_template_id', 'sku', 'bundle_code', 'id', 'code', 'planId'])
  }

  if (providerPlanId !== undefined && providerPlanId !== null) {
    providerPlanId = String(providerPlanId)
  } else {
    providerPlanId = ''
  }

  let sku = getField(planData, ['sku', 'providerPlanId', 'id', 'code', 'bundle_code'])
  if (sku === undefined || sku === null || sku === '') {
    sku = fallbackField(planData, ['sku', 'bundle_code', 'bundle_template_id', 'id', 'code'])
  }

  if (sku !== undefined && sku !== null) {
    sku = String(sku)
  } else {
    sku = ''
  }

  let name = getField(planData, PLAN_NAME_FIELDS)
  if (name === undefined || name === null || name === '') {
    name = fallbackField(planData, ['bundle_name', 'name', 'productName', 'title', 'description'])
  }

  if (name !== undefined && name !== null) {
    name = String(name)
  } else {
    name = ''
  }

  // Data/validity/price: try top-level, then raw_data
  let rawDataGB = getField(planData, PLAN_DATAGB_FIELDS)
  if (rawDataGB === undefined) {
    rawDataGB = fallbackField(planData, ['rate_group_allowance', 'volume_gb', 'dataGB', 'data_gb', 'data', 'allowance'])
  }

  const dataGBVal = normalizePlanValue(rawDataGB ?? 1024, 'int')
  const dataGB = dataGBVal > 0 ? dataGBVal : 1

  let rawValidity = getField(planData, PLAN_VALIDITY_FIELDS)
  if (rawValidity === undefined) {
    rawValidity = fallbackField(planData, ['rate_group_allow_days', 'validity_days', 'validityDays', 'days', 'duration_days'])
  }

  const validityVal = normalizePlanValue(rawValidity ?? 30, 'int')
  const validityDays = validityVal > 0 ? validityVal : 30

  let rawPrice = getField(planData, PLAN_PRICE_FIELDS)
  if (rawPrice === undefined) {
    rawPrice = fallbackField(planData, ['price_usd', 'priceUSD', 'price', 'cost_price', 'costPrice'])
  }

  const costPriceUSD = normalizePlanValue(rawPrice ?? 0, 'float')

  // Phase 5C — Extract currency from provider response
  const providerCurrency = getField(planData, CURRENCY_FIELDS) as string | undefined
  const currency = providerCurrency || 'USD'

  let description = getField(planData, PLAN_DESC_FIELDS)
  if ((description === undefined || description === null || description === '') && name) {
    description = name
  }
  if (description !== undefined && description !== null) description = String(description)
  else description = ''

  const templateVersion = getField(planData, ['templateVersion', 'template_version', 'version'])
  const templateVersionStr = templateVersion !== undefined && templateVersion !== null ? String(templateVersion) : 
    (fallbackField(planData, ['template_version', 'templateVersion', 'version']) || undefined)

  const missingFields: string[] = []
  if (!providerPlanId) missingFields.push('providerPlanId')
  if (!sku) missingFields.push('sku')
  if (!name) missingFields.push('name')

  const normalizedDebug: NormalizedDebug = {
    providerPlanId,
    sku,
    name,
    dataGB,
    validityDays,
    costPriceUSD,
    missingFields,
    rawKeys,
  }

  // Resolve the rawData to include in normalized output (try planData itself, then raw_data, then providerRawData)
  const outputRawData = getRawData(planData) || planData

  return { providerPlanId, sku, name, dataGB, validityDays, costPriceUSD, description, rawData: outputRawData, templateVersion: templateVersionStr, normalizedDebug,
    // Phase 5C — include extracted currency
    providerCost: costPriceUSD > 0 ? { amount: costPriceUSD, currency, source: 'PROVIDER_COST', receivedAt: new Date() } : undefined,
  }
}
