import { PrismaClient, Prisma } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  console.log('=== Backfilling package snapshots ===\n')

  // Backfill purchases
  const purchases = await prisma.eSIMPurchase.findMany({
    where: { packageSnapshot: { equals: Prisma.DbNull } },
    include: { package: true },
  })
  console.log(`Found ${purchases.length} purchases without snapshots`)

  for (const purchase of purchases) {
    const pkg = purchase.package
    if (!pkg) {
      console.log(`  SKIP purchase ${purchase.id}: no related package`)
      continue
    }

    const unitPrice = parseFloat(pkg.priceUSD.toString())
    const snapshot = {
      packageId: pkg.id,
      sku: pkg.sku,
      packageCode: pkg.packageCode,
      displayName: pkg.displayName || pkg.name,
      customerDescription: pkg.customerDescription || null,
      dataGB: pkg.dataGB,
      validityDays: pkg.validityDays,
      priceUSD: unitPrice,
      localPrice: parseFloat(pkg.localPrice.toString()),
      currency: pkg.currency || 'USD',
      source: pkg.source,
      providerId: pkg.providerId,
      providerPlanId: pkg.providerPlanId || null,
      providerName: pkg.providerName || null,
      purchasedAt: purchase.createdAt.toISOString(),
    }

    await prisma.eSIMPurchase.update({
      where: { id: purchase.id },
      data: {
        packageSnapshot: snapshot as any,
        packageName: pkg.displayName || pkg.name,
        packageDataGB: pkg.dataGB,
        packageValidityDays: pkg.validityDays,
        packageUnitPrice: unitPrice,
        packageCurrency: pkg.currency || 'USD',
      },
    })
    console.log(`  OK purchase ${purchase.id}: ${snapshot.displayName}`)
  }

  // Backfill ESIMs
  const esims = await prisma.eSIM.findMany({
    where: { packageSnapshot: { equals: Prisma.DbNull } },
    include: { purchase: { include: { package: true } } },
  })
  console.log(`\nFound ${esims.length} eSIMs without snapshots`)

  for (const esim of esims) {
    const pkg = esim.purchase?.package
    if (!pkg) {
      console.log(`  SKIP esim ${esim.id}: no related purchase/package`)
      continue
    }

    const unitPrice = parseFloat(pkg.priceUSD.toString())
    const displayName = esim.purchase.packageName || pkg.displayName || pkg.name
    const snapshot = {
      packageId: pkg.id,
      sku: pkg.sku,
      packageCode: pkg.packageCode,
      displayName,
      customerDescription: pkg.customerDescription || null,
      dataGB: pkg.dataGB,
      validityDays: pkg.validityDays,
      priceUSD: unitPrice,
      localPrice: parseFloat(pkg.localPrice.toString()),
      currency: pkg.currency || 'USD',
      source: pkg.source,
      providerId: pkg.providerId,
      providerPlanId: pkg.providerPlanId || null,
      providerName: pkg.providerName || null,
      purchasedAt: esim.createdAt.toISOString(),
    }

    await prisma.eSIM.update({
      where: { id: esim.id },
      data: {
        packageSnapshot: snapshot as any,
        packageName: displayName,
        packageDataGB: pkg.dataGB,
        packageValidityDays: pkg.validityDays,
      },
    })
    console.log(`  OK esim ${esim.id}: ${displayName}`)
  }

  console.log('\n=== Backfill complete ===')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())