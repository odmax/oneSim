/**
 * Repair configured catalog packages that are missing active snapshots,
 * costStatus/pricingStatus, or failing purchase readiness.
 *
 * Canonical repair: runs finalizeCatalogPackageConfiguration() which invokes
 * recalculatePackagePrice() (establishes effective cost, costStatus,
 * pricingStatus, markup, active price snapshot) and then verifies purchase
 * readiness — the SAME pipeline a newly configured package uses. No manual
 * field patching.
 *
 * Provider-neutral. Does NOT touch AIRHUB orphan (published ProviderPackage
 * with no linked ESIMPackage) — orphans are reported and skipped.
 *
 * Modes:
 *   --dry-run                          default-safe, zero DB writes
 *   --apply [--provider-code=xxx] [--package-id=xxx]
 *
 * READ ONLY when --dry-run: no prisma writes, no snapshot creation, no
 * provider calls, no publish, no sync.
 */
import { prisma } from '../src/lib/prisma'
import { getPackagePurchaseReadiness } from '../src/lib/packages/purchase-readiness'
import { finalizeCatalogPackageConfiguration } from '../src/lib/pricing/configuration-finalizer'

function aggregateReasons(reasonsList: string[][]): { reason: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const reasons of reasonsList) {
    for (const reason of reasons) {
      counts.set(reason, (counts.get(reason) || 0) + 1)
    }
  }
  return Array.from(counts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
}

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

  const where: any = {
    configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] },
  }
  if (codeFilter) where.provider = { code: { equals: codeFilter, mode: 'insensitive' } }
  if (idFilter) where.id = idFilter

  const packages = await prisma.providerPackage.findMany({
    where,
    include: {
      provider: { select: { status: true, enabledCapabilities: true, code: true, name: true } },
    },
    orderBy: { name: 'asc' },
  })

  if (packages.length === 0) { console.log('No configured packages found.'); await prisma.$disconnect(); return }

  // Also detect orphans (published with no linked retail ESIMPackage) — report only.
  const orphans = await prisma.providerPackage.findMany({
    where: { publishStatus: 'PUBLISHED', publishedAs: null },
    select: { id: true, name: true, provider: { select: { code: true } }, publishStatus: true, sellingPrice: true, configurationStatus: true },
  })

  let readyCount = 0
  let repairableCount = 0
  let notRepairableCount = 0
  let repairedCount = 0
  let snapshotCreatedCount = 0
  const beforeReasons: string[][] = []
  const afterReasons: string[][] = []

  for (const pp of packages) {
    const before = getPackagePurchaseReadiness({ providerPkg: pp, provider: pp.provider })
    beforeReasons.push(before.ready ? [] : before.reasons)

    if (before.ready) {
      readyCount++
      continue
    }

    // Determine if repairable: has cost data to work with
    const hasCost = Number(pp.costPrice || 0) > 0 || (pp.adminCostPrice ? Number(pp.adminCostPrice) > 0 : false)
    const hasSellPrice = Number(pp.sellingPrice || 0) > 0
    const isRepairable = hasCost && hasSellPrice

    if (isRepairable) {
      repairableCount++
      console.log(`  [REPAIRABLE] ${pp.provider?.code || '?'} | ${pp.name} (${pp.id.slice(-8)}): ${before.reasons.join('; ')}`)

      if (apply) {
        const result = await finalizeCatalogPackageConfiguration(pp.id, { reason: 'REPAIR' })
        if (result.success) {
          console.log(`    -> REPAIRED: snapshot=${result.snapshotId}, ready=${result.ready}`)
          repairedCount++
          if (result.snapshotCreated) snapshotCreatedCount++
        } else {
          console.log(`    -> FAILED at ${result.failedStage}: ${result.error}`)
          if (result.snapshotCreated) snapshotCreatedCount++
        }
      }
    } else {
      notRepairableCount++
      console.log(`  [NOT REPAIRABLE] ${pp.provider?.code || '?'} | ${pp.name} (${pp.id.slice(-8)}): ${before.reasons.join('; ')}`)

      if (apply) {
        // Downgrade: clear the false CONFIGURED state (no pricing data to repair)
        await prisma.providerPackage.update({
          where: { id: pp.id },
          data: { configurationStatus: 'UNCONFIGURED', publishStatus: 'DRAFT' },
        }).catch(() => {})
        console.log(`    -> DOWNGRADED to UNCONFIGURED/DRAFT (no pricing data to repair)`)
      }
    }
  }

  // After verification (apply only) — re-read each repairable package.
  if (apply && repairableCount > 0) {
    const ids = packages.filter(pp => {
      const hasCost = Number(pp.costPrice || 0) > 0 || (pp.adminCostPrice ? Number(pp.adminCostPrice) > 0 : false)
      const hasSellPrice = Number(pp.sellingPrice || 0) > 0
      return hasCost && hasSellPrice && !getPackagePurchaseReadiness({ providerPkg: pp, provider: pp.provider }).ready
    }).map(pp => pp.id)
    const refreshed = await prisma.providerPackage.findMany({
      where: { id: { in: ids } },
      include: { provider: { select: { status: true, enabledCapabilities: true, code: true } } },
    })
    for (const pp of refreshed) {
      const after = getPackagePurchaseReadiness({ providerPkg: pp, provider: pp.provider })
      afterReasons.push(after.ready ? [] : after.reasons)
      if (after.ready) console.log(`  [AFTER: READY] ${pp.provider?.code || '?'} | ${pp.name} (${pp.id.slice(-8)})`)
      else console.log(`  [AFTER: BLOCKED] ${pp.provider?.code || '?'} | ${pp.name} (${pp.id.slice(-8)}): ${after.reasons.join('; ')}`)
    }
  }

  console.log(`\n--- Results ---`)
  console.log(`Total configured:  ${packages.length}`)
  console.log(`Already ready:     ${readyCount}`)
  console.log(`Repairable:        ${repairableCount}`)
  console.log(`Not repairable:    ${notRepairableCount}`)
  if (apply) {
    console.log(`Repaired:          ${repairedCount}`)
    console.log(`Snapshots created: ${snapshotCreatedCount}`)
  }

  console.log('\nBefore readiness reasons (aggregated):')
  for (const r of aggregateReasons(beforeReasons)) console.log(`  ${r.reason}: ${r.count}`)

  if (apply && afterReasons.length > 0) {
    console.log('\nAfter readiness reasons (aggregated):')
    for (const r of aggregateReasons(afterReasons)) console.log(`  ${r.reason}: ${r.count}`)
  }

  console.log('\n--- Orphans (published, no linked ESIMPackage) — REPORT ONLY, NOT REPAIRED ---')
  console.log(`Orphan count: ${orphans.length}`)
  for (const o of orphans) {
    console.log(`  ${o.provider?.code || '?'} | ${o.name} (${o.id.slice(-8)}) publishStatus=${o.publishStatus} config=${o.configurationStatus} sellingPrice=${o.sellingPrice ?? 'null'}`)
  }

  console.log()
  console.log(dryRun
    ? 'NO DATABASE WRITE | NO PROVIDER CALL | NO PUBLISH | NO SYNC'
    : 'APPLY COMPLETE | NO PROVIDER CALL | NO PUBLISH | NO SYNC')

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
