export interface OpenLoopOptions {
  targetRps: number
  durationSec: number
  maxInflight: number
}

export interface OpenLoopResult {
  targetCount: number
  scheduled: number
  started: number
  completed: number
  backpressureEvents: number
  maxInflightObserved: number
  p99LagMs: number
  saturated: boolean
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * True OPEN-LOOP scheduler: requests are scheduled on a monotonic target clock
 * (interval = 1000/targetRps) independently of completion. A bounded maximum
 * in-flight safety limit prevents memory exhaustion; when the limit is reached
 * the slot is NOT dispatched and GENERATOR_BACKPRESSURE_EVENTS is counted —
 * the target rate is never silently reduced. `started` may be < `scheduled`
 * (targetCount) only under saturation, which is reported explicitly.
 */
export async function runOpenLoop(opts: OpenLoopOptions, worker: (i: number) => Promise<void>): Promise<OpenLoopResult> {
  const targetCount = Math.round(opts.targetRps * opts.durationSec)
  const interval = 1000 / opts.targetRps
  const start = Date.now()
  let started = 0
  let backpressure = 0
  let inflight = 0
  let maxInflightObserved = 0
  const lags: number[] = []
  let completedSync = 0

  for (let i = 0; i < targetCount; i++) {
    const slotAt = start + i * interval
    const now = Date.now()
    if (slotAt > now) await sleep(slotAt - now)
    lags.push(Date.now() - slotAt)

    if (inflight >= opts.maxInflight) {
      backpressure += 1
      continue
    }
    started += 1
    inflight += 1
    if (inflight > maxInflightObserved) maxInflightObserved = inflight
    void (async () => {
      try { await worker(i) } finally { inflight -= 1; completedSync += 1 }
    })()
  }

  // await all in-flight completions before returning
  while (inflight > 0) await sleep(2)
  const p99 = p99Of(lags)
  return { targetCount, scheduled: targetCount, started, completed: completedSync, backpressureEvents: backpressure, maxInflightObserved, p99LagMs: p99, saturated: started < Math.round(targetCount * 0.99) || backpressure > 0 }
}

function p99Of(a: number[]): number {
  if (a.length === 0) return 0
  const s = [...a].sort((x, y) => x - y)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(0.99 * s.length) - 1))
  return s[idx]
}