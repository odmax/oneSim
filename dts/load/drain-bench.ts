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

function mainArg(name: string): string | undefined {
  const argv = process.argv.slice(2)
  const i = argv.findIndex((a) => a.startsWith(`--${name}=`))
  if (i >= 0) return argv[i].slice(name.length + 3)
  return undefined
}

async function main(): Promise<void> {
  const bs: BootstrapResult = await bootstrap('drain')
  process.env.LOAD_HARNESS = '1'
  const { prisma } = await import('../../src/lib/prisma')
  const { classifyLoadDb } = await import('./load-db')
  const { assertLoadDbBinding } = await import('./bootstrap')
  const gate = classifyLoadDb(process.env.DATABASE_URL!)
  if (!gate.ok) throw new Error('LOAD_DB_GATE FAILED')
  const actualDb = await prisma.$queryRawUnsafe('SELECT current_database() AS db').then((r: any) => (r && r[0] ? String(r[0].db) : '')).catch(() => '')
  assertLoadDbBinding(actualDb, gate.databaseName)

  const { registerConnectorOverride } = await import('../../src/lib/providers/connectors/connector-factory')
  const { FakeConnector } = await import('./fake-provider-driver')
  const { connectorTypeForStrategy } = await import('./load-seed')
  registerConnectorOverride(connectorTypeForStrategy('AIRHUB'), (providerId: string) => new FakeConnector(providerId, 'SUCCESS_SYNC'))

  const { seedApiLoad } = await import('./api-seed')
  const { createOrder } = await import('../../src/lib/services/orders/create-order')
  const { runWorkers } = await import('./worker')

  const batchSize = parseInt(mainArg('batch') || '400', 10)
  const injectRps = parseInt(mainArg('inject-rps') || '60', 10)
  const workerCounts = (mainArg('workers') || '1,2,4,8').split(',').map((s) => parseInt(s.trim(), 10))
  // Packages per batch must exceed the batch size so the real 30s dedup window
  // never collapses an injection (each (business, package) combo used once).
  const packagesPerBatch = Math.min(500, Math.max(batchSize + 50, 250))

  const injectOrders = async (surface: { businessIds: string[]; userIds: string[]; packageIdsPerBusiness: string[][] }, scope2: string): Promise<string[]> => {
    const flatPackages: string[] = []
    for (const list of surface.packageIdsPerBusiness) flatPackages.push(...list)
    const orderIds: string[] = []
    const interval = 1000 / injectRps
    const start = Date.now()
    for (let i = 0; i < batchSize; i++) {
      const slotAt = start + i * interval
      const now = Date.now()
      if (slotAt > now) await sleep(slotAt - now)
      const bIdx = i % surface.businessIds.length
      const res = (await createOrder({
        businessId: surface.businessIds[bIdx],
        userId: surface.userIds[bIdx],
        packageId: flatPackages[i % flatPackages.length],
        quantity: 1,
        idempotencyKey: `drain-${scope2}-${i}`,
        correlationId: `${scope2}-${i}`,
        async: true,
      }).catch(() => ({ success: false }))) as { success: boolean; orderId?: string }
      if (res.success && res.orderId) orderIds.push(res.orderId)
    }
    // Distinguish orders created in THIS batch from dedup replays of older
    // batches (their providerPurchaseKey carries this batch's marker).
    const createdThisBatch = await prisma.eSIMPurchase.count({
      where: { id: { in: orderIds }, providerPurchaseKey: { startsWith: `${surface.businessIds[0]}:drain-${scope2}-` } },
    })
    console.log('DRAIN_INJECTED=' + orderIds.length + ' REAL_NEW=' + createdThisBatch + ' SCOPE=' + scope2)
    return orderIds
  }

  for (const wc of workerCounts) {
    const scope = `drainw${wc}`
    // Fresh, dedup-isolated tenant surface per worker-count batch.
    const surface = await seedApiLoad({ businesses: 2, packagesPerProvider: packagesPerBatch, providers: ['AIRHUB'], quantity: 1, scope })
    const orderIds = await injectOrders(surface, scope)
    const pendingBefore = await prisma.backgroundJob.count({ where: { status: 'PENDING' as any, type: 'PROVIDER_OPERATION' as any } })
    console.log('DRAIN_TEST_WORKERS=' + wc + ' PENDING_BEFORE=' + pendingBefore)

    let stop = false
    const t0 = Date.now()
    const workersDone = runWorkers({
      workerCount: wc,
      pollMs: 5,
      batch: 50,
      shouldStop: () => stop,
      metrics: { jobsCompleted: 0, jobsFailed: 0 } as any,
    })
    let stableRounds = 0
    while (true) {
      const pending = await prisma.backgroundJob.count({ where: { status: { in: ['PENDING', 'PROCESSING'] as any }, type: 'PROVIDER_OPERATION' as any } })
      if (pending === 0) { stableRounds += 1; if (stableRounds >= 2) break } else stableRounds = 0
      await sleep(100)
    }
    stop = true
    await workersDone
    const drainMs = Math.max(1, Date.now() - t0)
    const drainSec = drainMs / 1000

    // Job statistics scoped to THIS batch via the correlationId payload marker.
    const allJobs = await prisma.backgroundJob.findMany({
      where: { type: 'PROVIDER_OPERATION' as any },
      select: { status: true, runAt: true, updatedAt: true, payload: true },
    })
    const batchJobs = allJobs.filter((j) => {
      const cid = (j.payload as any)?.correlationId
      return typeof cid === 'string' && cid.startsWith(`${scope}-`)
    })
    const terminal = batchJobs.filter((j) => j.status === 'COMPLETED' || j.status === 'FAILED')
    const completedByOrder = batchJobs.filter((j) => j.status === 'COMPLETED').length
    const failedJobs = batchJobs.filter((j) => j.status === 'FAILED').length

    const fulfilled = await prisma.eSIMPurchase.count({ where: { id: { in: orderIds }, status: 'FULFILLED' } })
    const captures = await prisma.walletTransaction.count({ where: { orderId: { in: orderIds }, type: 'WALLET_CAPTURE' as any } })
    const attempts = await prisma.providerAttempt.count({ where: { orderId: { in: orderIds }, source: 'PURCHASE' } })

    const lats: number[] = []
    for (const j of terminal) lats.push(Math.max(0, j.updatedAt.getTime() - j.runAt.getTime()))
    lats.sort((a, b) => a - b)
    const perc = (p: number) => { if (lats.length === 0) return 0; const i = Math.min(lats.length - 1, Math.max(0, Math.ceil((p / 100) * lats.length) - 1)); return lats[i] }

    console.log('DRAIN_W=' + wc)
    console.log('DRAIN_JOBS_COMPLETED=' + completedByOrder)
    console.log('DRAIN_JOBS_FAILED=' + failedJobs)
    console.log('DRAIN_TIME_SEC=' + drainSec.toFixed(2))
    console.log('JOBS_PER_SEC=' + (completedByOrder / drainSec).toFixed(1))
    console.log('FULFILLED_PER_SEC=' + (fulfilled / drainSec).toFixed(1))
    console.log('CAPTURES_PER_SEC=' + (captures / drainSec).toFixed(1))
    console.log('DRAIN_PROVIDER_ATTEMPTS=' + attempts)
    console.log('DRAIN_JOB_LATENCY_P50_MS=' + perc(50))
    console.log('DRAIN_JOB_LATENCY_P95_MS=' + perc(95))
  }
}

main().catch((e) => { console.error('DRAIN_ERROR=' + String((e && (e.stack || e.message)) || e)); process.exit(1) })