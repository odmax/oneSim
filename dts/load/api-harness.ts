import { NextRequest } from 'next/server'
import type { Scenario, ProviderStrategy } from './scenarios'
import { Metrics } from './metrics'
import { seedApiLoad, type ApiSeedResult } from './api-seed'
import { connectorTypeForStrategy } from './load-seed'
import { checkDbInvariants, checkFakeDispatchCounts } from './invariants'
import { FakeConnector } from './fake-provider-driver'
import { prisma } from '../../src/lib/prisma'

export interface ApiIngressOptions {
  name: string
  scenario: Scenario
  provider: ProviderStrategy
  rps: number
  durationSec: number
  maxInflight: number
  businesses: number
  packagesPerProvider: number
  quantity: number
  settleSec: number
  scope: string
  /** Unique Idempotency-Key header per request (exercises the real idempotency path). */
  uniqueIdempotencyKeys: boolean
  /** Key/base prefix for per-request idempotency keys and customer emails
   *  (defaults to `scope`; overridable so series reusing one seed stay unique). */
  idemPrefix?: string
  /** Optional pre-provisioned load DB URL (reuse across runs). */
  preProvisionedUrl?: string
  /** Optional pre-seeded surface (storm test seeds its own single tenant). */
  seedSurface?: ApiSeedResult
  /** Timeout guard for the POST handler (ms). */
  handlerTimeoutMs?: number
}

export interface ApiIngressResult {
  metrics: Metrics
  orderIds: string[]
  httpStatusDist: Record<string, number>
  errorCodeDist: Record<string, number>
  runStatus: string
  seed: ApiSeedResult
  apiKeyForBusinessId: (businessId: string) => string | undefined
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function buildPostRequest(apiKey: string, body: Record<string, any>, idempotencyKey?: string): NextRequest {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'x-real-ip': '127.0.0.1',
    'user-agent': 'onesim-load-harness',
  }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  return new NextRequest('http://harness.invalid/api/v1/esims/order', { method: 'POST', headers, body: JSON.stringify(body) })
}

