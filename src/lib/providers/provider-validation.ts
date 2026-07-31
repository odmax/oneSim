export interface ValidationError {
  field: string
  message: string
}

export interface TelnaConfig {
  code?: string
  adapterStrategy?: string
  apiBaseUrl?: string
  apiToken?: string
  authorizationMode?: string
}

const ALLOWED_AUTHORIZATION_MODES = ['BEARER', 'RAW']

export function validateTelnaConfig(config: TelnaConfig): ValidationError[] {
  const errors: ValidationError[] = []

  if (!config.code) {
    errors.push({ field: 'code', message: 'Provider code is required' })
  } else if (config.code.toUpperCase() !== 'TELNA') {
    errors.push({ field: 'code', message: 'Provider code must be TELNA' })
  }

  if (!config.adapterStrategy) {
    errors.push({ field: 'adapterStrategy', message: 'Adapter strategy is required' })
  } else if (config.adapterStrategy !== 'TELNA') {
    errors.push({ field: 'adapterStrategy', message: 'Adapter strategy must be TELNA' })
  }

  if (!config.apiBaseUrl) {
    errors.push({ field: 'apiBaseUrl', message: 'API Base URL is required' })
  } else if (!config.apiBaseUrl.startsWith('https://')) {
    errors.push({ field: 'apiBaseUrl', message: 'API Base URL must use HTTPS' })
  } else {
    try {
      const url = new URL(config.apiBaseUrl)
      if (url.username || url.password) {
        errors.push({ field: 'apiBaseUrl', message: 'Credentials must not be placed in the URL' })
      }
    } catch {
      errors.push({ field: 'apiBaseUrl', message: 'API Base URL is not a valid URL' })
    }
  }

  if (!config.apiToken) {
    errors.push({ field: 'apiToken', message: 'KeyID is required' })
  }

  if (!config.authorizationMode) {
    errors.push({ field: 'authorizationMode', message: 'Authorization mode is required' })
  } else if (!ALLOWED_AUTHORIZATION_MODES.includes(config.authorizationMode)) {
    errors.push({ field: 'authorizationMode', message: `Authorization mode must be one of: ${ALLOWED_AUTHORIZATION_MODES.join(', ')}` })
  }

  return errors
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

export interface TelnaSeamlessConfig {
  code?: string
  adapterStrategy?: string
  apiBaseUrl?: string
  apiToken?: string
  environment?: string
}

export function validateTelnaSeamlessConfig(config: TelnaSeamlessConfig): ValidationError[] {
  const errors: ValidationError[] = []

  if (!config.code) {
    errors.push({ field: 'code', message: 'Provider code is required' })
  } else if (config.code.toUpperCase() !== 'TELNA') {
    errors.push({ field: 'code', message: 'Provider code must be TELNA' })
  }

  if (!config.adapterStrategy) {
    errors.push({ field: 'adapterStrategy', message: 'Adapter strategy is required' })
  } else if (config.adapterStrategy !== 'TELNA_SEAMLESS') {
    errors.push({ field: 'adapterStrategy', message: 'Adapter strategy must be TELNA_SEAMLESS' })
  }

  if (!config.apiBaseUrl) {
    errors.push({ field: 'apiBaseUrl', message: 'API Base URL is required' })
  } else if (!config.apiBaseUrl.startsWith('https://')) {
    errors.push({ field: 'apiBaseUrl', message: 'API Base URL must use HTTPS' })
  } else {
    try {
      const url = new URL(config.apiBaseUrl)
      if (url.username || url.password) {
        errors.push({ field: 'apiBaseUrl', message: 'Credentials must not be placed in the URL' })
      }
    } catch {
      errors.push({ field: 'apiBaseUrl', message: 'API Base URL is not a valid URL' })
    }
  }

  if (!config.apiToken) {
    errors.push({ field: 'apiToken', message: 'API Key is required (X-API-Key header)' })
  }

  if (config.environment && !['production', 'staging', 'sandbox'].includes(config.environment)) {
    errors.push({ field: 'environment', message: 'Environment must be one of: production, staging, sandbox' })
  }

  return errors
}

export interface IbasisConfig {
  code?: string
  adapterStrategy?: string
  baseUrl?: string
  apiBaseUrl?: string
  apiToken?: string
  requestTimeoutMs?: number
  environment?: string
  defaultCurrency?: string
}

export function validateIbasisConfig(config: IbasisConfig): ValidationError[] {
  const errors: ValidationError[] = []

  if (!config.code) {
    errors.push({ field: 'code', message: 'Provider code is required' })
  } else if (config.code.toUpperCase() !== 'IBASIS') {
    errors.push({ field: 'code', message: 'Provider code must be IBASIS' })
  }

  if (!config.adapterStrategy) {
    errors.push({ field: 'adapterStrategy', message: 'Adapter strategy is required' })
  } else if (config.adapterStrategy !== 'IBASIS') {
    errors.push({ field: 'adapterStrategy', message: 'Adapter strategy must be IBASIS' })
  }

  const baseUrl = config.baseUrl || config.apiBaseUrl
  if (!baseUrl) {
    errors.push({ field: 'baseUrl', message: 'Base URL is required' })
  } else if (!baseUrl.startsWith('https://')) {
    errors.push({ field: 'baseUrl', message: 'Base URL must use HTTPS' })
  } else {
    try {
      const url = new URL(baseUrl)
      if (url.username || url.password) {
        errors.push({ field: 'baseUrl', message: 'Credentials must not be placed in the URL' })
      }
    } catch {
      errors.push({ field: 'baseUrl', message: 'Base URL is not a valid URL' })
    }
  }

  if (!config.apiToken) {
    errors.push({ field: 'apiToken', message: 'API token is required (Authorization: Token <token>)' })
  }

  if (config.requestTimeoutMs != null && (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs <= 0)) {
    errors.push({ field: 'requestTimeoutMs', message: 'Request timeout must be a positive number of milliseconds' })
  }

  if (config.environment && !['production', 'staging', 'sandbox'].includes(config.environment)) {
    errors.push({ field: 'environment', message: 'Environment must be one of: production, staging, sandbox' })
  }

  if (config.defaultCurrency && !/^[A-Z]{3}$/.test(config.defaultCurrency)) {
    errors.push({ field: 'defaultCurrency', message: 'Default currency must be a 3-letter ISO code (e.g. USD)' })
  }

  return errors
}
