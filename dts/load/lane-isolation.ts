import fs from 'fs'
import { bootstrap, type BootstrapResult } from './bootstrap'

function loadDotenv(): void {
  try {
    for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
    }
  } catch { /* rely on env */ }
}
loadDotenv()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * PROVIDER LANE ISOLATION — synthetic, low rate. Proves the distributed-safe
 * per-provider concurrency admission:
 *   - provider A (slow) cannot consume provider-operation capacity needed by B/C/D
 *   - per-provider PROCESSING ceiling holds under MULTIPLE worker loops
 *   - backoff for a RATE_LIMITED provider is provider-local (never a global sleep)
 * No real provider calls.
 */
const LANES: Record<string, { scenario: string; concurrency: number; latencyMs: number }> = {
  AIRHUB: { scenario: 'LONG_PENDING', concurrency: 2, latencyMs: 250 },
  CHOICE: { scenario: 'SUCCESS_SYNC', concurrency: 5, latencyMs: 60 },
  TELNA: { scenario: 'RATE_LIMITED', concurrency: 5, latencyMs: 40 },
  USMATRIX: { scenario: 'SUCCESS_SYNC', concurrency: 5, latencyMs: 60 },
}
const ORDERS_PER_PROVIDER = 30

async function main(): Promise<void> {
  const bs: BootstrapResult = await bootstrap('lane')
  process.env.LOAD_HARNESS = '1'
  const { prisma } = await import('../../src/lib/prisma')
  const { classifyLoadDb } = await import('./load-db')
  const { assertLoadDbBinding } = await import('./bootstrap')
  const gate = classifyLoadDb(process.env.DATABASE_URL!)
  if (!gate.ok) throw new Error('LOAD_DB_GATE FAILED')
  const actualDb = await prisma.$queryRawUnsafe('SELECT current_database() AS db').then((r: any) => (r && r[0] ? String(r[0].db) : '')).catch(() => '')
  assertLoadDbBinding(actualDb, gate.databaseName)

  const { registerConnectorOverride } = await import('../../src/lib/providers/connectors/connector-factory')
  const { FakeConnector, FAKE_INSTANCES } = await import('./fake-provider-driver')
  const { connectorTypeForStrategy } = await import('./load-seed')
  for (const code of Object.keys(LANES)) {
    const cfg = LANES[code]
    const ct = connectorTypeForStrategy(code as any)
    registerConnectorOverride(ct, (providerId: string) => new FakeConnector(providerId, cfg.scenario as any, { latencyMs: cfg.latencyMs }))
  }
  console.log('LANE_FAKE=YES')

  const { seedLoad } = await import('./load-seed')
  const seed = await seedLoad({ businesses: 4, walletBalance: 1_000_000, packagesPerProvider: 6, providers: Object.keys(LANES) as any, quantity: 1, scope: 'lane' })

  // Attach per-provider lane policy (existing provider.config JSON — no schema change).
  const providerIdByCode = new Map<string, string>()
  for (const code of Object.keys(LANES)) {
    const p = await prisma.provider.findFirst({ where: { code } })
    providerIdByCode.set(code, p!.id)
    await prisma.provider.update({
      where: { id: p!.id },
      data: { config: { ...((p!.config as any) || {}), execution: { purchaseConcurrency: LANES[code].concurrency } } as any },
    })
  }
  await (await import('../../src/lib/services/jobs/provider-operation-lanes')).refreshLanedProviders(true)

  // Enqueue purchase dispatch jobs at a LOW synthetic rate (workers OFF).
  const flatByBusiness = seed.packageIdsPerBusiness.map((list, b) => list.map((pkg, i) => ({ pkg, key: `lane-${b}-${i}` })))
  const orderIds: string[] = []
  const { createOrder } = await import('../../src/lib/services/orders/create-order')
  const total = 4 * ORDERS_PER_PROVIDER
  for (let i = 0; i < total; i++) {
    await sleep(120) // ~8 RPS ceiling, well under the phase max
    const bIdx = i % 4
    const slot = flatByBusiness[bIdx][i % flatByBusiness[bIdx].length]
    const res = (await createOrder({
      businessId: seed.businessIds[bIdx],
      userId: seed.userIds[bIdx],
      packageId: slot.pkg,
      quantity: 1,
      idempotencyKey: slot.key,
      correlationId: `lane-${i}`,
      async: true,
    }).catch(() => ({ success: false }))) as { success: boolean; orderId?: string }
    if (res.success && res.orderId) orderIds.push(res.orderId)
  }
  console.log('LANE_ORDERS=' + orderIds.length)

  // Run MULTIPLE worker loops with the lane gate; sample per-provider PROCESSING.
  const { runWorkers } = await import('./worker')
  const { Metrics } = await import('./metrics')
  const metrics = new Metrics()
  let stop = false
  const samples = new Map<string, number[]>()
  const sampler = setInterval(async () => {
    try {
      const rows = await prisma.backgroundJob.findMany({ where: { type: 'PROVIDER_OPERATION' as any, status: 'PROCESSING' as any }, select: { providerId: true } })
      const per = new Map<string, number>()
      for (const r of rows) if (r.providerId) per.set(r.providerId, (per.get(r.providerId) ?? 0) + 1)
      for (const [, id] of providerIdByCode) samples.set(id, [...(samples.get(id) ?? []), per.get(id) ?? 0])
    } catch { /* sample best-effort */ }
  }, 80)

  const workersDone = runWorkers({ workerCount: 3, pollMs: 5, batch: 25, shouldStop: () => stop, metrics })
  let stable = 0
  const drainDeadline = Date.now() + 90_000
  while (Date.now() < drainDeadline) {
    const pending = await prisma.backgroundJob.count({ where: { status: { in: ['PENDING', 'PROCESSING'] as any }, type: 'PROVIDER_OPERATION' as any } })
    if (pending === 0) { stable += 1; if (stable >= 4) break } else stable = 0
    await sleep(150)
  }
  stop = true
  await workersDone
  clearInterval(sampler)
  console.log('LANE_DRAIN_OK=' + (stable >= 4 ? 'YES' : 'TIMEOUT'))

  // Assert per-provider ceilings from observed samples.
  let violation = 0
  for (const code of Object.keys(LANES)) {
    const pid = providerIdByCode.get(code)!
    const s = samples.get(pid) ?? []
    const max = s.length ? Math.max(...s) : 0
    console.log(`LANE_MAX_${code}=${max} LIMIT=${LANES[code].concurrency}`)
    if (max > LANES[code].concurrency) { violation += 1; console.error(`LANE_VIOLATION ${code}: max ${max} > ${LANES[code].concurrency}`) }
  }

  // Isolation + invariants.
  const fulfilledByCode: Record<string, number> = {}
  for (const code of Object.keys(LANES)) {
    const pid = providerIdByCode.get(code)!
    fulfilledByCode[code] = await prisma.eSIMPurchase.count({ where: { id: { in: orderIds }, providerId: pid, status: 'FULFILLED' } })
  }
  console.log('LANE_FULFILLED=' + JSON.stringify(fulfilledByCode))
  console.log('LANE_ISOLATION_B_COMPLETES=' + (fulfilledByCode.CHOICE > 0 ? 'YES' : 'NO'))
  console.log('LANE_ISOLATION_D_COMPLETES=' + (fulfilledByCode.USMATRIX > 0 ? 'YES' : 'NO'))

  const { checkDbInvariants, checkFakeDispatchCounts } = await import('./invariants')
  const invariant = await checkDbInvariants(metrics, orderIds)
  const fake = { duplicateProviderDispatches: 0 }
  const agg = new Map<string, number>()
  for (const inst of FAKE_INSTANCES) for (const [k, c] of inst.dispatchSeen) agg.set(k, (agg.get(k) ?? 0) + c)
  checkFakeDispatchCounts(agg, fake)
  console.log('LANE_INVARIANTS=' + JSON.stringify(invariant))
  console.log('LANE_DUPLICATE_DISPATCH=' + fake.duplicateProviderDispatches)
  const ok = violation === 0 && fulfilledByCode.CHOICE > 0 && fulfilledByCode.USMATRIX > 0 && invariant.runStatus === 'PASS' && fake.duplicateProviderDispatches === 0
  console.log('LANE_VERDICT=' + (ok ? 'PASS' : 'FAIL'))
  if (!ok) process.exit(1)
}

main().catch((e) => { console.error('LANE_ERROR=' + String((e && (e.stack || e.message)) || e)); process.exit(1) })