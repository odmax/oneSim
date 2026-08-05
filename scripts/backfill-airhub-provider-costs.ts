/**
 * Backfill AirHub provider packages with costSource/costStatus/pricingStatus.
 * Only applies when real provider cost evidence (costPrice > 0) exists.
 * Never overwrites ADMIN_OVERRIDE. Never invents cost.
 *
 * Modes: --dry-run | --apply [--batch-size=N] [--provider-id=xxx]
 */

import { prisma } from '../src/lib/prisma'

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const apply = args.includes('--apply')
  const batchSizeIdx = args.indexOf('--batch-size')
  const batchSize = batchSizeIdx >= 0 ? parseInt(args[batchSizeIdx + 1] || '100', 10) : 100
  const providerIdx = args.indexOf('--provider-id')
  const providerFilter = providerIdx >= 0 ? args[providerIdx + 1] : undefined

  if (!dryRun && !apply) { console.log('Usage: --dry-run | --apply [--batch-size=N] [--provider-id=xxx]'); process.exit(1) }

  console.log(dryRun ? '=== DRY RUN ===' : '=== APPLYING ===')

  const where: any = { costStatus: 'MISSING', costPrice: { gt: 0 } }
  if (providerFilter) where.providerId = providerFilter

  let totalFixed = 0, totalSkipped = 0, totalProcessed = 0

  // Process all eligible records in batches
  while (true) {
    const packages = await prisma.providerPackage.findMany({
      where,
      take: batchSize,
      select: { id: true, providerPlanId: true, costPrice: true, costSource: true, costStatus: true, pricingStatus: true },
    })

    if (packages.length === 0) break
    totalProcessed += packages.length

    let batchFixed = 0, batchSkipped = 0
    for (const pp of packages) {
      const rawCost = Number(pp.costPrice)
      if (!Number.isFinite(rawCost) || rawCost <= 0) { batchSkipped++; continue }
      if (pp.costSource === 'ADMIN_OVERRIDE') { batchSkipped++; continue }

      if (dryRun) {
        batchFixed++
        console.log(`  [DRY-RUN] ${pp.providerPlanId}: costSource→PROVIDER costStatus→VALID pricingStatus→READY`)
      } else {
        await prisma.providerPackage.update({
          where: { id: pp.id },
          data: { costSource: 'PROVIDER', costStatus: 'VALID', pricingStatus: 'READY' },
        })
        batchFixed++
      }
    }
    totalFixed += batchFixed
    totalSkipped += batchSkipped
    console.log(`  Batch: ${batchFixed} fixed, ${batchSkipped} skipped (${totalProcessed} processed so far)`)
  }

  console.log()
  console.log(`${dryRun ? 'DRY_RUN' : 'APPLY'} complete: ${totalFixed} fixed, ${totalSkipped} skipped, ${totalProcessed} total`)
  prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
