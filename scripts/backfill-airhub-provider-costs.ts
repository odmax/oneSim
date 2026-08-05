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

  const packages = await prisma.providerPackage.findMany({
    where,
    take: batchSize,
    select: { id: true, providerPlanId: true, costPrice: true, costSource: true, costStatus: true, pricingStatus: true },
  })

  console.log(`Found ${packages.length} packages with costPrice > 0 but missing costStatus`)

  let fixed = 0, skipped = 0
  for (const pp of packages) {
    const rawCost = Number(pp.costPrice)
    if (!Number.isFinite(rawCost) || rawCost <= 0) { skipped++; continue }
    if (pp.costSource === 'ADMIN_OVERRIDE') { skipped++; continue }

    if (dryRun) {
      fixed++
      console.log(`  [DRY-RUN] ${pp.providerPlanId}: costSource→PROVIDER costStatus→VALID`)
    } else {
      await prisma.providerPackage.update({
        where: { id: pp.id },
        data: { costSource: 'PROVIDER', costStatus: 'VALID', pricingStatus: 'READY' },
      })
      fixed++
    }
  }

  console.log(`${dryRun ? 'DRY_RUN' : 'APPLY'} complete: ${fixed} fixed, ${skipped} skipped`)
  prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
