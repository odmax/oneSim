/**
 * PROVIDER EXECUTION POLICY
 *
 * Generic, provider-neutral execution policy resolved from the persisted
 * Provider.config (extended typed config JSON — NO schema change).
 *
 * Defaults MUST preserve current runtime behavior: any unset/invalid value
 * resolves to `null` (unlimited / provider-connector default), never to a
 * fabricated limit that would change existing providers.
 *
 * Executability is described in terms of OPERATIONS (PURCHASE_ESIM, GET_STATUS,
 * …) not provider brands, so the same policy feeds future IoT/M2M operations
 * without redesign.
 */

export type ProviderOperation =
  | 'PURCHASE_ESIM'
  | 'GET_STATUS'
  | 'GET_USAGE'
  | 'TOP_UP'
  | 'SUSPEND'
  | 'RESUME'
  | 'REFRESH_QR'
  | 'WEBHOOK_STATUS'
  // Reserved for future IoT/M2M lanes — NOT implemented in this phase. Kept in
  // the type so the operation taxonomy is proven extensible.
  | 'IOT_ACTIVATE'
  | 'IOT_CHANGE_PLAN'
  | 'IOT_SET_APN'

/**
 * Typed shape of `provider.config.execution`. Persisted as part of the existing
 * Provider.config JSON. All values optional and bounds-validated at read time;
 * anything out of bounds falls back to the safe default (null).
 */
export interface ProviderExecutionConfig {
  /** Max concurrent PROVIDER_OPERATION executions for purchase work. 1..100. */
  purchaseConcurrency?: number
  /** Max concurrent PROVIDER_OPERATION executions for status/polling work. 1..100. */
  statusConcurrency?: number
  /** Reserved: provider-level execution timeout (ms). Not enforced in this phase. */
  purchaseTimeoutMs?: number
  /** Reserved: provider-level status timeout (ms). Not enforced in this phase. */
  statusTimeoutMs?: number
  /** Reserved: provider-local retry backoff (ms). Current queue uses its own exponential backoff. */
  backoffMs?: number
}

export const EXECUTION_POLICY_BOUNDS = {
  minConcurrency: 1,
  maxConcurrency: 100,
  minTimeoutMs: 100,
  maxTimeoutMs: 300_000,
  minBackoffMs: 100,
  maxBackoffMs: 3_600_000,
} as const

export interface ProviderExecutionPolicy {
  providerId: string
  /** null = unlimited (preserves current behavior). */
  purchaseConcurrency: number | null
  /** null = unlimited (preserves current behavior). */
  statusConcurrency: number | null
  /** Reserved metadata. null = unset. */
  purchaseTimeoutMs: number | null
  statusTimeoutMs: number | null
  backoffMs: number | null
}

function boundedInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return null
  if (value < min || value > max) return null
  return value
}

/** Validate/normalize an arbitrary config.execution payload. Invalid ⇒ safe null. */
export function normalizeProviderExecutionConfig(raw: unknown): ProviderExecutionConfig {
  const cfg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: ProviderExecutionConfig = {}
  const pc = boundedInt(cfg.purchaseConcurrency, EXECUTION_POLICY_BOUNDS.minConcurrency, EXECUTION_POLICY_BOUNDS.maxConcurrency)
  const sc = boundedInt(cfg.statusConcurrency, EXECUTION_POLICY_BOUNDS.minConcurrency, EXECUTION_POLICY_BOUNDS.maxConcurrency)
  if (pc !== null) out.purchaseConcurrency = pc
  if (sc !== null) out.statusConcurrency = sc
  const pto = boundedInt(cfg.purchaseTimeoutMs, EXECUTION_POLICY_BOUNDS.minTimeoutMs, EXECUTION_POLICY_BOUNDS.maxTimeoutMs)
  const sto = boundedInt(cfg.statusTimeoutMs, EXECUTION_POLICY_BOUNDS.minTimeoutMs, EXECUTION_POLICY_BOUNDS.maxTimeoutMs)
  const bo = boundedInt(cfg.backoffMs, EXECUTION_POLICY_BOUNDS.minBackoffMs, EXECUTION_POLICY_BOUNDS.maxBackoffMs)
  if (pto !== null) out.purchaseTimeoutMs = pto
  if (sto !== null) out.statusTimeoutMs = sto
  if (bo !== null) out.backoffMs = bo
  return out
}

/**
 * Resolve the canonical execution policy for a persisted provider row.
 * `config` is the raw Provider.config (Json) value.
 */
export function resolveProviderExecutionPolicy(provider: { id: string; config?: any }): ProviderExecutionPolicy {
  const raw = provider?.config && typeof provider.config === 'object' ? (provider.config as any)?.execution : undefined
  const cfg = normalizeProviderExecutionConfig(raw)
  return {
    providerId: provider.id,
    purchaseConcurrency: cfg.purchaseConcurrency ?? null,
    statusConcurrency: cfg.statusConcurrency ?? null,
    purchaseTimeoutMs: cfg.purchaseTimeoutMs ?? null,
    statusTimeoutMs: cfg.statusTimeoutMs ?? null,
    backoffMs: cfg.backoffMs ?? null,
  }
}

/**
 * The effective per-provider PROVIDER_OPERATION lane ceiling for an operation.
 * Purchase operations use purchaseConcurrency; all other operations (status
 * polling, top-up, …) use statusConcurrency. null ⇒ no lane cap (current
 * behavior).
 */
export function laneLimitForOperation(policy: ProviderExecutionPolicy, operation: string | undefined | null): number | null {
  const op = operation || 'GET_STATUS'
  if (op === 'PURCHASE_ESIM' || op === 'purchase') return policy.purchaseConcurrency
  return policy.statusConcurrency
}