/**
 * Backfill purchasable package readiness.
 * Reports which packages are ready and which are blocked, and why.
 *
 * Modes:
 *   --dry-run          Report only, no changes
 *   --apply            Create snapshots for packages that are ready except for missing snapshot
 *   --provider-code=X  Filter to one provider
 *   --package-id=X     Check a single package
 */

import { prisma } from '../src/lib/prisma'
import { getPackagePurchaseReadiness } from '../src/lib/packages/purchase-readiness'
import { recalculatePackagePrice } from '../src/lib/pricing/price-recalculation-service'

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const apply = args.includes('--apply')
  const codeIdx = args.indexOf('--provider-code')
  const codeFilter = codeIdx >= 0 ? args[codeIdx + 1]?.toUpperCase() : undefined
  const idIdx = args.indexOf('--package-id')
  const idFilter = idIdx >= 0 ? args[idIdx + 1] : undefined

  if (!dryRun && !apply) { console.log('Usage: --dry-run | --apply [--provider-code=xxx] [--package-id=xxx]'); process.exit(1) }
  console.log(dryRun ? '=== DRY RUN ===' : '=== APPLYING ===')

  const where: any = { isActive: true }
  if (idFilter) where.id = idFilter

  const packages = await prisma.eSIMPackage.findMany({
    where,
    include: {
      providerPackage: { select: { id: true, costStatus: true, pricingStatus: true, publishStatus: true, configurationStatus: true, activePriceSnapshotId: true, sellingPrice: true, costPrice: true } },
      provider: { select: { status: true, enabledCapabilities: true, code: true } },
    },
    orderBy: { displayName: 'asc' },
  })

  if (codeFilter) {
    const filtered = packages.filter(p => p.provider?.code?.toUpperCase() === codeFilter)
    console.log(`Filtered to ${codeFilter}: ${filtered.length} packages`)
    await processPackages(filtered, dryRun)
  } else {
    await processPackages(packages, dryRun)
  }

  await prisma.$disconnect()
}

async function processPackages(pkgs: any[], dryRun: boolean) {
  let totalReady = 0
  let blockedByCost = 0
  let blockedByPrice = 0
  let blockedBySnapshot = 0
  let blockedByProvider = 0
  let blockedByConfig = 0
  let snapshotsCreated = 0
  let becameReady = 0

  const snapshotCandidates: { retailPkg: any; providerPkgId: string; name: string }[] = []

  for (const p of pkgs) {
    const r = getPackagePurchaseReadiness({ pkg: p, providerPkg: p.providerPackage, provider: p.provider })

    if (r.ready) {
      totalReady++
      continue
    }

    // Classify blocking reasons
    for (const reason of r.reasons) {
      if (reason.includes('Cost')) blockedByCost++
      else if (reason.includes('selling price')) blockedByPrice++
      else if (reason.includes('snapshot')) blockedBySnapshot++
      else if (reason.includes('Provider') && !reason.includes('PURCHASE')) blockedByProvider++
      else if (reason.includes('Configuration') || reason.includes('published')) blockedByConfig++
    }

    // Snapshot candidate: blocked ONLY by missing snapshot, everything else is fine
    const snapshotOnly = r.reasons.length === 1 && r.reasons[0] === 'No active price snapshot'
    if (snapshotOnly && p.providerPackage?.id) {
      snapshotCandidates.push({ retailPkg: p, providerPkgId: p.providerPackage.id, name: p.displayName || p.name })
    }

    // Recalculation candidate: pricing is COST_UNAVAILABLE but has a cost and selling price to work with
    const pp = p.providerPackage
    const hasPricingData = pp && (
      (Number(pp.costPrice || 0) > 0) ||
      ((pp as any).adminCostPrice && Number((pp as any).adminCostPrice) > 0)
    )
    const hasSellingPriceData = pp && Number(pp.sellingPrice || 0) > 0
    const needsRecalculation = r.reasons.some(x => x.includes('Pricing status is') && x.includes('COST_UNAVAILABLE'))
    const canRecalculate = needsRecalculation && hasPricingData && hasSellingPriceData

    if (canRecalculate && pp?.id) {
      const alreadyCandidate = snapshotCandidates.find(s => s.providerPkgId === pp.id)
      if (!alreadyCandidate) {
        snapshotCandidates.push({ retailPkg: p, providerPkgId: pp.id, name: p.displayName || p.name })
      }
    }

    if (!r.ready) {
      console.log(`  ${p.displayName || p.name} (${p.id.slice(-8)}): ${r.reasons.join('; ')}`)
    }
  }

  // Create snapshots
  if (!dryRun && snapshotCandidates.length > 0) {
    console.log(`\nCreating snapshots for ${snapshotCandidates.length} packages with missing snapshots...`)
    for (const c of snapshotCandidates) {
      console.log(`  ${c.name}: recalculating...`)
      const result = await recalculatePackagePrice(c.providerPkgId, 'BACKFILL')
      if (result.success && result.priceSnapshotId) {
        console.log(`    -> snapshot created: ${result.priceSnapshotId}`)
        snapshotsCreated++
      } else {
        console.log(`    -> FAILED: ${result.reason}`)
      }

      // Re-check readiness after snapshot
      const updatedPp = await prisma.providerPackage.findUnique({
        where: { id: c.providerPkgId },
        select: { costStatus: true, pricingStatus: true, publishStatus: true, configurationStatus: true, activePriceSnapshotId: true, sellingPrice: true, costPrice: true },
      })
      const recheck = getPackagePurchaseReadiness({ pkg: c.retailPkg, providerPkg: updatedPp, provider: c.retailPkg.provider })
      if (recheck.ready) becameReady++
    }
  }

  console.log(`\n--- Results ---`)
  console.log(`Total inspected:   ${pkgs.length}`)
  console.log(`Ready before:      ${totalReady}`)
  if (!dryRun) {
    console.log(`Snapshots created: ${snapshotsCreated}`)
    console.log(`Became ready:      ${becameReady}`)
  }
  console.log(`Blocked by cost:   ${blockedByCost}`)
  console.log(`Blocked by price:  ${blockedByPrice}`)
  console.log(`Blocked by snap:   ${blockedBySnapshot}`)
  console.log(`Blocked by prov:   ${blockedByProvider}`)
  console.log(`Blocked by config: ${blockedByConfig}`)
}

main().catch(e => { console.error(e); process.exit(1) })
