import fs from 'fs'
import crypto from 'crypto'
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

interface Check { name: string; pass: boolean; detail?: string }
const results: Check[] = []
function record(name: string, pass: boolean, detail = ''): void { results.push({ name, pass, detail }) }

function req(apiKey: string | null, method: string, path: string, body?: any, idemKey?: string): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  if (idemKey) headers['Idempotency-Key'] = idemKey
  return new NextRequest(`http://harness.invalid${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}

async function exec(handler: any, r: NextRequest, args?: any): Promise<{ status: number; data: any }> {
  try {
    const res = await handler(r, args)
    const data = await res.json().catch(() => ({}))
    return { status: res.status, data }
  } catch (e: any) {
    return { status: 0, data: { error: { code: 'THREW', message: String(e?.message || e) } } }
  }
}

async function main(): Promise<void> {
  const bs: BootstrapResult = await bootstrap('cert')
  process.env.LOAD_HARNESS = '1'
  const { prisma } = await import('../../src/lib/prisma')
  const { assertLoadDbBinding } = await import('./bootstrap')
  const actualDb = await prisma.$queryRawUnsafe('SELECT current_database() AS db').then((r: any) => (r && r[0] ? String(r[0].db) : '')).catch(() => '')
  assertLoadDbBinding(actualDb, bs.gate.databaseName)

  const { registerConnectorOverride } = await import('../../src/lib/providers/connectors/connector-factory')
  const { FakeConnector } = await import('./fake-provider-driver')
  const { connectorTypeForStrategy } = await import('./load-seed')
  registerConnectorOverride(connectorTypeForStrategy('AIRHUB'), (providerId: string) => new FakeConnector(providerId, 'SUCCESS_SYNC'))

  const { seedApiLoad } = await import('./api-seed')
  const seed = await seedApiLoad({ businesses: 2, packagesPerProvider: 4, providers: ['AIRHUB'], quantity: 1, scope: 'cert' })
  const bizA = seed.businessIds[0]
  const bizB = seed.businessIds[1]
  const keyA = seed.apiKeyByBusinessId.get(bizA)!
  const keyB = seed.apiKeyByBusinessId.get(bizB)!
  const pkgA = seed.packageIdsPerBusiness[0][0]
  const pkgB = seed.packageIdsPerBusiness[1][0]

  // Revoked key: flip a fresh key's status to INACTIVE.
  const { hashApiKey } = await import('../../src/lib/api/auth')
  const revokedRaw = `onesim_${crypto.randomBytes(12).toString('hex')}`
  const revokedKey = await prisma.businessApiKey.create({ data: { businessId: bizA, name: 'revocable', keyHash: hashApiKey(revokedRaw), keyPrefix: revokedRaw.slice(0, 12), status: 'ACTIVE' as any, scopes: [] } })
  await prisma.businessApiKey.update({ where: { id: revokedKey.id }, data: { status: 'REVOKED' as any } })
  // Scope-limited key: orders:read only.
  const scopeRaw = `onesim_scope_${Math.random().toString(36).slice(2)}`
  await prisma.businessApiKey.create({ data: { businessId: bizA, name: 'scope-limited', keyHash: hashApiKey(scopeRaw), keyPrefix: scopeRaw.slice(0, 12), status: 'ACTIVE' as any, scopes: ['orders:read'] } })

  const verify = await import('../../src/app/api/v1/auth/verify/route')
  const packagesRoute = await import('../../src/app/api/v1/packages/route')
  const orderPost = await import('../../src/app/api/v1/esims/order/route')
  const ordersList = await import('../../src/app/api/v1/orders/route')
  const ordersDetail = await import('../../src/app/api/v1/orders/[orderId]/route')
  const esimDetail = await import('../../src/app/api/v1/esims/[esimId]/route')
  const usage = await import('../../src/app/api/v1/esims/[esimId]/usage/route')
  const topup = await import('../../src/app/api/v1/esims/[esimId]/top-up/route')
  const wallet = await import('../../src/app/api/v1/wallet/route')
  const webhooks = await import('../../src/app/api/v1/webhooks/route')

  // ── 1. AUTHENTICATION ──────────────────────────────────────────────
  const vOk = await exec(verify.GET, req(keyA, 'GET', '/api/v1/auth/verify'))
  record('AUTH_VALID_KEY', vOk.status === 200 && vOk.data?.businessId === bizA, `status=${vOk.status} biz=${vOk.data?.businessId}`)
  const vMissing = await exec(verify.GET, req(null, 'GET', '/api/v1/auth/verify'))
  record('AUTH_MISSING_KEY', vMissing.status === 401, `status=${vMissing.status}`)
  const vInvalid = await exec(verify.GET, req('onesim_definitely_invalid', 'GET', '/api/v1/auth/verify'))
  record('AUTH_INVALID_KEY', vInvalid.status === 401, `status=${vInvalid.status}`)
  const vRevoked = await exec(verify.GET, req(revokedRaw, 'GET', '/api/v1/auth/verify'))
  record('AUTH_REVOKED_KEY', vRevoked.status === 401, `status=${vRevoked.status}`)
  const scopeHit = await exec(orderPost.POST, req(scopeRaw, 'POST', '/api/v1/esims/order', { packageId: pkgA, quantity: 1, customerName: 'X', customerEmail: 'x@y.io' }))
  record('AUTH_WRONG_SCOPE', scopeHit.status === 403, `status=${scopeHit.status} code=${scopeHit.data?.error?.code}`)

  // ── 2. CATALOG ─────────────────────────────────────────────────────
  const cat = await exec(packagesRoute.GET, req(keyA, 'GET', '/api/v1/packages'))
  const items = cat.data?.packages ?? []
  const leak = items.some((p: any) => p.costPrice != null || p.cost != null || p.providerId != null || p.provider != null || p.markup != null)
  record('CATALOG_200', cat.status === 200 && items.length > 0, `status=${cat.status} count=${items.length}`)
  record('CATALOG_NO_COST_LEAK', !leak, 'public dto must not expose cost/provider/markup')
  record('CATALOG_RETAIL_PRICE', items.every((p: any) => typeof p.unitPrice === 'number' && p.unitPrice > 0), 'retail price present')

  // ── 3. PURCHASE + RETRIEVAL + TENANT ───────────────────────────────
  const idemKey = `cert-${Date.now()}`
  const p1 = await exec(orderPost.POST, req(keyA, 'POST', '/api/v1/esims/order', { packageId: pkgA, quantity: 1, customerName: 'Cert User', customerEmail: 'cert-user@onesim.test' }, idemKey))
  const orderId = p1.data?.order?.id
  record('PURCHASE_200', p1.status === 200 && !!orderId && p1.data?.order?.status === 'PROCESSING', `status=${p1.status}`)

  // Bad request / error contract
  const missingPkg = await exec(orderPost.POST, req(keyA, 'POST', '/api/v1/esims/order', { quantity: 1, customerName: 'X', customerEmail: 'x@y.io' }))
  record('ERROR_MISSING_PACKAGE', missingPkg.status === 400 && missingPkg.data?.error?.code === 'MISSING_PACKAGE_ID', `status=${missingPkg.status} code=${missingPkg.data?.error?.code}`)
  const badQty = await exec(orderPost.POST, req(keyA, 'POST', '/api/v1/esims/order', { packageId: pkgA, quantity: 101, customerName: 'X', customerEmail: 'x@y.io' }))
  record('ERROR_INVALID_QUANTITY', badQty.status === 400, `status=${badQty.status} code=${badQty.data?.error?.code}`)

  if (orderId) {
    const oDetail = await exec(ordersDetail.GET, req(keyA, 'GET', `/api/v1/orders/${orderId}`), { params: { orderId } })
    record('ORDER_DETAIL_200', oDetail.status === 200, `status=${oDetail.status}`)
    const oTenant = await exec(ordersDetail.GET, req(keyB, 'GET', `/api/v1/orders/${orderId}`), { params: { orderId } })
    record('TENANT_ORDER_ISOLATION', oTenant.status === 404 || oTenant.status === 403, `status=${oTenant.status}`)
  }

  // Idempotency: same key + DIFFERENT payload → HTTP 409 (no second order).
  const p1diff = await exec(orderPost.POST, req(keyA, 'POST', '/api/v1/esims/order', { packageId: pkgA, quantity: 2, customerName: 'Different', customerEmail: 'diff@onesim.test' }, idemKey))
  const idemOrders = await prisma.eSIMPurchase.count({ where: { providerPurchaseKey: `${bizA}:${idemKey}` } })
  record('IDEMPOTENCY_DIFF_QUANTITY_409', p1diff.status === 409 && p1diff.data?.error?.code === 'IDEMPOTENCY_KEY_REUSED', `status=${p1diff.status} code=${p1diff.data?.error?.code}`)
  record('IDEMPOTENCY_DIFF_ONE_ORDER', idemOrders === 1, `orders=${idemOrders}`)
  // Same key + different package → 409.
  const p1diffPkg = await exec(orderPost.POST, req(keyA, 'POST', '/api/v1/esims/order', { packageId: pkgB, quantity: 1, customerName: 'Different', customerEmail: 'diff@onesim.test' }, idemKey))
  record('IDEMPOTENCY_DIFF_PACKAGE_409', p1diffPkg.status === 409, `status=${p1diffPkg.status}`)
  // Same key + different travel date → 409.
  const p1diffTravel = await exec(orderPost.POST, req(keyA, 'POST', '/api/v1/esims/order', { packageId: pkgA, quantity: 1, travelDate: '2026-12-01', customerName: 'X', customerEmail: 'x@y.io' }, idemKey))
  record('IDEMPOTENCY_DIFF_TRAVEL_409', p1diffTravel.status === 409, `status=${p1diffTravel.status}`)
  // Same key + SAME payload → deterministic 200 replay, still one order.
  const replay = await exec(orderPost.POST, req(keyA, 'POST', '/api/v1/esims/order', { packageId: pkgA, quantity: 1, customerName: 'Cert User', customerEmail: 'cert-user@onesim.test' }, idemKey))
  record('IDEMPOTENCY_SAME_REPLAY_200', replay.status === 200 && replay.data?.order?.id === orderId, `status=${replay.status} sameOrder=${replay.data?.order?.id === orderId}`)
  const idemFinal = await prisma.eSIMPurchase.count({ where: { providerPurchaseKey: `${bizA}:${idemKey}` } })
  record('IDEMPOTENCY_TOTAL_ONE_ORDER', idemFinal === 1, `orders=${idemFinal}`)
  // Replay body must NOT leak the private identity field.
  record('IDEMPOTENCY_NO_INTERNAL_LEAK', replay.data?.__requestIdentity === undefined, `leak=${replay.data?.__requestIdentity}`)

  // ── 4. DRAIN → FULFILLED → ESIM DETAIL / USAGE / TOPUP / WALLET ─────
  const { processDueJobs } = await import('../../src/lib/services/jobs/queue')
  const drainEnd = Date.now() + 15000
  let stable = 0
  while (Date.now() < drainEnd) {
    const res = await processDueJobs({ types: ['PROVIDER_OPERATION' as any], limit: 50 })
    if (res.length === 0) { stable += 1; if (stable >= 2) break } else stable = 0
    await sleep(20)
  }
  const orderRow = orderId ? await prisma.eSIMPurchase.findUnique({ where: { id: orderId }, select: { id: true, status: true } }) : null
  const esimRow = orderId ? await prisma.eSIM.findFirst({ where: { purchaseId: orderId }, select: { id: true, iccid: true } }) : null
  record('DRAIN_FULFILLED', orderRow?.status === 'FULFILLED' && !!esimRow, `status=${orderRow?.status} esim=${!!esimRow}`)

  if (esimRow && orderId) {
    const e = await exec(esimDetail.GET, req(keyA, 'GET', `/api/v1/esims/${esimRow.id}`), { params: { esimId: esimRow.id } })
    record('ESIM_DETAIL_200', e.status === 200 && typeof e.data?.esim?.iccid === 'string' && String(e.data?.esim?.iccid).length >= 16, `status=${e.status} hasIccid=${!!e.data?.esim?.iccid}`)
    const eTenant = await exec(esimDetail.GET, req(keyB, 'GET', `/api/v1/esims/${esimRow.id}`), { params: { esimId: esimRow.id } })
    record('TENANT_ESIM_ISOLATION', eTenant.status === 403 || eTenant.status === 404, `status=${eTenant.status}`)
    const u = await exec(usage.GET, req(keyA, 'GET', `/api/v1/esims/${esimRow.id}/usage`), { params: { esimId: esimRow.id } })
    record('USAGE_DETERMINISTIC', u.status > 0 && ![500].includes(u.status), `status=${u.status} code=${u.data?.error?.code || '(usage data)'}`)
    const t = await exec(topup.POST, req(keyA, 'POST', `/api/v1/esims/${esimRow.id}/top-up`, { packageId: pkgA, quantity: 1 }), { params: { esimId: esimRow.id } })
    record('TOPUP_DETERMINISTIC', t.status > 0 && t.status !== 500, `status=${t.status} code=${t.data?.error?.code || '(ok)'}`)
  }
  const w = await exec(wallet.GET, req(keyA, 'GET', '/api/v1/wallet'))
  record('WALLET_200', w.status === 200 && typeof w.data?.wallet?.balance === 'number', `status=${w.status}`)

  // ── 5. WEBHOOKS (tenant list + create + isolation) ─────────────────
  const whListA = await exec(webhooks.GET, req(keyA, 'GET', '/api/v1/webhooks'))
  record('WEBHOOKS_LIST_200', whListA.status === 200 && Array.isArray(whListA.data?.webhooks), `status=${whListA.status}`)
  const whCreate = await exec(webhooks.POST, req(keyA, 'POST', '/api/v1/webhooks', { name: 'cert-hook', url: 'https://client.example.com/hook', secret: 's3cret', events: ['order.completed'] }))
  record('WEBHOOKS_CREATE', whCreate.status === 200 || whCreate.status === 201, `status=${whCreate.status}`)
  const whListB = await exec(webhooks.GET, req(keyB, 'GET', '/api/v1/webhooks'))
  record('WEBHOOKS_TENANT_ISOLATION', Array.isArray(whListB.data?.webhooks) && whListB.data.webhooks.length === 0, `bList=${whListB.data?.webhooks?.length}`)

  // ── 6. RATE LIMIT BURST (null ⇒ unlimited; explicit ⇒ enforced) ─────────
  // Null limit: burst of 75 auth-verify requests must NEVER be 429 (old 60/min default removed).
  let rate429Null = 0
  for (let i = 0; i < 75; i++) {
    const r = await exec(verify.GET, req(keyA, 'GET', '/api/v1/auth/verify'))
    if (r.status === 429) rate429Null += 1
  }
  record('RATE_NULL_75_NO_429', rate429Null === 0, `429=${rate429Null}`)

  // Explicit limit=60 on a FRESH business: ceiling is enforced (429 observed).
  const freshBiz = await prisma.business.create({ data: { name: 'Cert Rate Business', contactEmail: `rate-${Date.now()}@onesim.test`, country: 'ZA', status: 'APPROVED' as any, walletBalance: 100, rateLimitPerMinute: 60 } })
  const freshUser = await prisma.user.create({ data: { email: `rateu-${Date.now()}@onesim.test`, name: 'Rate User', role: 'BUSINESS_USER' as any } })
  await prisma.businessUser.create({ data: { businessId: freshBiz.id, userId: freshUser.id, role: 'ADMIN' as any } })
  const freshRaw = `onesim_fr_${crypto.randomBytes(10).toString('hex')}`
  await prisma.businessApiKey.create({ data: { businessId: freshBiz.id, name: 'rate-key', keyHash: hashApiKey(freshRaw), keyPrefix: freshRaw.slice(0, 12), status: 'ACTIVE' as any, scopes: [] } })
  let rate429Explicit = 0
  for (let i = 0; i < 80; i++) {
    const r = await exec(verify.GET, req(freshRaw, 'GET', '/api/v1/auth/verify'))
    if (r.status === 429) rate429Explicit += 1
  }
  record('RATE_EXPLICIT_60_ENFORCED', rate429Explicit > 0, `429=${rate429Explicit}`)

  // ── 7. LEGACY IDEMPOTENCY RECORD (pre-6.1, no __requestIdentity) ───────
  const legacyKey = `legacy-${Date.now()}`
  await prisma.idempotencyRecord.create({
    data: { key: `${bizA}:${legacyKey}`, businessId: bizA, response: { success: true, order: { id: 'legacy-synthetic-order' }, _note: 'pre-6.1 record' } as any, expiresAt: new Date(Date.now() + 86_400_000) },
  })
  const legacyReplay = await exec(orderPost.POST, req(keyA, 'POST', '/api/v1/esims/order', { packageId: pkgA, quantity: 1, customerName: 'X', customerEmail: 'x@y.io' }, legacyKey))
  record('LEGACY_RECORD_REPLAY_NOT_409', legacyReplay.status === 200 && legacyReplay.data?.order?.id === 'legacy-synthetic-order', `status=${legacyReplay.status} order=${legacyReplay.data?.order?.id}`)

  // ── 8. CROSS-TENANT SAME RAW KEY NAMESPACE ─────────────────────────────
  const sharedRawKey = `shared-${Date.now()}`
  const pA = await exec(orderPost.POST, req(keyA, 'POST', '/api/v1/esims/order', { packageId: pkgA, quantity: 2, customerName: 'A', customerEmail: 'a@x.io' }, sharedRawKey))
  const pB = await exec(orderPost.POST, req(keyB, 'POST', '/api/v1/esims/order', { packageId: pkgB, quantity: 1, customerName: 'B', customerEmail: 'b@x.io' }, sharedRawKey))
  const ordersA = await prisma.eSIMPurchase.count({ where: { providerPurchaseKey: `${bizA}:${sharedRawKey}` } })
  const ordersB = await prisma.eSIMPurchase.count({ where: { providerPurchaseKey: `${bizB}:${sharedRawKey}` } })
  record('CROSS_TENANT_SAME_KEY_INDEPENDENT', pA.status === 200 && pB.status === 200
    && pA.data?.order?.id !== pB.data?.order?.id && ordersA === 1 && ordersB === 1,
    `A=${ordersA} B=${ordersB} sameOrder=${pA.data?.order?.id === pB.data?.order?.id}`)

  const escapes = results.filter((r) => !r.pass && /TENANT/.test(r.name)).length
  const failed = results.filter((r) => !r.pass).map((r) => `${r.name}:${r.detail}`)
  console.log('CERT_RESULT=')
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}|${r.name}|${r.detail}`)
  console.log('TENANT_ESCAPE_COUNT=' + escapes)
  console.log('CERT_FAILURES=' + JSON.stringify(failed))
  console.log('CERT_VERDICT=' + (failed.length === 0 ? 'PASS' : 'PARTIAL'))
}

main().catch((e) => { console.error('CERT_RUN_ERROR=' + String((e && (e.stack || e.message)) || e)); process.exit(1) })