import type { Scenario, ProviderStrategy } from './scenarios'
import { SCENARIO_CONTRACT } from './scenarios'
import { Metrics } from './metrics'
import { seedLoad, connectorTypeForStrategy, type SeedResult } from './load-seed'
import { runWorkers } from './worker'
import { checkDbInvariants, checkFakeDispatchCounts } from './invariants'
import { FakeConnector } from './fake-provider-driver'
import { prisma } from '../../src/lib/prisma'

export interface RunOptions {
  scenario: Scenario
  provider: ProviderStrategy
  rps: number
  durationSec: number
  concurrency: number
  businesses: number
  packagesPerProvider: number
  quantity: number
  workerCount: number
  seedSuffix: string
  settleSec: number
  sameIdempotencyKey: boolean
  /** Optional pre-provisioned load DB URL (reuse across matrix cells). */
  preProvisionedUrl?: string
  /** Per-run package namespace (keeps matrix cells dedup-isolated). */
  scope?: string
  /** Open-loop max in-flight safety cap (defaults to concurrency). */
  maxInflight?: number
  /** INGRESS_ONLY: do NOT start provider workers during the measurement window
   *  (real createOrder→reserve→enqueue only); drain workers after generation. */
  ingressOnly?: boolean
}

export async function runLoad(opts: RunOptions): Promise<Metrics> {
  const metrics = new Metrics()
  const { registerConnectorOverride } = await import('../../src/lib/providers/connectors/connector-factory')
  const { FAKE_INSTANCES } = await import('./fake-provider-driver')
  const connectorType = connectorTypeForStrategy(opts.provider)
  process.env.LOAD_HARNESS = '1'

  if (opts.preProvisionedUrl) {
    process.env.DATABASE_URL = opts.preProvisionedUrl
  } else {
    const { provisionLoadDatabase } = await import('./load-db')
    const { loadUrl } = await provisionLoadDatabase(process.env.DATABASE_URL!, opts.seedSuffix)
    process.env.DATABASE_URL = loadUrl
  }
  const { classifyLoadDb } = await import('./load-db')
  const gate = classifyLoadDb(process.env.DATABASE_URL!)
  console.log('LOAD_DB_GATE=' + (gate.ok ? 'PASS' : 'FAIL'))
  console.log('DATABASE_NAME=' + gate.databaseName)
  console.log('STAGING_DB_USED=' + (gate.stagingDbUsed ? 'YES' : 'NO'))
  console.log('PRODUCTION_DB_USED=' + (gate.productionDbUsed ? 'YES' : 'NO'))
  if (!gate.ok) throw new Error('LOAD_DB_GATE FAILED')

  // Fail-fast mis-bind guard: verify the Prisma singleton we are about to drive
  // is actually connected to the load database (not dev/staging/prod). Catches
  // any import-ordering/re-binding mistake regardless of how the module loaded.
  const actualDb = await prisma.$queryRawUnsafe('SELECT current_database() AS db').then((r: any) => (r && r[0] ? String(r[0].db) : '')).catch(() => '')
  const { assertLoadDbBinding } = await import('./bootstrap')
  assertLoadDbBinding(actualDb, gate.databaseName)

  // Now DATABASE_URL names a load DB → gated registration is allowed.
  registerConnectorOverride(connectorType, (providerId: string) => new FakeConnector(providerId, opts.scenario))
  console.log('FAKE_PROVIDER_MODE=YES')

  // Harness-only telemetry (Prisma $use middleware + perf_hooks): no production change.
  const tel = await import('./telemetry')
  tel.attachQueryTelemetry(prisma)

  const seed: SeedResult = await seedLoad({
    businesses: opts.businesses,
    walletBalance: 1_000_000,
    packagesPerProvider: opts.packagesPerProvider,
    providers: [opts.provider],
    quantity: opts.quantity,
    scope: opts.scope,
  })

  // INGRESS-WINDOW QUARANTINE: reset all query buckets AFTER seeding and start
  // the event-loop/PG probe now — the measured window is generation ONLY, so
  // QUERY_GROUP / QUERIES_TOTAL / EVENT_LOOP_* / PG_ACTIVE_PEAK exclude both
  // seed and (later) drain churn.
  tel.telemetryClear()
  const probe = await tel.startProbe(prisma).catch(() => null)
  const sampler = setInterval(() => { if (probe) void tel.sampleProbe(prisma, probe).catch(() => {}) }, 1000)

  const orderIds: string[] = []
  const startMs = Date.now()
  const { createOrder } = await import('../../src/lib/services/orders/create-order')
  const { runOpenLoop } = await import('./open-loop')

  // Unique (business, package) mapping so the real 30s dedup window does not
  // collapse distinct logical purchases into one order: flatten all retail
  // packages, cycle business by request index.
  const flatPackages: string[] = []
  for (const list of seed.packageIdsPerBusiness) flatPackages.push(...list)

  // TRUE OPEN-LOOP generation: scheduled on the target clock independently of
  // completion; a bounded max-in-flight cap records GENERATOR_BACKPRESSURE_EVENTS
  // (never silently reduces the target rate).
  let stop = false
  let workersDone: Promise<void> | null = null
  if (!opts.ingressOnly) {
    workersDone = runWorkers({ workerCount: opts.workerCount, pollMs: 20, batch: 25, shouldStop: () => stop, metrics })
  }

  const genRes = await runOpenLoop({ targetRps: opts.rps, durationSec: opts.durationSec, maxInflight: opts.maxInflight ?? opts.concurrency }, async (N: number) => {
    const bIdx = N % seed.businessIds.length
    const pkg = flatPackages[N % flatPackages.length]
    const key = opts.sameIdempotencyKey ? 'load-storm-key' : `load-${Date.now().toString(36)}-${N}`
    const t0 = Date.now()
    const res = (await createOrder({
      businessId: seed.businessIds[bIdx],
      userId: seed.userIds[bIdx],
      packageId: pkg,
      quantity: opts.quantity,
      idempotencyKey: key,
      correlationId: `load-${N}`,
      async: true,
    }).catch(() => ({ success: false }))) as { success: boolean; orderId?: string }
    metrics.recordLatency(Date.now() - t0)
    metrics.requestsSent += 1
    metrics.started += 1
    if (res.success && res.orderId) {
      metrics.requestsAccepted += 1
      metrics.ordersCreated += 1
      orderIds.push(res.orderId)
    } else {
      metrics.requestsRejected += 1
    }
  })
  metrics.scheduled = genRes.scheduled
  metrics.started = genRes.started
  metrics.completed = genRes.completed
  metrics.backpressureEvents = genRes.backpressureEvents
  metrics.maxInflightObserved = genRes.maxInflightObserved
  metrics.generatorSaturated = genRes.saturated

  const genDuration = Math.max(1, (Date.now() - startMs) / 1000)

  // Close INGRESS-WINDOW telemetry and emit DB/event-loop/CPU observation for
  // generation ONLY (before any drain/worker/post-run queries run, so the
  // QUERY_GROUP buckets and per-order read ratios stay seed/drain-free).
  clearInterval(sampler)
  const probeFin = probe ? await tel.finishProbe(prisma, probe).catch(() => null) : null
  const totalQueries = tel.telemetryTotalCount()
  console.log('QUERIES_TOTAL=' + totalQueries)
  console.log('QUERIES_PER_ACCEPTED=' + (metrics.requestsAccepted > 0 ? (totalQueries / metrics.requestsAccepted).toFixed(1) : 0))
  const topQueries = tel.telemetrySummary(24)
  for (const t of topQueries) console.log('QUERY_GROUP|' + [t.key, t.count, t.totalMs, t.p50, t.p95, t.p99, t.maxMs].join('|'))
  if (probeFin) for (const [k, v] of Object.entries(probeFin)) console.log(k + '=' + v)

  // Settle: drain the real job queue until idle (bounded by settleSec), then
  // stop the worker loops.
  const { processDueJobs } = await import('../../src/lib/services/jobs/queue')
  if (opts.ingressOnly) {
    const queueDepthEnd = await prisma.backgroundJob.count({ where: { status: 'PENDING' as any } })
    console.log('INGRESS_QUEUE_DEPTH_END=' + queueDepthEnd)
  }
  const drainEnd = Date.now() + opts.settleSec * 1000
  let quietRounds = 0
  while (Date.now() < drainEnd) {
    const res = await processDueJobs({ types: ['PROVIDER_OPERATION' as any], limit: 50 })
    for (const r of res) {
      if (r.status === 'COMPLETED') metrics.jobsCompleted += 1
      else metrics.jobsFailed += 1
    }
    if (res.length === 0) { quietRounds += 1; if (quietRounds >= 2) break } else quietRounds = 0
    await sleep(20)
  }
  stop = true
  if (workersDone) await workersDone
  metrics.jobsEnqueued = metrics.ordersCreated
  metrics.generationDurationSec = genDuration

  // Post-run DB state.
  const orders = await prisma.eSIMPurchase.findMany({ where: { id: { in: orderIds } }, select: { id: true, status: true } })
  for (const o of orders) {
    if (o.status === 'FULFILLED' || o.status === 'PARTIALLY_FULFILLED') metrics.ordersFulfilled += 1
    else if (o.status === 'PROVIDER_RECONCILIATION') metrics.ordersReconciliation += 1
    else if (o.status === 'FAILED') metrics.ordersFailed += 1
  }
  metrics.esimsCreated = await prisma.eSIM.count({ where: { purchaseId: { in: orderIds } } })
  metrics.providerAttempts = await prisma.providerAttempt.count({ where: { orderId: { in: orderIds } } })

  const invariant = await checkDbInvariants(metrics, orderIds)
  metrics.orderIds = orderIds
  metrics.runStatus = invariant.runStatus
  const fake = { duplicateProviderDispatches: 0 }
  const dispatchAgg = new Map<string, number>()
  for (const inst of FAKE_INSTANCES) {
    for (const [k, c] of inst.dispatchSeen) dispatchAgg.set(k, (dispatchAgg.get(k) ?? 0) + c)
  }
  checkFakeDispatchCounts(dispatchAgg, fake)
  metrics.duplicateProviderDispatches = fake.duplicateProviderDispatches

  // Final pending-job age
  const pending = await prisma.backgroundJob.findFirst({ where: { status: 'PENDING' as any }, orderBy: { runAt: 'asc' } })

  console.log('RUN_ID=' + `${opts.scenario}-${opts.provider}-${opts.seedSuffix}`)
  console.log('PROVIDER=' + opts.provider)
  console.log('SCENARIO=' + opts.scenario)
  console.log('LOAD_MODEL=' + (metrics.generatorSaturated ? 'OPEN_LOOP_SATURATED' : 'OPEN_LOOP'))
  console.log('TARGET_RPS=' + opts.rps)
  console.log('TARGET_REQUEST_COUNT=' + Math.round(opts.rps * opts.durationSec))
  console.log('DURATION=' + opts.durationSec)
  console.log('BUSINESSES=' + opts.businesses)
  console.log('REQUESTS_SCHEDULED=' + metrics.scheduled)
  console.log('REQUESTS_STARTED=' + metrics.started)
  console.log('REQUESTS_COMPLETED=' + metrics.completed)
  console.log('REQUESTS_ACCEPTED=' + metrics.requestsAccepted)
  console.log('REQUESTS_REJECTED=' + metrics.requestsRejected)
  console.log('ORDERS_CREATED=' + metrics.ordersCreated)
  const targetCount = Math.round(opts.rps * opts.durationSec)
  const genDur = Math.max(1, metrics.generationDurationSec)
  console.log('ACHIEVED_SEND_RPS=' + (metrics.started / genDur).toFixed(2))
  console.log('ACCEPTANCE_RPS=' + (metrics.requestsAccepted / genDur).toFixed(2))
  console.log('GENERATOR_BACKPRESSURE_EVENTS=' + metrics.backpressureEvents)
  console.log('MAX_INFLIGHT_OBSERVED=' + metrics.maxInflightObserved)
  console.log('LOAD_GENERATOR_TARGET_ACHIEVEMENT_PERCENT=' + (targetCount > 0 ? Math.round((metrics.started / targetCount) * 1000) / 10 : 0))
  console.log('FULFILLED=' + metrics.ordersFulfilled)
  console.log('RECONCILIATION=' + metrics.ordersReconciliation)
  console.log('FAILED=' + metrics.ordersFailed)
  console.log('FULFILLED_RPS_DRAIN=' + (metrics.ordersFulfilled / Math.max(1, genDur + opts.settleSec)).toFixed(2))
  console.log('LATENCY_P50_MS=' + (metrics.percentile(50) ?? 'null'))
  console.log('LATENCY_P95_MS=' + (metrics.percentile(95) ?? 'null'))
  console.log('LATENCY_P99_MS=' + (metrics.percentile(99) ?? 'null'))
  console.log('JOBS_ENQUEUED=' + metrics.jobsEnqueued)
  console.log('JOBS_COMPLETED=' + metrics.jobsCompleted)
  console.log('JOBS_FAILED=' + metrics.jobsFailed)
  console.log('PROVIDER_ATTEMPTS=' + metrics.providerAttempts)
  console.log('ESIMS_CREATED=' + metrics.esimsCreated)
  console.log('QUEUE_DEPTH_END=' + (pending ? 1 : 0))
  console.log('OLDEST_JOB_AGE_MS=' + (pending ? Math.max(0, Date.now() - pending.runAt.getTime()) : 0))
  console.log('EXPECTED_STATE=' + SCENARIO_CONTRACT[opts.scenario].expectedOrderState)
  console.log('RUN_STATUS=' + (invariant.runStatus === 'PASS' ? 'PASS' : 'FAIL'))
  return metrics
}

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }