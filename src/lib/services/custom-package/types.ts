/**
 * Custom Package Builder creation modes.
 *
 * EXISTING_BACKINGS — Mode A: assemble a OneSIM retail package from one or more
 * existing ProviderPackages. No new package is created at the provider.
 *
 * UPSTREAM_CREATE — Mode B: create a genuinely new package/template upstream at
 * a provider that supports custom package authoring, then persist the resulting
 * ProviderPackage + ESIMPackage + binding locally.
 */
export type CustomPackageCreationMode = 'EXISTING_BACKINGS' | 'UPSTREAM_CREATE'

/**
 * Shared typed input for the canonical CPB create service. The action parses
 * FormData into this shape; the service dispatches based on `mode`.
 */
export interface CustomPackageCreateRequest {
  mode: CustomPackageCreationMode
  name: string
  displayName?: string
  description?: string
  dataGB: number
  validityDays: number
  countries?: string[]
  productType?: 'NEW_ESIM' | 'TOP_UP' | 'BOTH'
  currency: string
  sellingPrice: number
  /** EXISTING_BACKINGS: compatibility policy. */
  compatibilityPolicy?: 'EXACT' | 'AT_LEAST'
  /** EXISTING_BACKINGS: failover toggle. */
  allowFailover?: boolean
  /** EXISTING_BACKINGS: ordered backing rows (priority + enabled). */
  backings?: Array<{ providerPackageId: string; providerId: string | null; priority: number; enabled: boolean }>
  /** UPSTREAM_CREATE: single target provider. */
  providerId?: string
  /** UPSTREAM_CREATE: provider-specific values from the connector definition. */
  providerValues?: Record<string, unknown>
  /** UPSTREAM_CREATE: admin confirmation of the upstream mutation. */
  upstreamConfirmed?: boolean
  /** UPSTREAM_CREATE: durable idempotency key (cpb_upstream_<uuid>). Generated
   *  client-side when entering final review so double-click/back-button resubmit
   *  reuse the same key. Required for upstream mode. */
  upstreamIdempotencyKey?: string
}

export type UpstreamCreateCategory =
  | 'VALIDATION'
  | 'AUTH'
  | 'NOT_ENTITLED'
  | 'ALREADY_EXISTS'
  | 'RETRYABLE'
  | 'AMBIGUOUS'
  | 'UNKNOWN'

export interface CustomPackageCreateResult {
  success: boolean
  esimPackageId?: string
  providerPackageIds?: string[]
  providerPackageId?: string
  /** Local OneSIM ProviderPackage id (Mode B), when persisted. */
  localProviderPackageId?: string
  /** Upstream provider id (Mode B), for audit/recovery. */
  providerId?: string
  /** Upstream provider code (Mode B), for audit/recovery. */
  providerCode?: string
  partialFailure?: boolean
  providerReference?: string
  /** Durable operation id (Mode B) for recovery/audit. */
  operationId?: string
  /** Idempotency key (Mode B). */
  upstreamIdempotencyKey?: string
  /** Provider-neutral outcome category (Mode B). */
  category?: UpstreamCreateCategory
  /** True when the outcome requires admin reconciliation (ambiguous/already-exists-no-readback). */
  requiresReconciliation?: boolean
  error?: string
}