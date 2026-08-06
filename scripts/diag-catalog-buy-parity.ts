/**
 * Catalog-Buy Parity Diagnostic
 * Shows exactly why published provider packages are/aren't visible on the Buy page.
 *
 * Usage: npx tsx scripts/diag-catalog-buy-parity.ts
 */

import { prisma } from '../src/lib/prisma'
import { getPackagePurchaseReadiness } from '../src/lib/packages/purchase-readiness'

async function main() {
  // 1. All published provider packages (what Admin counts)
  const publishedProviderPkgs = await prisma.providerPackage.findMany({
    where: { publishStatus: 'PUBLISHED' },
    include: {
      provider: { select: { id: true, name: true, code: true, status: true, enabledCapabilities: true } },
      publishedAs: { select: { id: true, displayName: true, name: true, isActive: true, hiddenFromCatalog: true, archivedAt: true, source: true, providerPackageId: true } },
    },
    orderBy: { name: 'asc' },
  })

  console.log(`Admin Product Catalog published ProviderPackages: ${publishedProviderPkgs.length}`)
  console.log()

  // 2. All eSIMPackages (retail) - what Buy page counts from
  const allRetailPkgs = await prisma.eSIMPackage.findMany({
    where: { isActive: true, source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
    include: {
      providerPackage: { select: { publishStatus: true, costStatus: true, pricingStatus: true, configurationStatus: true, activePriceSnapshotId: true, sellingPrice: true, costPrice: true } },
      provider: { select: { status: true, enabledCapabilities: true, code: true } },
    },
    orderBy: { displayName: 'asc' },
  })

  // 3. Purchasable — ready retail
  const purchasable = allRetailPkgs.filter(pkg => {
    const r = getPackagePurchaseReadiness({
      pkg: { isActive: pkg.isActive, hiddenFromCatalog: pkg.hiddenFromCatalog, archivedAt: pkg.archivedAt, source: pkg.source, providerPackageId: pkg.providerPackageId },
      providerPkg: pkg.providerPackage,
      provider: pkg.provider,
    })
    return r.ready
  })

  console.log(`Total retail eSIMPackages (active, catalog/manual): ${allRetailPkgs.length}`)
  console.log(`Purchasable (ready for Buy page): ${purchasable.length}`)
  console.log()

  // 4. Per-package audit
  const reasons: Record<string, number> = {}

  for (const pp of publishedProviderPkgs) {
    const retail = pp.publishedAs
    const hasRetail = !!retail
    const retailLinked = retail?.providerPackageId === pp.id

    let visibleOnBuyPage = false
    const exclusionReasons: string[] = []

    if (!hasRetail) {
      exclusionReasons.push('no linked ESIMPackage (not published to retail catalog)')
    } else if (!retailLinked) {
      exclusionReasons.push('retail package links different provider package')
    } else if (!retail.isActive) {
      exclusionReasons.push('retail package inactive')
    } else if (retail.hiddenFromCatalog) {
      exclusionReasons.push('retail hiddenFromCatalog')
    } else if (retail.archivedAt) {
      exclusionReasons.push('retail archived')
    } else if (retail.source !== 'CATALOG_PRODUCT' && retail.source !== 'MANUAL') {
      exclusionReasons.push(`retail source=${retail.source}`)
    } else {
      // Now check readiness
      const r = getPackagePurchaseReadiness({
        pkg: { isActive: retail.isActive, hiddenFromCatalog: retail.hiddenFromCatalog, archivedAt: retail.archivedAt, source: retail.source, providerPackageId: retail.providerPackageId },
        providerPkg: { costStatus: pp.costStatus, pricingStatus: pp.pricingStatus, publishStatus: pp.publishStatus, configurationStatus: pp.configurationStatus, activePriceSnapshotId: pp.activePriceSnapshotId, sellingPrice: pp.sellingPrice, costPrice: pp.costPrice },
        provider: pp.provider ? { status: pp.provider.status, enabledCapabilities: pp.provider.enabledCapabilities, code: pp.provider.code } : null,
      })
      if (r.ready) {
        visibleOnBuyPage = true
      } else {
        exclusionReasons.push(...r.reasons)
      }
    }

    if (!visibleOnBuyPage) {
      console.log(`${pp.name} (pp:${pp.id.slice(-8)}): ${exclusionReasons.join('; ')}`)
      for (const reason of exclusionReasons) {
        reasons[reason] = (reasons[reason] || 0) + 1
      }
    }
  }

  // 5. Summary
  const visibleCount = publishedProviderPkgs.filter(pp => {
    const retail = pp.publishedAs
    if (!retail?.isActive || retail.hiddenFromCatalog || retail.archivedAt) return false
    if (retail.source !== 'CATALOG_PRODUCT' && retail.source !== 'MANUAL') return false
    const r = getPackagePurchaseReadiness({
      pkg: { isActive: retail.isActive, hiddenFromCatalog: retail.hiddenFromCatalog, archivedAt: retail.archivedAt, source: retail.source, providerPackageId: retail.providerPackageId },
      providerPkg: { costStatus: pp.costStatus, pricingStatus: pp.pricingStatus, publishStatus: pp.publishStatus, configurationStatus: pp.configurationStatus, activePriceSnapshotId: pp.activePriceSnapshotId, sellingPrice: pp.sellingPrice, costPrice: pp.costPrice },
      provider: pp.provider ? { status: pp.provider.status, enabledCapabilities: pp.provider.enabledCapabilities, code: pp.provider.code } : null,
    })
    return r.ready
  }).length

  console.log()
  console.log(`--- Summary ---`)
  console.log(`Admin published:            ${publishedProviderPkgs.length}`)
  console.log(`Visible on Buy page:        ${visibleCount}`)
  console.log(`Missing from Buy page:      ${publishedProviderPkgs.length - visibleCount}`)
  console.log()
  console.log(`--- Exclusion Reasons ---`)
  for (const [reason, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}: ${reason}`)
  }
  console.log()
  console.log(`--- Entity Counts ---`)
  console.log(`Admin count source:         ProviderPackage.publishStatus = 'PUBLISHED'`)
  console.log(`Buy page count source:      ESIMPackage (active, source IN ('CATALOG_PRODUCT','MANUAL')) filtered by getPackagePurchaseReadiness`)
  console.log(`Entity mismatch present:    YES — Admin counts ProviderPackage, Buy page counts ESIMPackage`)

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
