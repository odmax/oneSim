import { Metrics } from './metrics'

export interface CapacityWindow { durationSec: number; targetRps: number }

/** Compact capacity summary plus machine-readable JSON. */
export function emitCapacityReport(m: Metrics, w: CapacityWindow): void {
  const acceptedRps = w.durationSec > 0 ? m.requestsAccepted / w.durationSec : 0
  const fulfilledRps = w.durationSec > 0 ? m.ordersFulfilled / w.durationSec : 0
  console.log('CAPACITY_ACCEPTED_RPS=' + acceptedRps.toFixed(2))
  console.log('CAPACITY_FULFILLED_RPS=' + fulfilledRps.toFixed(2))
  console.log('CAPACITY_RATIO_REQUESTS_ACCEPTED=' + (m.requestsAccepted / Math.max(1, m.requestsSent)).toFixed(4))
  console.log('CAPACITY_RATIO_FULFILLED_ACCEPTED=' + (m.ordersFulfilled / Math.max(1, m.requestsAccepted)).toFixed(4))
  console.log('CAPACITY_JSON=' + JSON.stringify({ acceptedRps: +acceptedRps.toFixed(2), fulfilledRps: +fulfilledRps.toFixed(2), targetRps: w.targetRps, ...m.summary() }))
}