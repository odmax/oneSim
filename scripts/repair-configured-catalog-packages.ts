/**
 * Repair configured catalog packages that are missing active snapshots
 * or failing purchase readiness.
 *
 * Modes: --dry-run | --apply [--provider-code=xxx] [--package-id=xxx]
 */

import { prisma } from '../src/lib/prisma'
import { getPackagePurchaseReadiness } from '../src/lib/packages/purchase-readiness'
import { finalizeCatalogPackageConfiguration } from '../src/lib/pricing/configuration-finalizer'

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

  let readyCount = 0
  let repairableCount = 0
  let notRepairableCount = 0
  let repairedCount = 0
  let downgradedCount = 0
  let snapshotCreatedCount = 0

  for (const pp of packages) {
    const readiness = getPackagePurchaseReadiness({
      providerPkg: pp,
      provider: pp.provider,
    })

    if (readiness.ready) {
      readyCount++
      continue
    }

    // Determine if repairable: has cost data to work with
    const hasCost = Number(pp.costPrice || 0) > 0 || (pp.adminCostPrice ? Number(pp.adminCostPrice) > 0 : false)
    const hasSellPrice = Number(pp.sellingPrice || 0) > 0
    const isRepairable = hasCost && hasSellPrice

    if (isRepairable) {
      repairableCount++
      console.log(`  [REPAIRABLE] ${pp.name} (${pp.id.slice(-8)}): ${readiness.reasons.join('; ')}`)

      if (apply) {
        const result = await finalizeCatalogPackageConfiguration(pp.id, { reason: 'REPAIR' })
        if (result.success) {
          console.log(`    -> REPAIRED: snapshot=${result.snapshotId}, ready=${result.ready}`)
          repairedCount++
          if (result.snapshotCreated) snapshotCreatedCount++
        } else {
          console.log(`    -> FAILED at ${result.failedStage}: ${result.error}`)
          // Still might have gotten a snapshot even if readiness failed
          if (result.snapshotCreated) snapshotCreatedCount++
        }
      }
    } else {
      notRepairableCount++
      console.log(`  [NOT REPAIRABLE] ${pp.name} (${pp.id.slice(-8)}): ${readiness.reasons.join('; ')}`)

      if (apply) {
        // Downgrade: clear the false CONFIGURED state
        await prisma.providerPackage.update({
          where: { id: pp.id },
          data: { configurationStatus: 'UNCONFIGURED', publishStatus: 'DRAFT' },
        }).catch(() => {})
        console.log(`    -> DOWNGRADED to UNCONFIGURED/DRAFT (no pricing data to repair)`)
        downgradedCount++
      }
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
    console.log(`Downgraded:        ${downgradedCount}`)
  }
  console.log()
  console.log('After repair:')
  console.log(`  Remaining blocked: ${notRepairableCount - (apply ? downgradedCount : 0)}`)
  if (!repairableCount) {
    for (const pp of packages) {
      const r = getPackagePurchaseReadiness({ providerPkg: pp, provider: pp.provider })
      if (!r.ready) console.log(`    - ${pp.name}: ${r.reasons[0]}`)
    }
  }

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
