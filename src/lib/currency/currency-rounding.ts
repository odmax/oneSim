import { getDecimalPlaces } from './currency-registry'

export type RoundingRule = 'NONE' | 'NEAREST_MINOR_UNIT' | 'END_IN_99' | 'END_IN_95' | 'NEAREST_1' | 'NEAREST_5'

const DEFAULT_ROUNDING: Record<string, RoundingRule> = {}

export function roundCurrencyAmount(amount: number, currency: string, rule?: RoundingRule): number {
  const dp = getDecimalPlaces(currency)
  const multiplier = Math.pow(10, dp)
  let result = Math.round(amount * multiplier) / multiplier

  const applied = rule || DEFAULT_ROUNDING[currency]
  if (!applied || applied === 'NONE') return result

  switch (applied) {
    case 'NEAREST_MINOR_UNIT':
      return result
    case 'END_IN_99':
      return Math.floor(result) + 0.99
    case 'END_IN_95':
      return Math.floor(result) + 0.95
    case 'NEAREST_1':
      return Math.round(result)
    case 'NEAREST_5':
      return Math.round(result / 5) * 5
    default:
      return result
  }
}
