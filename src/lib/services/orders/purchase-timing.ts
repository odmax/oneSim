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
  readonly meta: PurchaseTimingMeta
  /** Begin a measured stage (idempotent per unique name). */
  start(stage: string): void
  /** End a measured stage started earlier. */
  end(stage: string): void
  /** Emit exactly one structured completion event with per-stage elapsed ms. */
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