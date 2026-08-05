/**
 * Backfill AirHub provider packages with costSource/costStatus/pricingStatus.
 * Only applies when real provider cost evidence (costPrice > 0) exists.
 * Never overwrites ADMIN_OVERRIDE. Never invents cost.
 *
 * Modes: --dry-run | --apply [--batch-size=N] [--provider-id=xxx] [--plan-id=xxx]
 */

import { prisma } from '../src/lib/prisma'
import { Prisma } from '@prisma/client'

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const apply = args.includes('--apply')
  const batchSizeIdx = args.indexOf('--batch-size')
  const batchSize = batchSizeIdx >= 0 ? parseInt(args[batchSizeIdx + 1] || '100', 10) : 100
  const providerIdx = args.indexOf('--provider-id')
  const providerFilter = providerIdx >= 0 ? args[providerIdx + 1] : undefined
  const planIdx = args.indexOf('--plan-id')
  const planFilter = planIdx >= 0 ? args[planIdx + 1] : undefined

  if (!dryRun && !apply) { console.log('Usage: --dry-run | --apply [--batch-size=N] [--provider-id=xxx] [--plan-id=xxx]'); process.exit(1) }

  console.log(dryRun ? '=== DRY RUN ===' : '=== APPLYING ===')
  if (planFilter) console.log(`Targeted plan: ${planFilter}`)
  if (providerFilter) console.log(`Provider filter: ${providerFilter}`)

  const where: any = {
    costStatus: { in: ['MISSING', 'INVALID'] },
    costPrice: { gt: new Prisma.Decimal(0) },
    costSource: { not: 'ADMIN_OVERRIDE' },
  }
  if (providerFilter) where.providerId = providerFilter
  if (planFilter) where.providerPlanId = planFilter

  // Initial count
  const remaining = await prisma.providerPackage.count({ where })
  console.log(`Eligible rows: ${remaining}`)

  let totalFixed = 0, totalSkipped = 0, totalProcessed = 0

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
      if (dryRun) {
        batchFixed++
      } else {
        await prisma.providerPackage.update({
          where: { id: pp.id },
          data: { costSource: 'PROVIDER', costStatus: 'VALID', pricingStatus: 'READY' },
        }).catch(() => { batchSkipped++; return })
        batchFixed++
      }
    }
    totalFixed += batchFixed
    totalSkipped += batchSkipped
    console.log(`  Batch: ${batchFixed} fixed, ${batchSkipped} skipped (${totalProcessed}/${remaining} processed)`)
  }

  // Final verification
  const stillRemaining = await prisma.providerPackage.count({ where })
  console.log()
  console.log(`${dryRun ? 'DRY_RUN' : 'APPLY'} complete: ${totalFixed} fixed, ${totalSkipped} skipped, ${totalProcessed} total`)
  if (stillRemaining > 0) console.log(`Still eligible: ${stillRemaining}`)
  prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
