/**
 * Canonical plan comparison key.
 * Two provider plans are equivalent when they serve the same customer market.
 */
const MB_PER_GB = 1024

function normalizeDataMB(value: number | null | undefined): number {
  if (value == null || value <= 0) return 0
  // If value looks like GB (< 200), treat as GB and convert to MB
  if (value < 200) return Math.round(value * MB_PER_GB)
  return Math.round(value)
}

function normalizeValidityDays(value: number | null | undefined): number {
  if (value == null || value <= 0) return 0
  // If value looks like months (> 60), treat as days as-is (already in days)
  return Math.round(value)
}

function normalizeCountry(value: string | null | undefined): string {
  if (!value || value.trim() === '') return 'GLOBAL'
  return value.trim().toUpperCase().replace(/\s+/g, '_')
}

type PlanType = 'DATA_ONLY' | 'VOICE_DATA' | 'VOICE_DATA_SMS' | 'VOICE_ONLY' | 'SMS_ONLY'

function detectPlanType(params: { voiceMinutes?: number | null; smsCount?: number | null }): PlanType {
  const hasVoice = (params.voiceMinutes ?? 0) > 0
  const hasSMS = (params.smsCount ?? 0) > 0
  if (hasVoice && hasSMS) return 'VOICE_DATA_SMS'
  if (hasVoice && !hasSMS) return 'VOICE_DATA'
  if (!hasVoice && hasSMS) return 'SMS_ONLY'
  return 'DATA_ONLY'
}

export interface ComparisonKeyInput {
  country?: string | null
  region?: string | null
  dataGB?: number | null
  dataMB?: number | null
  validityDays?: number | null
  voiceMinutes?: number | null
  smsCount?: number | null
  planType?: string | null
}

export function buildComparisonKey(input: ComparisonKeyInput): string {
  const country = normalizeCountry(input.country || input.region)
  const dataMB = normalizeDataMB(input.dataGB ?? input.dataMB)
  const validity = normalizeValidityDays(input.validityDays)
  const voice = input.voiceMinutes ?? 0
  const sms = input.smsCount ?? 0
  const planType = detectPlanType({ voiceMinutes: voice, smsCount: sms })

  return `${country}|${planType}|${dataMB}MB|${validity}D|VOICE_${voice}|SMS_${sms}`
}

/**
 * Group provider packages by comparison key.
 * Returns a map of comparisonKey → array of provider packages.
 */
export function groupByComparisonKey<T extends { comparisonKey?: string }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = item.comparisonKey || 'UNGROUPED'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(item)
  }
  return groups
}
