import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

if (!process.env.ALLOW_PRODUCTION_SMOKE_TEST && process.env.NODE_ENV === 'production') {
  console.error('Refusing to run smoke test in production. Set ALLOW_PRODUCTION_SMOKE_TEST=true to override.')
  process.exit(1)
}

let passed = 0
let failed = 0
let errors = []

async function assert(label, fn) {
  try { await fn(); passed++; console.log(`  OK ${label}`) }
  catch (e) { failed++; errors.push(`${label}: ${e.message || e}`); console.log(`  FAIL ${label}: ${e.message || e}`) }
}

async function smoke() {
  console.log('\n=== CRUD Smoke Tests ===\n')

  const user = await prisma.user.findFirst({ where: { role: 'INTERNAL_ADMIN' } })
  if (!user) { console.log('SKIP: no admin user found'); process.exit(1) }

  let testBizId = ''
  let testUserId = ''
  let testPkgId = ''
  let testPurchaseId = ''
  let testEsimId = ''
  let testApiKeyId = ''
  let testWebhookId = ''
  let testCustomerId = ''

  // CREATE Business
  await assert('Create Business', async () => {
    const biz = await prisma.business.create({ data: { name: `TestBiz-${Date.now()}`, contactEmail: `test${Date.now()}@test.com`, country: 'Test', status: 'APPROVED' } })
    testBizId = biz.id
    if (!biz.id) throw new Error('No business id returned')
  })

  // CREATE Business Admin User
  await assert('Create Business Admin User', async () => {
    const u = await prisma.user.create({ data: { email: `admin${Date.now()}@test.com`, name: 'Test Admin', role: 'BUSINESS_USER', isActive: true, passwordHash: '$2a$10$test' } })
    testUserId = u.id
    await prisma.businessUser.create({ data: { userId: u.id, businessId: testBizId, role: 'ADMIN' } })
  })

  // READ Business
  await assert('Read Business', async () => {
    const biz = await prisma.business.findUnique({ where: { id: testBizId } })
    if (!biz) throw new Error('Business not found')
  })

  // UPDATE Business
  await assert('Update Business Name', async () => {
    await prisma.business.update({ where: { id: testBizId }, data: { name: 'UpdatedTestBiz' } })
    const biz = await prisma.business.findUnique({ where: { id: testBizId } })
    if (!biz || biz.name !== 'UpdatedTestBiz') throw new Error('Name not updated')
  })

  // CREATE Customer
  await assert('Create Customer', async () => {
    const c = await prisma.customer.create({ data: { businessId: testBizId, name: 'Test Customer', email: `cust${Date.now()}@test.com`, country: 'Test' } })
    testCustomerId = c.id
  })

  // CREATE Package
  await assert('Create Package', async () => {
    const pkg = await prisma.eSIMPackage.create({ data: { name: 'Test Package', dataGB: 1, validityDays: 7, priceUSD: 5, localPrice: 5, isActive: true, source: 'CATALOG_PRODUCT' } })
    testPkgId = pkg.id
  })

  // CREATE API Key
  await assert('Create API Key', async () => {
    const key = await prisma.businessApiKey.create({ data: { businessId: testBizId, name: 'Test Key', keyHash: `hash${Date.now()}`, keyPrefix: 'test', status: 'ACTIVE' } })
    testApiKeyId = key.id
  })

  // CREATE Webhook Endpoint
  await assert('Create Webhook Endpoint', async () => {
    const wh = await prisma.businessWebhookEndpoint.create({ data: { businessId: testBizId, name: 'Test Webhook', url: 'https://example.com/hook', secret: 'testsecret', events: ['*'], status: 'ACTIVE' } })
    testWebhookId = wh.id
  })

  // READ Webhook Endpoints
  await assert('Read Webhook Endpoints', async () => {
    const hooks = await prisma.businessWebhookEndpoint.findMany({ where: { businessId: testBizId } })
    if (hooks.length === 0) throw new Error('No webhooks found')
  })

  // Allocate Wallet Credit
  await assert('Allocate Wallet Credit', async () => {
    await prisma.business.update({ where: { id: testBizId }, data: { walletBalance: { increment: 100 } } })
    await prisma.walletTransaction.create({ data: { businessId: testBizId, amount: 100, type: 'TOPUP', description: 'Test credit' } })
    const biz = await prisma.business.findUnique({ where: { id: testBizId } })
    if (!biz || parseFloat(biz.walletBalance.toString()) < 100) throw new Error('Wallet not credited')
  })

  // CREATE Purchase + ESIM
  await assert('Create Purchase + ESIM', async () => {
    const purchase = await prisma.eSIMPurchase.create({ data: { businessId: testBizId, userId: user.id, packageId: testPkgId, quantity: 1, totalAmount: 5, status: 'PENDING_ACTIVATION', packageName: 'Test Package', packageDataGB: 1, packageValidityDays: 7 } })
    testPurchaseId = purchase.id
    const esim = await prisma.eSIM.create({ data: { purchaseId: purchase.id, iccid: `TEST-${Date.now()}`, status: 'PENDING_ACTIVATION', packageName: 'Test Package', packageDataGB: 1, packageValidityDays: 7 } })
    testEsimId = esim.id
  })

  // READ ESIM
  await assert('Read ESIM', async () => {
    const esim = await prisma.eSIM.findUnique({ where: { id: testEsimId } })
    if (!esim) throw new Error('ESIM not found')
  })

  // Assign ESIM to Customer
  await assert('Assign ESIM to Customer', async () => {
    await prisma.eSIM.update({ where: { id: testEsimId }, data: { customerId: testCustomerId } })
    const esim = await prisma.eSIM.findUnique({ where: { id: testEsimId } })
    if (esim?.customerId !== testCustomerId) throw new Error('ESIM not assigned')
  })

  // Unassign ESIM
  await assert('Unassign ESIM', async () => {
    await prisma.eSIM.update({ where: { id: testEsimId }, data: { customerId: null } })
    const esim = await prisma.eSIM.findUnique({ where: { id: testEsimId } })
    if (esim && esim.customerId) throw new Error('ESIM not unassigned')
  })

  // Package Delete Prevention (archive instead)
  await assert('Package with purchases: archive instead of delete', async () => {
    try {
      await prisma.eSIMPackage.delete({ where: { id: testPkgId } })
      throw new Error('Package was hard-deleted!')
    } catch (e) {
      if (!e.message || !e.message.toUpperCase().includes('RESTRICT')) throw e
    }
    await prisma.eSIMPackage.update({ where: { id: testPkgId }, data: { isActive: false, hiddenFromCatalog: true, archivedAt: new Date() } })
    const archived = await prisma.eSIMPackage.findUnique({ where: { id: testPkgId } })
    if (!archived || !archived.hiddenFromCatalog) throw new Error('Package not archived')
  })

  // Verify ESIM survives package archive
  await assert('ESIM survives package archive', async () => {
    const esim = await prisma.eSIM.findUnique({ where: { id: testEsimId } })
    if (!esim) throw new Error('ESIM was deleted!')
  })

  // Verify Purchase survives
  await assert('Purchase survives package archive', async () => {
    const purchase = await prisma.eSIMPurchase.findUnique({ where: { id: testPurchaseId } })
    if (!purchase) throw new Error('Purchase was deleted!')
  })

  // Cleanup test data
  console.log('\n--- Cleaning up test data ---')
  await prisma.eSIM.deleteMany({ where: { purchase: { businessId: testBizId } } }).catch(() => {})
  await prisma.eSIMPurchase.deleteMany({ where: { businessId: testBizId } }).catch(() => {})
  await prisma.walletTransaction.deleteMany({ where: { businessId: testBizId } }).catch(() => {})
  await prisma.businessWebhookEndpoint.deleteMany({ where: { businessId: testBizId } }).catch(() => {})
  await prisma.businessApiKey.deleteMany({ where: { businessId: testBizId } }).catch(() => {})
  await prisma.customer.deleteMany({ where: { businessId: testBizId } }).catch(() => {})
  await prisma.businessUser.deleteMany({ where: { businessId: testBizId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { email: { contains: 'test' } } }).catch(() => {})
  await prisma.eSIMPackage.deleteMany({ where: { name: { contains: 'Test' } } }).catch(() => {})
  await prisma.business.deleteMany({ where: { name: { contains: 'Test' } } }).catch(() => {})

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
  if (errors.length > 0) { console.log('\nErrors:'), errors.forEach(e => console.log(`  - ${e}`)) }
  process.exit(failed > 0 ? 1 : 0)
}

smoke().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
