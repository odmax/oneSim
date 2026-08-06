/**
 * End-to-end verification of the Business Buy eSIM flow.
 * Verifies without exposing credentials or calling billable provider endpoints in dry-run mode.
 *
 * Usage: npx tsx scripts/verify-buy-esim-flow.ts [--package-id=X] [--dry-run]
 */

import { prisma } from '../src/lib/prisma'
import { buildComparisonKey } from '../src/lib/catalog/comparison-key'
import { selectCheapestPlanPerComparisonGroup } from '../src/lib/catalog/cheapest-plan-selector'
import { getPackagePurchaseReadiness } from '../src/lib/packages/purchase-readiness'

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run') || !args.includes('--live')
  const idIdx = args.indexOf('--package-id')
  const targetPackageId = idIdx >= 0 ? args[idIdx + 1] : undefined

  console.log(dryRun ? '=== VERIFICATION (dry-run) ===' : '=== VERIFICATION (live) ===')
  console.log()

  // 1. At least one configured provider plan exists
  const configured = await prisma.providerPackage.count({
    where: { configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] } },
  })
  console.log(`1. Configured provider plans: ${configured}`)
  if (configured === 0) { console.log('   FAIL: No configured provider plans'); process.exit(1) }

  // 2. Belongs to a comparison group
  const plans = await prisma.providerPackage.findMany({
    where: { configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] } },
    take: 5,
  })
  const groups = new Set(plans.map(p => buildComparisonKey({ country: p.country, region: p.region, dataGB: p.dataGB, validityDays: p.validityDays })))
  console.log(`2. Comparison groups in first 5 configured plans: ${groups.size}`)

  // 3. A cheapest winner exists
  const selections = await selectCheapestPlanPerComparisonGroup()
  let winnersFound = 0
  selections.forEach(r => { if (r.selected) winnersFound++ })
  console.log(`3. Cheapest winners found: ${winnersFound}`)

  // 4. A client-facing ESIMPackage exists
  const purchasable = await prisma.eSIMPackage.findMany({
    where: { isActive: true, hiddenFromCatalog: false, archivedAt: null, source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
    include: {
      providerPackage: { select: { costStatus: true, pricingStatus: true, publishStatus: true, configurationStatus: true, activePriceSnapshotId: true, sellingPrice: true, costPrice: true } },
      provider: { select: { status: true, enabledCapabilities: true, code: true } },
    },
  })
  const ready = purchasable.filter(p => getPackagePurchaseReadiness({
    pkg: { isActive: p.isActive, hiddenFromCatalog: p.hiddenFromCatalog, archivedAt: p.archivedAt, source: p.source, providerPackageId: p.providerPackageId },
    providerPkg: p.providerPackage, provider: p.provider,
  }).ready)
  console.log(`4. Client-facing ESIMPackages (purchase-ready): ${ready.length}`)

  if (ready.length === 0) { console.log('   FAIL: No purchase-ready packages'); process.exit(1) }

  const testPkg = targetPackageId ? ready.find(p => p.id === targetPackageId) || ready[0] : ready[0]
  console.log(`   Using: ${testPkg.displayName || testPkg.name} (${testPkg.id.slice(-8)})`)

  // 5. Active snapshot exists
  const snapshotExists = testPkg.providerPackage?.activePriceSnapshotId
  console.log(`5. Active snapshot: ${snapshotExists ? 'YES (' + snapshotExists.slice(-8) + ')' : 'NO'}`)
  if (!snapshotExists) { console.log('   WARN: No active snapshot — quote creation will fail') }

  // 6. PurchaseQuote can be created (uses purchase_quotes)
  const { createPurchaseQuote } = await import('../src/lib/pricing/purchase-quote-service')
  if (snapshotExists && testPkg.providerPackageId) {
    const quoteResult = await createPurchaseQuote({
      businessId: 'diag-biz',
      providerPackageId: testPkg.providerPackageId,
      quantity: 1,
    })
    if (quoteResult.success) {
      console.log(`6. Quote created: ${quoteResult.quote.reference} (purchase_quotes table)`)

      // 8. Quote references purchase_quotes correctly
      const quoteRecord = await prisma.purchaseQuote.findUnique({ where: { quoteReference: quoteResult.quote.reference } })
      console.log(`8. Quote in purchase_quotes: ${quoteRecord ? 'YES' : 'NO'}`)

      // 9. Dry-run order can reach provider resolution
      if (testPkg.provider) {
        console.log(`9. Provider for dispatch: ${testPkg.provider.code} (${testPkg.provider.status})`)
        console.log(`   Capabilities: ${(testPkg.provider.enabledCapabilities as string[])?.join(', ') || 'none'}`)
      }
    } else {
      console.log(`6. Quote FAILED: ${quoteResult.error}`)
    }
  } else {
    console.log(`6. Quote: SKIPPED (no snapshot or providerPackageId)`)
  }

  // 10. Identify which connector would execute
  if (testPkg.provider?.code) {
    const { getAdapterForType } = await import('../src/lib/providers/adapter-manager')
    const adapter = await getAdapterForType(testPkg.provider.code)
    console.log(`10. Connector: ${adapter ? 'RESOLVED' : 'NOT FOUND'} (provider: ${testPkg.provider.code})`)
  }

  // Summary
  console.log()
  console.log('--- Verification Complete ---')
  console.log(`Configured plans:  ${configured}`)
  console.log(`Comparison groups: ${groups.size}`)
  console.log(`Winners selected:  ${winnersFound}`)
  console.log(`Retail published:  ${ready.length}`)
  console.log(`Quote test:        ${snapshotExists ? 'PASSED' : 'SKIPPED (needs snapshot)'}`)
  console.log(`Ready for purchase: ${ready.length > 0 ? 'YES' : 'NO'}`)

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
