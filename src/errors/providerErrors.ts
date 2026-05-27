export class ProviderNotFoundError extends Error {
  readonly providerSlug: string
  constructor(slug: string) {
    super(`Provider not found or inactive: ${slug}`)
    this.name = 'ProviderNotFoundError'
    this.providerSlug = slug
  }
}

export class ProviderAPIError extends Error {
  readonly providerSlug: string
  readonly status: number
  readonly body: string
  constructor(slug: string, status: number, body: string) {
    super(`Provider API error [${slug}]: HTTP ${status}`)
    this.name = 'ProviderAPIError'
    this.providerSlug = slug
    this.status = status
    this.body = body
  }
}

export class ProviderAuthError extends Error {
  readonly providerSlug: string
  constructor(slug: string, message: string) {
    super(`Provider auth error [${slug}]: ${message}`)
    this.name = 'ProviderAuthError'
    this.providerSlug = slug
  }
}

export class FieldMappingError extends Error {
  readonly providerSlug: string
  readonly field: string
  constructor(slug: string, field: string) {
    super(`Required field "${field}" missing in provider response [${slug}]`)
    this.name = 'FieldMappingError'
    this.providerSlug = slug
    this.field = field
  }
}

export class WebhookVerificationError extends Error {
  readonly providerSlug: string
  readonly sourceIp: string
  constructor(slug: string, sourceIp: string, message: string) {
    super(`Webhook verification failed [${slug} from ${sourceIp}]: ${message}`)
    this.name = 'WebhookVerificationError'
    this.providerSlug = slug
    this.sourceIp = sourceIp
  }
}

export class UnknownAdapterError extends Error {
  readonly adapterClass: string
  constructor(adapterClass: string) {
    super(`Unknown adapter class: ${adapterClass}`)
    this.name = 'UnknownAdapterError'
    this.adapterClass = adapterClass
  }
}
