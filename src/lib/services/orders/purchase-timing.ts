/**
 * Lightweight, safe, structured purchase timing instrumentation.
 *
 * Records elapsed-millisecond stage timings for the canonical purchase stages
 * and emits ONE structured completion event (never per-stage noisy logs).
 *
 * SAFETY / REDACTION:
 *  - Only allowlisted safe scalar metadata enters the completion event
 *    (order id, provider code, operation, attempt number, correlation id).
 *  - Provider payloads, credentials, activation codes, ICCIDs, QR content,
 *    and token-adjacent values are NEVER accepted into the event.
 *  - Failure of instrumentation never throws into purchase execution.
 *
 * The clock and emitters are injectable so tests can use deterministic/fake time.
 */

export interface PurchaseTimingMeta {
  orderId?: string
  providerCode?: string
  operation?: string
  attemptNumber?: number
  correlationId?: string
}

export type PurchaseTimingNow = () => number
export type PurchaseTimingEmit = (payload: Record<string, unknown>) => void

export interface PurchaseTiming {
  /** Allowlisted metadata (safe scalars only). Fields may be assigned late
   *  (e.g. orderId becomes known after order creation) — they are read at the
   *  moment the completion event is emitted. */
  meta: PurchaseTimingMeta
  /** Begin a measured stage (idempotent per unique name). */
  start(stage: string): void
  /** End a measured stage started earlier. */
  end(stage: string): void
  /** Emit exactly one structured completion event with per-stage elapsed ms.
   *  `stageMs` are NON-OVERLAPPING durations: callers start/end stages
   *  sequentially (each end immediately precedes the next start), so the sum of
   *  stageMs approximates totalMs. They are never cumulative checkpoints. */
  complete(tag?: string): void
}

export function createPurchaseTiming(
  meta: PurchaseTimingMeta,
  now: PurchaseTimingNow = () => Date.now(),
  emit: PurchaseTimingEmit = (payload) => {
    console.log(`[PURCHASE_TIMING] ${JSON.stringify(payload)}`)
  },
): PurchaseTiming {
  const startedAt = safeNow(now)
  let finishedAt = startedAt
  const entries = new Map<string, { start: number; end: number | null }>()
  const pending: string[] = []

  function safeNow(fn: PurchaseTimingNow): number {
    try {
      return Number(fn())
    } catch {
      return 0
    }
  }

  return {
    meta,

    start(stage: string) {
      try {
        if (!entries.has(stage)) {
          entries.set(stage, { start: safeNow(now), end: null })
          pending.push(stage)
        }
      } catch {
        /* instrumentation must never break purchase execution */
      }
    },

    end(stage: string) {
      try {
        const idx = pending.lastIndexOf(stage)
        if (idx === -1) return
        const t = safeNow(now)
        const entry = entries.get(stage)
        if (entry) entry.end = t
        pending.splice(idx, 1)
        finishedAt = t
      } catch {
        /* instrumentation must never break purchase execution */
      }
    },

    complete(tag?: string) {
      try {
        finishedAt = safeNow(now)
        const totalMs = Math.max(0, finishedAt - startedAt)
        const stageMs: Record<string, number> = {}
        for (const [stage, e] of entries.entries()) {
          stageMs[stage] = Math.max(0, (e.end ?? finishedAt) - e.start)
        }
        emit({
          event: tag ? `purchase_complete_${tag}` : 'purchase_complete',
          totalMs,
          stageMs,
          ...Object.fromEntries(
            Object.entries(meta).filter(([, v]) => v !== undefined && v !== null && v !== ''),
          ),
        })
      } catch {
        /* instrumentation must never break purchase execution */
      }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Async provider-operation (worker-side) completion event.
//
// Exactly one `provider_operation_complete` event is emitted per provider
// purchase execution outcome. Sanitized: only allowlisted scalar metadata and
// non-negative numeric durations — never ICCID / activation / LPA / QR data,
// provider payloads, credentials, customer or wallet details.
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderOperationOutcome = 'FULFILLED' | 'DEFERRED' | 'RECONCILIATION' | 'FAILED' | 'UNKNOWN'

export interface ProviderOperationTimingInput {
  orderId?: string
  providerCode?: string
  operation?: string
  attemptNumber?: number
  jobId?: string
  correlationId?: string
  queueWaitMs?: number
  providerCallMs?: number
  persistenceMs?: number
  fulfillmentMs?: number
  outcome?: ProviderOperationOutcome
  immediateFinalization?: boolean
  activationJobScheduled?: boolean
}

const WORKER_OUTCOMES: readonly string[] = ['FULFILLED', 'DEFERRED', 'RECONCILIATION', 'FAILED']

function finiteNonNegative(value: number | null | undefined): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

const SAFE_NUMERIC_FIELDS = ['queueWaitMs', 'providerCallMs', 'persistenceMs', 'fulfillmentMs'] as const
const SAFE_META_FIELDS = ['orderId', 'providerCode', 'operation', 'attemptNumber', 'jobId', 'correlationId'] as const
const SAFE_FLAG_FIELDS = ['immediateFinalization', 'activationJobScheduled'] as const

/** Build the sanitized `provider_operation_complete` event payload. */
export function buildProviderOperationTimingEvent(input: ProviderOperationTimingInput): Record<string, unknown> {
  const event: Record<string, unknown> = { event: 'provider_operation_complete' }
  for (const k of SAFE_META_FIELDS) {
    const v = (input as any)[k]
    if (v !== undefined && v !== null && v !== '') event[k] = v
  }
  for (const k of SAFE_NUMERIC_FIELDS) {
    event[k] = finiteNonNegative((input as any)[k])
  }
  for (const k of SAFE_FLAG_FIELDS) {
    event[k] = Boolean((input as any)[k])
  }
  const outcome = String(input.outcome || 'UNKNOWN').toUpperCase()
  event.outcome = WORKER_OUTCOMES.includes(outcome) ? outcome : 'UNKNOWN'
  return event
}

/** Emit one sanitized worker completion event. Never throws. */
export function emitProviderOperationTiming(
  input: ProviderOperationTimingInput,
  emit: (payload: Record<string, unknown>) => void = (payload) => console.log(`[PURCHASE_TIMING] ${JSON.stringify(payload)}`),
): void {
  try {
    emit(buildProviderOperationTimingEvent(input))
  } catch {
    /* instrumentation must never break provider-operation execution */
  }
}