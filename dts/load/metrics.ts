export class Metrics {
  requestsSent = 0
  requestsAccepted = 0
  requestsRejected = 0
  ordersCreated = 0
  /** Open-loop scheduler telemetry. */
  scheduled = 0
  started = 0
  completed = 0
  backpressureEvents = 0
  maxInflightObserved = 0
  generatorSaturated = false
  generationDurationSec = 0
  jobsEnqueued = 0
  jobsCompleted = 0
  jobsFailed = 0
  providerAttempts = 0
  ordersFulfilled = 0
  ordersReconciliation = 0
  ordersFailed = 0
  esimsCreated = 0
  duplicatesLogicalOrders = 0
  duplicateProviderDispatches = 0
  duplicateWalletCaptures = 0
  duplicateIccids = 0
  walletOverspend = 0
  fulfilledWithoutIccid = 0
  redispatchAfterAcceptance = 0
  crossProviderFulfillment = 0
  negativeWallets = 0
  lostProviderReferences = 0

  private latencies: number[] = []
  private timers = new Map<string, number>()
  /** Order ids created in the run (for post-run invariant scoping). */
  orderIds: string[] = []
  /** Post-run invariant verdict. */
  runStatus: 'PASS' | 'FAIL' = 'PASS'

  start(label: string): void { this.timers.set(label, Date.now()) }
  end(label: string): void {
    const s = this.timers.get(label)
    if (s !== undefined) { this.latencies.push(Date.now() - s); this.timers.delete(label) }
  }
  recordLatency(ms: number): void { this.latencies.push(ms) }

  percentile(p: number): number | null {
    if (this.latencies.length === 0) return null
    const sorted = [...this.latencies].sort((a, b) => a - b)
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
    return sorted[idx]
  }
  max(): number | null { return this.latencies.length ? Math.max(...this.latencies) : null }
  count(): number { return this.latencies.length }

  summary(): Record<string, number | string | null> {
    return {
      requestsSent: this.requestsSent,
      requestsAccepted: this.requestsAccepted,
      requestsRejected: this.requestsRejected,
      ordersCreated: this.ordersCreated,
      jobsEnqueued: this.jobsEnqueued,
      jobsCompleted: this.jobsCompleted,
      jobsFailed: this.jobsFailed,
      providerAttempts: this.providerAttempts,
      ordersFulfilled: this.ordersFulfilled,
      ordersReconciliation: this.ordersReconciliation,
      ordersFailed: this.ordersFailed,
      esimsCreated: this.esimsCreated,
      p50Ms: this.percentile(50),
      p95Ms: this.percentile(95),
      p99Ms: this.percentile(99),
      maxMs: this.max(),
      duplicatesLogicalOrders: this.duplicatesLogicalOrders,
      duplicateProviderDispatches: this.duplicateProviderDispatches,
      duplicateWalletCaptures: this.duplicateWalletCaptures,
      duplicateIccids: this.duplicateIccids,
      walletOverspend: this.walletOverspend,
      fulfilledWithoutIccid: this.fulfilledWithoutIccid,
      redispatchAfterAcceptance: this.redispatchAfterAcceptance,
      crossProviderFulfillment: this.crossProviderFulfillment,
      negativeWallets: this.negativeWallets,
      lostProviderReferences: this.lostProviderReferences,
    }
  }
}