export interface CurrencyDefinition {
  code: string
  decimalPlaces: number
  enabled: boolean
}

const CURRENCIES: Record<string, CurrencyDefinition> = {
  USD: { code: 'USD', decimalPlaces: 2, enabled: true },
  EUR: { code: 'EUR', decimalPlaces: 2, enabled: true },
  GBP: { code: 'GBP', decimalPlaces: 2, enabled: true },
  ZAR: { code: 'ZAR', decimalPlaces: 2, enabled: true },
  NGN: { code: 'NGN', decimalPlaces: 2, enabled: true },
  KES: { code: 'KES', decimalPlaces: 2, enabled: true },
  GHS: { code: 'GHS', decimalPlaces: 2, enabled: true },
  AED: { code: 'AED', decimalPlaces: 2, enabled: true },
  CAD: { code: 'CAD', decimalPlaces: 2, enabled: true },
  AUD: { code: 'AUD', decimalPlaces: 2, enabled: true },
  JPY: { code: 'JPY', decimalPlaces: 0, enabled: true },
}

export function getCurrencyDefinition(code: string): CurrencyDefinition | null {
  const normalized = code.toUpperCase()
  return CURRENCIES[normalized] || null
}

export function isCurrencySupported(code: string): boolean {
  const def = getCurrencyDefinition(code)
  return def !== null && def.enabled
}

export function getDecimalPlaces(code: string): number {
  return getCurrencyDefinition(code)?.decimalPlaces ?? 2
}

export function validateCurrency(code: string): { valid: boolean; error?: string } {
  const normalized = code.toUpperCase()
  if (!CURRENCIES[normalized]) return { valid: false, error: `Unsupported currency: ${code}` }
  if (!CURRENCIES[normalized].enabled) return { valid: false, error: `Currency disabled: ${code}` }
  return { valid: true }
}

export function getAllSupportedCurrencies(): CurrencyDefinition[] {
  return Object.values(CURRENCIES).filter(c => c.enabled)
}
