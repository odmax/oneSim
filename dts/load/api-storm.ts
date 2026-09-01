import fs from 'fs'
import { NextRequest } from 'next/server'
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

async function main(): Promise<void> {
  const bs: BootstrapResult = await bootstrap('apistorm')
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
  const seed = await seedApiLoad({ businesses: 1, packagesPerProvider: 40, providers: ['AIRHUB'], quantity: 1, scope: 'storm' })
  const businessId = seed.businessIds[0]
  const apiKey = seed.apiKeyByBusinessId.get(businessId)!
  const packageId = seed.packageIdsPerBusiness[0][0]

  const { POST } = await import('../../src/app/api/v1/esims/order/route')

  const IDEM_KEY = 'storm-same-key'
  const body = {
    customerName: 'Storm Customer',
    customerEmail: 'storm@onesim.test',
    customerPhone: '+27000000000',
    country: 'ZA',
    packageId,
    quantity: 1,
  }

  const count = 100
  const t0 = Date.now()
  const responses = await Promise.all(Array.from({ length: count }, async () => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': IDEM_KEY,
      'x-real-ip': '127.0.0.1',
    }
    const req = new NextRequest('http://harness.invalid/api/v1/esims/order', { method: 'POST', headers, body: JSON.stringify(body) })
    const res = await POST(req)
    const data = await res.json().catch(() => ({}))
    return { status: res.status, orderId: data?.order?.id as string | undefined, data }
  }))
  const stormMs = Date.now() - t0

  const statusDist: Record<string, number> = {}
  const errorCodes: Record<string, number> = {}
  for (const r of responses) {
    statusDist[`HTTP_${r.status}`] = (statusDist[`HTTP_${r.status}`] ?? 0) + 1
    const code = r.data?.error?.code
    const msg = r.data?.error?.message
    const label = code ? String(code) : (typeof msg === 'string' ? msg.substring(0, 60) : `HTTP_${r.status}`)
    errorCodes[label] = (errorCodes[label] ?? 0) + 1
  }
  const distinctOrderIds = new Set<string>()
  for (const r of responses) if (r.orderId) distinctOrderIds.add(r.orderId)
  const okResponses = responses.filter((r) => r.status === 200).length

  console.log('STORM_REQUESTS=' + count)
  console.log('STORM_ELAPSED_MS=' + stormMs)
  console.log('STORM_HTTP_DIST=' + JSON.stringify(statusDist))
  console.log('STORM_ERROR_CODES=' + JSON.stringify(errorCodes))
  console.log('STORM_OK_200=' + okResponses)
  console.log('STORM_DISTINCT_ORDER_IDS=' + distinctOrderIds.size)

  if (distinctOrderIds.size !== 1) {
    console.error('STORM_INVARIANT=FAIL expected exactly 1 logical order, got ' + distinctOrderIds.size)
    process.exit(1)
  }
  const orderId = [...distinctOrderIds][0]

  // Ingress-time financial safety (no provider dispatch yet).
  const reserves = await prisma.walletTransaction.count({ where: { orderId, type: 'WALLET_RESERVE' as any } })
  const jobs = await prisma.backgroundJob.count({ where: { type: 'PROVIDER_OPERATION' as any } })
  const attempts = await prisma.providerAttempt.count({ where: { orderId, source: 'PURCHASE' } })
  const esims = await prisma.eSIM.count({ where: { purchaseId: orderId } })
  console.log('STORM_INGRESS_RESERVES=' + reserves)
  console.log('STORM_INGRESS_JOBS=' + jobs)
  console.log('STORM_INGRESS_PROVIDER_ATTEMPTS=' + attempts)
  console.log('STORM_INGRESS_ESIMS=' + esims)

  const order = await prisma.eSIMPurchase.findUnique({ where: { id: orderId }, select: { status: true, quantity: true } })
  console.log('STORM_INGRESS_ORDER_STATUS=' + order?.status)

  // Drain the one job with fake provider.
  const { processDueJobs } = await import('../../src/lib/services/jobs/queue')
  const drainEnd = Date.now() + 10_000
  let drained = false
  while (Date.now() < drainEnd) {
    const res = await processDueJobs({ types: ['PROVIDER_OPERATION' as any], limit: 10 })
    if (res.length === 0) { if (drained) break; drained = true }
    await sleep(20)
  }

  const postAttempts = await prisma.providerAttempt.count({ where: { orderId, source: 'PURCHASE' } })
  const postOrder = await prisma.eSIMPurchase.findUnique({ where: { id: orderId }, select: { status: true, quantity: true } })
  const postCaptures = await prisma.walletTransaction.count({ where: { orderId, type: 'WALLET_CAPTURE' as any } })
  const postEsims = await prisma.eSIM.count({ where: { purchaseId: orderId } })
  console.log('STORM_POST_DRAIN_PROVIDER_ATTEMPTS=' + postAttempts)
  console.log('STORM_POST_DRAIN_CAPTURES=' + postCaptures)
  console.log('STORM_POST_DRAIN_ORDER_STATUS=' + postOrder?.status)
  console.log('STORM_POST_DRAIN_ESIMS=' + postEsims)
  console.log('STORM_POST_DRAIN_QUANTITY=' + postOrder?.quantity)

  // Surface the stored failure reason from the real request-log table.
  const errGroups = await (prisma.apiRequestLog as any).groupBy({
    by: ['errorMessage'],
    _count: true,
    where: { statusCode: 400 },
  }).catch(() => [])
  console.log('STORM_REQUEST_LOG_400=' + JSON.stringify(errGroups))

  const ok = distinctOrderIds.size === 1 && reserves === 1 && jobs === 1 && attempts === 0
    && postAttempts === 1 && postCaptures === 1 && postOrder?.status === 'FULFILLED' && postEsims === 1
  console.log('STORM_VERDICT=' + (ok ? 'PASS' : 'FAIL'))
  if (!ok) process.exit(1)
}

main().catch((e) => { console.error('STORM_ERROR=' + String((e && (e.stack || e.message)) || e)); process.exit(1) })