export async function runApiIngress(opts: ApiIngressOptions): Promise<ApiIngressResult> {
  const metrics = new Metrics()
  const { registerConnectorOverride } = await import('../../src/lib/providers/connectors/connector-factory')
  const connectorType = connectorTypeForStrategy(opts.provider)

  if (opts.preProvisionedUrl) {
    process.env.DATABASE_URL = opts.preProvisionedUrl
  }
  process.env.LOAD_HARNESS = '1'
  const { classifyLoadDb } = await import('./load-db')
  const gate = classifyLoadDb(process.env.DATABASE_URL!)
  console.log('LOAD_DB_GATE=' + (gate.ok ? 'PASS' : 'FAIL'))
  console.log('DATABASE_NAME=' + gate.databaseName)
  if (!gate.ok) throw new Error('LOAD_DB_GATE FAILED')
  const { assertLoadDbBinding } = await import('./bootstrap')
  const actualDb = await prisma.$queryRawUnsafe('SELECT current_database() AS db').then((r: any) => (r && r[0] ? String(r[0].db) : '')).catch(() => '')
  assertLoadDbBinding(actualDb, gate.databaseName)

  registerConnectorOverride(connectorType, (providerId: string) => new FakeConnector(providerId, opts.scenario))
  console.log('FAKE_PROVIDER_MODE=YES')

  const tel = await import('./telemetry')
  tel.attachQueryTelemetry(prisma)

  const seed = opts.seedSurface ?? (await seedApiLoad({
    businesses: opts.businesses,
    packagesPerProvider: opts.packagesPerProvider,
    providers: [opts.provider],
    quantity: opts.quantity,
    scope: opts.scope,
  }))

  // INGRESS-WINDOW quarantine (seed excluded).
  tel.telemetryClear()
  const probe = await tel.startProbe(prisma).catch(() => null)
  const sampler = setInterval(() => { if (probe) void tel.sampleProbe(prisma, probe).catch(() => {}) }, 1000)

  const { POST } = await import('../../src/app/api/v1/esims/order/route')
  const orderIds: string[] = []
  const httpStatusDist: Record<string, number> = {}
  const errorCodeDist: Record<string, number> = {}
  const apiKeyForBusinessId = (businessId: string): string | undefined => seed.apiKeyByBusinessId.get(businessId)

  const prefix = opts.idemPrefix ?? opts.scope
  const flatPackages: string[] = []
  for (const list of seed.packageIdsPerBusiness) flatPackages.push(...list)

  const startMs = Date.now()
  const { runOpenLoop } = await import('./open-loop')
  const genRes = await runOpenLoop({ targetRps: opts.rps, durationSec: opts.durationSec, maxInflight: opts.maxInflight }, async (N: number) => {
    const bIdx = N % seed.businessIds.length
    const pkg = flatPackages[N % flatPackages.length]
    const apiKey = seed.apiKeyByBusinessId.get(seed.businessIds[bIdx])!
    const body: Record<string, any> = {
      customerName: `API ${prefix} ${N}`,
      customerEmail: `api-${prefix}-${N}@onesim.test`,
      customerPhone: '+27000000000',
      country: 'ZA',
      packageId: pkg,
      quantity: opts.quantity,
    }
    const idem = opts.uniqueIdempotencyKeys ? `api-${prefix}-${N}` : undefined
    const req = buildPostRequest(apiKey, body, idem)
    const t0 = Date.now()
    try {
      const res = await POST(req)
      metrics.recordLatency(Date.now() - t0)
      metrics.requestsSent += 1
      metrics.started += 1
      const key = `HTTP_${res.status}`
      httpStatusDist[key] = (httpStatusDist[key] ?? 0) + 1
      const data = await res.json().catch(() => ({ success: false }))
      if (res.status === 200 && data.success) {
        metrics.requestsAccepted += 1
        metrics.ordersCreated += 1
        if (data.order?.id) orderIds.push(data.order.id)
      } else {
        metrics.requestsRejected += 1
        const code = data?.error?.code || 'UNKNOWN'
        errorCodeDist[code] = (errorCodeDist[code] ?? 0) + 1
      }
    } catch (e: any) {
      metrics.recordLatency(Date.now() - t0)
      metrics.requestsSent += 1
      metrics.started += 1
      metrics.requestsRejected += 1
      httpStatusDist['HTTP_500'] = (httpStatusDist['HTTP_500'] ?? 0) + 1
      errorCodeDist['HARNESS_HTTP_ERROR'] = (errorCodeDist['HARNESS_HTTP_ERROR'] ?? 0) + 1
    }
  })
  metrics.scheduled = genRes.scheduled
  metrics.started = genRes.started
  metrics.completed = genRes.completed
  metrics.backpressureEvents = genRes.backpressureEvents
  metrics.maxInflightObserved = genRes.maxInflightObserved
  metrics.generatorSaturated = genRes.saturated

  const genDuration = Math.max(1, (Date.now() - startMs) / 1000)
  metrics.generationDurationSec = genDuration

  // Close the INGRESS window telemetry.
  clearInterval(sampler)
  const probeFin = probe ? await tel.finishProbe(prisma, probe).catch(() => null) : null
  const totalQueries = tel.telemetryTotalCount()
  const accepted = Math.max(1, metrics.requestsAccepted)
  console.log('API_QUERIES_TOTAL=' + totalQueries)
  console.log('API_QUERIES_PER_ACCEPTED=' + (totalQueries / accepted).toFixed(1))
  const topQueries = tel.telemetrySummary(30)
  for (const t of topQueries) console.log('API_QUERY_GROUP|' + [t.key, t.count, t.totalMs, t.p50, t.p95, t.p99, t.maxMs].join('|'))
  if (probeFin) for (const [k, v] of Object.entries(probeFin)) console.log('API_' + k + '=' + v)
  // Attribution groups by route phase.
  const buckets = new Map(topQueries.map((r) => [String(r.key), r]))
  const sum = (keys: string[]): number => keys.reduce((a, k) => a + (Number(buckets.get(k)?.count) || 0), 0)
  const authQ = sum(['businessapikey.findfirst', 'businessapikey.update'])
  const idemQ = sum(['idempotencyrecord.findunique', 'idempotencyrecord.create'])
  console.log('API_AUTH_QUERIES_PER_REQUEST=' + (authQ / accepted).toFixed(2))
  console.log('API_IDEMPOTENCY_QUERIES_PER_REQUEST=' + (idemQ / accepted).toFixed(2))
  console.log('API_ROUTE_TOTAL_QUERIES_PER_REQUEST=' + (totalQueries / accepted).toFixed(1))

  // Settle: drain the real job queue (workers are OFF during the ingress window).
  metrics.jobsEnqueued = metrics.ordersCreated
  const { processDueJobs } = await import('../../src/lib/services/jobs/queue')
  const queueDepthEnd = await prisma.backgroundJob.count({ where: { status: 'PENDING' as any } })
  console.log('API_QUEUE_DEPTH_END=' + queueDepthEnd)
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
  metrics.runStatus = invariant.runStatus
  metrics.orderIds = orderIds
  const fake = { duplicateProviderDispatches: 0 }
  const { FAKE_INSTANCES } = await import('./fake-provider-driver')
  const dispatchAgg = new Map<string, number>()
  for (const inst of FAKE_INSTANCES) {
    for (const [k, c] of inst.dispatchSeen) dispatchAgg.set(k, (dispatchAgg.get(k) ?? 0) + c)
  }
  checkFakeDispatchCounts(dispatchAgg, fake)
  metrics.duplicateProviderDispatches = fake.duplicateProviderDispatches

  console.log('API_RUN=' + opts.name)
  console.log('API_REQUESTS_SCHEDULED=' + metrics.scheduled)
  console.log('API_REQUESTS_STARTED=' + metrics.started)
  console.log('API_REQUESTS_ACCEPTED=' + metrics.requestsAccepted)
  console.log('API_REQUESTS_REJECTED=' + metrics.requestsRejected)
  console.log('API_ACCEPTANCE_RPS=' + (metrics.requestsAccepted / Math.max(1, genDuration)).toFixed(2))
  console.log('API_TARGET_ACHIEVEMENT_PERCENT=' + (Math.round(opts.rps * opts.durationSec) > 0 ? Math.round((metrics.started / (opts.rps * opts.durationSec)) * 1000) / 10 : 0))
  console.log('API_GENERATOR_SATURATED=' + (metrics.generatorSaturated ? 'YES' : 'NO'))
  console.log('API_BACKPRESSURE_EVENTS=' + metrics.backpressureEvents)
  console.log('API_MAX_INFLIGHT_OBSERVED=' + metrics.maxInflightObserved)
  console.log('API_LATENCY_P50_MS=' + (metrics.percentile(50) ?? 'null'))
  console.log('API_LATENCY_P95_MS=' + (metrics.percentile(95) ?? 'null'))
  console.log('API_LATENCY_P99_MS=' + (metrics.percentile(99) ?? 'null'))
  console.log('API_LATENCY_MAX_MS=' + (metrics.max() ?? 'null'))
  console.log('API_HTTP_DIST=' + JSON.stringify(httpStatusDist))
  console.log('API_ERROR_DIST=' + JSON.stringify(errorCodeDist))
  console.log('API_JOBS_ENQUEUED=' + metrics.jobsEnqueued)
  console.log('API_JOBS_COMPLETED=' + metrics.jobsCompleted)
  console.log('API_JOBS_FAILED=' + metrics.jobsFailed)
  console.log('API_ORDERS_FULFILLED=' + metrics.ordersFulfilled)
  console.log('API_ORDERS_RECONCILIATION=' + metrics.ordersReconciliation)
  console.log('API_ORDERS_FAILED=' + metrics.ordersFailed)
  console.log('API_RUN_STATUS=' + invariant.runStatus)

  return { metrics, orderIds, httpStatusDist, errorCodeDist, runStatus: invariant.runStatus, seed, apiKeyForBusinessId }
}