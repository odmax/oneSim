import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

console.log('=== Package Deletion Safety Regression Test ===\n')
let passed = 0
let failed = 0

try {
  // 1. Create test business
  const business = await prisma.business.create({
    data: { name: 'Test Biz', contactEmail: 'test@test.com', country: 'Test', status: 'APPROVED' },
  })
  console.log(`1. Created test business: ${business.id}`)

  // 2. Create test package
  const pkg = await prisma.eSIMPackage.create({
    data: { name: 'Test Package', dataGB: 1, validityDays: 7, priceUSD: 5, localPrice: 5, isActive: true, source: 'CATALOG_PRODUCT' },
  })
  console.log(`2. Created test package: ${pkg.id}`)

  // 3. Create test purchase + eSIM
  const user = await prisma.user.findFirst()
  if (!user) { console.log('SKIP: no user found'); process.exit(0) }

  const purchase = await prisma.eSIMPurchase.create({
    data: {
      businessId: business.id,
      userId: user.id,
      packageId: pkg.id,
      quantity: 1,
      totalAmount: 5,
      status: 'PENDING_ACTIVATION',
      packageName: 'Test Package',
      packageDataGB: 1,
      packageValidityDays: 7,
    },
  })
  console.log(`3. Created test purchase: ${purchase.id}`)

  const esim = await prisma.eSIM.create({
    data: {
      purchaseId: purchase.id,
      iccid: `TEST-${Date.now()}`,
      status: 'PENDING_ACTIVATION',
      packageName: 'Test Package',
      packageDataGB: 1,
      packageValidityDays: 7,
    },
  })
  console.log(`4. Created test eSIM: ${esim.id}`)

  // 5. Try to delete package — should archive, not delete
  try {
    await prisma.eSIMPackage.delete({ where: { id: pkg.id } })
    console.log(`5. FAIL: Package was hard-deleted! eSIM would be orphaned.`)
    failed++
  } catch (err) {
    console.log(`5. PASS: DB Restrict blocked hard delete: ${err.message}`)
    passed++
  }

  // 6. Archive via update (simulating the server action)
  await prisma.eSIMPackage.update({
    where: { id: pkg.id },
    data: { isActive: false, hiddenFromCatalog: true, archivedAt: new Date() },
  })
  console.log(`6. Archived package`)

  // 7. Verify eSIM still exists
  const stillThere = await prisma.eSIM.findUnique({ where: { id: esim.id } })
  if (stillThere) {
    console.log(`7. PASS: eSIM still exists after package archive`)
    passed++
  } else {
    console.log(`7. FAIL: eSIM was deleted!`)
    failed++
  }

  // 8. Verify purchase still exists
  const purchaseStill = await prisma.eSIMPurchase.findUnique({ where: { id: purchase.id } })
  if (purchaseStill) {
    console.log(`8. PASS: Purchase still exists after package archive`)
    passed++
  } else {
    console.log(`8. FAIL: Purchase was deleted!`)
    failed++
  }

  // 9. Verify package is hidden from catalog
  const archivedPkg = await prisma.eSIMPackage.findUnique({ where: { id: pkg.id } })
  if (archivedPkg && archivedPkg.hiddenFromCatalog && !archivedPkg.isActive) {
    console.log(`9. PASS: Package is hidden from catalog (isActive=${archivedPkg.isActive}, hiddenFromCatalog=${archivedPkg.hiddenFromCatalog})`)
    passed++
  } else {
    console.log(`9. FAIL: Package not properly archived`)
    failed++
  }

  // 10. Cleanup
  await prisma.eSIM.delete({ where: { id: esim.id } })
  await prisma.eSIMPurchase.delete({ where: { id: purchase.id } })
  await prisma.eSIMPackage.delete({ where: { id: pkg.id } })
  await prisma.business.delete({ where: { id: business.id } })
  console.log(`10. Cleaned up test data`)

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
} catch (e) { console.error(e); process.exit(1) }
finally { await prisma.$disconnect() }
