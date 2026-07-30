/**
 * Phase 3 Pricing Backfill
 *
 * Usage:
 *   npx tsx scripts/backfill-pricing-phase-3.ts --dry-run
 *   npx tsx scripts/backfill-pricing-phase-3.ts --apply
 *   npx tsx scripts/backfill-pricing-phase-3.ts --apply --batch-size=50 --provider=CHOICE
 */

import { PrismaClient } from '@prisma/client'
import { recalculatePackagePrice } from '../src/lib/pricing/price-recalculation-service'

const prisma = new PrismaClient()
const BATCH = parseInt(process.env.BATCH_SIZE || '100')

const args = process.argv.slice(2)
const isDryRun = args.includes('--dry-run')
const isApply = args.includes('--apply')
if (!isDryRun && !isApply) { console.log('Usage: --dry-run | --apply [--batch-size=N] [--provider=CODE] [--package-id=ID]'); process.exit(1) }

const providerFilter = args.find(a => a.startsWith('--provider='))?.split('=')[1]
const pkgFilter = args.find(a => a.startsWith('--package-id='))?.split('=')[1]

interface Stats { scanned: number; ready: number; costUnavailable: number; exchangeRateMissing: number; marginBelow: number; calcFailed: number; skipped: number; snapshotsCreated: number; errors: number }

async function main() {
  const stats: Stats = { scanned: 0, ready: 0, costUnavailable: 0, exchangeRateMissing: 0, marginBelow: 0, calcFailed: 0, skipped: 0, snapshotsCreated: 0, errors: 0 }
  const where: any = { isAvailable: true }
  if (providerFilter) where.providerId = providerFilter
  if (pkgFilter) where.id = pkgFilter

  console.log(`\nPhase 3 Pricing Backfill — ${isDryRun ? 'DRY RUN' : 'APPLY'}\n`)

  let cursor: string | undefined
  let batch = 0
  while (true) {
    batch++
    const pkgs = await prisma.providerPackage.findMany({
      where, take: BATCH, orderBy: { id: 'asc' },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, name: true, pricingStatus: true, currency: true },
    })
    if (!pkgs.length) break
    cursor = pkgs[pkgs.length - 1].id
    stats.scanned += pkgs.length

    for (const pkg of pkgs) {
      try {
        if (pkg.pricingStatus === 'DISABLED') { stats.skipped++; continue }
        if (!isDryRun) {
          const result = await recalculatePackagePrice(pkg.id, 'BACKFILL')
          if (result.success) { stats.ready++ } else {
            if (result.pricingStatus === 'COST_UNAVAILABLE') stats.costUnavailable++
            else if (result.pricingStatus === 'EXCHANGE_RATE_MISSING') stats.exchangeRateMissing++
            else if (result.pricingStatus === 'MARGIN_BELOW_MINIMUM') stats.marginBelow++
            else if (result.pricingStatus === 'CALCULATION_FAILED') stats.calcFailed++
          }
        } else {
          stats.ready++ // dry-run predicts
        }
      } catch (e: any) { stats.errors++; if (stats.errors <= 3) console.error(`  Error: ${e.message}`) }
    }
    console.log(`  Batch ${batch}: ${pkgs.length} packages (total: ${stats.scanned})`)
  }

  console.log(`\n─── ${isDryRun ? 'DRY RUN' : 'APPLY'} Results ───`)
  console.log(`  Scanned:             ${stats.scanned}`)
  console.log(`  READY:               ${stats.ready}`)
  console.log(`  COST_UNAVAILABLE:    ${stats.costUnavailable}`)
  console.log(`  EXCHANGE_RATE_MISSING: ${stats.exchangeRateMissing}`)
  console.log(`  MARGIN_BELOW_MINIMUM:  ${stats.marginBelow}`)
  console.log(`  CALCULATION_FAILED:  ${stats.calcFailed}`)
  console.log(`  Skipped:             ${stats.skipped}`)
  console.log(`  Errors:              ${stats.errors}`)
  if (isDryRun) console.log('\n  ⚠ Dry run. Run with --apply to persist.\n')
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
