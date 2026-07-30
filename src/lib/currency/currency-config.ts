export const PLATFORM_BASE_CURRENCY = process.env.PLATFORM_BASE_CURRENCY || 'USD'
export const DEFAULT_PROVIDER_CURRENCY = process.env.DEFAULT_PROVIDER_CURRENCY || 'USD'
export const EXCHANGE_RATE_MAX_AGE_MINUTES = parseInt(process.env.EXCHANGE_RATE_MAX_AGE_MINUTES || '1440')
export const PRICE_QUOTE_EXPIRY_MINUTES = parseInt(process.env.PRICE_QUOTE_EXPIRY_MINUTES || '10')
export const PRICING_QUOTES_REQUIRED = process.env.PRICING_QUOTES_REQUIRED === 'true'
export const PRICING_ENGINE_VERSION = '3.0.0'

export function getPlatformBaseCurrency(): string { return PLATFORM_BASE_CURRENCY }
export function getDefaultProviderCurrency(): string { return DEFAULT_PROVIDER_CURRENCY }
export function getExchangeRateMaxAge(): number { return EXCHANGE_RATE_MAX_AGE_MINUTES }
export function getQuoteExpiryMinutes(): number { return PRICE_QUOTE_EXPIRY_MINUTES }
