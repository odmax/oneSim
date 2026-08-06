/**
 * Repair published ProviderPackages that are missing valid linked ESIMPackages.
 *
 * Modes: --dry-run | --apply [--provider-code=xxx] [--provider-package-id=xxx]
 */

import { prisma } from '../src/lib/prisma'
import { getPackagePurchaseReadiness } from '../src/lib/packages/purchase-readiness'
import { publishProviderPackageToRetailCatalog } from '../src/lib/services/catalog/publish-to-retail'

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const apply = args.includes('--apply')
  const codeIdx = args.indexOf('--provider-code')
  const codeFilter = codeIdx >= 0 ? args[codeIdx + 1]?.toUpperCase() : undefined
  const idIdx = args.indexOf('--provider-package-id')
  const idFilter = idIdx >= 0 ? args[idIdx + 1] : undefined

  if (!dryRun && !apply) { console.log('Usage: --dry-run | --apply [--provider-code=xxx] [--provider-package-id=xxx]'); process.exit(1) }
  console.log(dryRun ? '=== DRY RUN ===' : '=== APPLYING ===')

  const where: any = { publishStatus: 'PUBLISHED' }
  if (codeFilter) where.provider = { code: { equals: codeFilter, mode: 'insensitive' } }
  if (idFilter) where.id = idFilter

  const published = await prisma.providerPackage.findMany({
    where,
    include: {
      provider: { select: { id: true, name: true, code: true, status: true, enabledCapabilities: true } },
      publishedAs: { select: { id: true, isActive: true, hiddenFromCatalog: true, archivedAt: true, source: true, providerPackageId: true } },
    },
    orderBy: { name: 'asc' },
  })

  let linkedRetail = 0
  let missingRetailLinks = 0
  let inactiveRetail = 0
  let hiddenRetail = 0
  let archivedRetail = 0
  let blockedByPricing = 0
  let blockedBySnapshot = 0
  let blockedByProvider = 0
  let repaired = 0
  let remainingBlocked = 0

  for (const pp of published) {
    const retail = pp.publishedAs
    const linked = retail && retail.providerPackageId === pp.id

    if (linked && retail.isActive && !retail.hiddenFromCatalog && !retail.archivedAt && (retail.source === 'CATALOG_PRODUCT' || retail.source === 'MANUAL')) {
      // Check readiness
      const r = getPackagePurchaseReadiness({
        pkg: { isActive: retail.isActive, hiddenFromCatalog: retail.hiddenFromCatalog, archivedAt: retail.archivedAt, source: retail.source, providerPackageId: retail.providerPackageId },
        providerPkg: { costStatus: pp.costStatus, pricingStatus: pp.pricingStatus, publishStatus: pp.publishStatus, configurationStatus: pp.configurationStatus, activePriceSnapshotId: pp.activePriceSnapshotId, sellingPrice: pp.sellingPrice, costPrice: pp.costPrice },
        provider: pp.provider,
      })
      if (r.ready) {
        linkedRetail++
        continue
      }
      for (const reason of r.reasons) {
        if (reason.includes('pricing') || reason.includes('cost')) blockedByPricing++
        else if (reason.includes('snapshot')) blockedBySnapshot++
        else if (reason.includes('Provider')) blockedByProvider++
      }
      console.log(`  [BLOCKED] ${pp.name}: ${r.reasons.join('; ')}`)
      remainingBlocked++
      continue
    }

    // Gap: no valid linked retail
    if (!linked) {
      missingRetailLinks++
      console.log(`  [NO LINK] ${pp.name}: ${retail ? 'links different package' : 'no ESIMPackage'}`)
    } else if (!retail.isActive) {
      inactiveRetail++
      console.log(`  [INACTIVE] ${pp.name}: retail package ${retail.id.slice(-8)} is inactive`)
    } else if (retail.hiddenFromCatalog) {
      hiddenRetail++
      console.log(`  [HIDDEN] ${pp.name}: retail package hidden`)
    } else if (retail.archivedAt) {
      archivedRetail++
      console.log(`  [ARCHIVED] ${pp.name}: retail package archived`)
    }

    // Repair via canonical service
    if (apply) {
      const result = await publishProviderPackageToRetailCatalog(pp.id, { reason: 'REPAIR' })
      if (result.success) {
        console.log(`    -> REPAIRED: retail=${result.retailPackageId}, created=${result.created}`)
        repaired++
      } else {
        console.log(`    -> FAILED at ${result.failedStage}: ${result.error}`)
        remainingBlocked++
      }
    } else {
      remainingBlocked++
    }
  }

  console.log(`\n--- Results ---`)
  console.log(`Published ProviderPackages: ${published.length}`)
  console.log(`Linked retail packages:     ${linkedRetail}`)
  console.log(`Missing retail links:       ${missingRetailLinks}`)
  console.log(`Inactive retail:            ${inactiveRetail}`)
  console.log(`Hidden retail:              ${hiddenRetail}`)
  console.log(`Archived retail:            ${archivedRetail}`)
  console.log(`Blocked by pricing:         ${blockedByPricing}`)
  console.log(`Blocked by snapshot:        ${blockedBySnapshot}`)
  console.log(`Blocked by provider:        ${blockedByProvider}`)
  if (apply) {
    console.log(`Repaired:                   ${repaired}`)
    console.log(`Remaining blocked:          ${remainingBlocked}`)
  }
  console.log(`Final client-visible:       ${linkedRetail + (apply ? repaired : 0)}`)

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
