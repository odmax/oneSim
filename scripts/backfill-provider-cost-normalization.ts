/**
 * Provider Cost Normalization Backfill — Phase 5C
 *
 * Usage:
 *   npx tsx scripts/backfill-provider-cost-normalization.ts --dry-run
 *   npx tsx scripts/backfill-provider-cost-normalization.ts --apply
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const BATCH_SIZE = 100
const isDryRun = process.argv.includes('--dry-run')
const isApply = process.argv.includes('--apply')

if (!isDryRun && !isApply) {
  console.log('Usage: npx tsx scripts/backfill-provider-cost-normalization.ts --dry-run | --apply')
  process.exit(1)
}

interface Stats {
  total: number
  overridden: number
  valid: number
  missing: number
  invalid: number
  ready: number
  costUnavailable: number
  snapshotsCreated: number
  skipped: number
  errors: number
}

async function main() {
  const stats: Stats = { total: 0, overridden: 0, valid: 0, missing: 0, invalid: 0, ready: 0, costUnavailable: 0, snapshotsCreated: 0, skipped: 0, errors: 0 }
  const mode = isDryRun ? 'DRY RUN' : 'APPLY'
  console.log(`\nProvider Cost Normalization Backfill — ${mode}\n`)

  let cursor: string | undefined
  let batch = 0

  while (true) {
    batch++
    const packages = await prisma.providerPackage.findMany({
      where: { isAvailable: true },
      select: {
        id: true, name: true, costPrice: true, currency: true,
        adminCostPrice: true, effectiveCostPrice: true, costSource: true,
        costStatus: true, pricingStatus: true, sellingPrice: true,
        configurationStatus: true,
      },
      take: BATCH_SIZE,
      skip: cursor ? 1 : 0,
      ...(cursor ? { cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    })

    if (packages.length === 0) break
    cursor = packages[packages.length - 1].id
    stats.total += packages.length

    for (const pkg of packages) {
      try {
        const adminCost = pkg.adminCostPrice ? Number(pkg.adminCostPrice) : 0
        const effectiveCost = pkg.effectiveCostPrice ? Number(pkg.effectiveCostPrice) : 0
        const rawCost = Number(pkg.costPrice)
        const currency = pkg.currency || 'USD'
        const hasSellingPrice = pkg.sellingPrice ? Number(pkg.sellingPrice) > 0 : false

        let newCostStatus: string
        let newPricingStatus: string
        let newCostSource = pkg.costSource || null
        let newEffectiveCost = effectiveCost || null

        // Priority 1: Admin override
        if (adminCost > 0) {
          newCostStatus = 'OVERRIDDEN'
          newPricingStatus = hasSellingPrice ? 'READY' : 'COST_UNAVAILABLE'
          newCostSource = 'ADMIN_OVERRIDE'
          newEffectiveCost = adminCost
          stats.overridden++
        }
        // Priority 2: Effective cost exists
        else if (effectiveCost > 0) {
          newCostStatus = 'VALID'
          newPricingStatus = hasSellingPrice ? 'READY' : 'COST_UNAVAILABLE'
          stats.valid++
        }
        // Priority 3: Raw provider cost exists
        else if (rawCost > 0) {
          newCostStatus = 'VALID'
          newPricingStatus = hasSellingPrice ? 'READY' : 'COST_UNAVAILABLE'
          if (!newCostSource) newCostSource = 'PROVIDER'
          newEffectiveCost = rawCost
          stats.valid++
        }
        // Priority 4: Missing/invalid
        else {
          newCostStatus = rawCost < 0 ? 'INVALID' : 'MISSING'
          newPricingStatus = 'COST_UNAVAILABLE'
          newEffectiveCost = null
          if (rawCost < 0) stats.invalid++
          else stats.missing++
        }

        if (newPricingStatus === 'READY') stats.ready++
        else if (newPricingStatus === 'COST_UNAVAILABLE') stats.costUnavailable++

        if (!isDryRun) {
          await prisma.providerPackage.update({
            where: { id: pkg.id },
            data: {
              costStatus: newCostStatus,
              pricingStatus: newPricingStatus,
              costSource: newCostSource,
              effectiveCostPrice: newEffectiveCost,
              costReceivedAt: newCostStatus === 'VALID' ? (pkg as any).createdAt || new Date() : undefined,
            },
          })

          // Create snapshot for valid records
          if (newCostStatus === 'VALID' || newCostStatus === 'OVERRIDDEN') {
            const existingSnap = await prisma.providerCostSnapshot.findFirst({
              where: { providerPackageId: pkg.id },
              orderBy: { createdAt: 'desc' },
              take: 1,
            })
            if (!existingSnap) {
              await prisma.providerCostSnapshot.create({
                data: {
                  providerPackageId: pkg.id,
                  originalAmount: rawCost,
                  originalCurrency: currency,
                  normalizedAmount: newEffectiveCost || rawCost,
                  normalizedCurrency: currency,
                  costSource: newCostSource || 'PROVIDER_COST',
                  isTaxInclusive: false,
                  receivedAt: new Date(),
                },
              })
              stats.snapshotsCreated++
            }
          }
        }
      } catch (e: any) {
        stats.errors++
        if (stats.errors <= 5) console.error(`  Error: ${e.message}`)
      }
    }

    console.log(`  Batch ${batch}: processed ${packages.length} packages (total: ${stats.total})`)
  }

  console.log(`\n─── ${mode} Results ───`)
  console.log(`  Total scanned:     ${stats.total}`)
  console.log(`  OVERRIDDEN:        ${stats.overridden}`)
  console.log(`  VALID:             ${stats.valid}`)
  console.log(`  MISSING:           ${stats.missing}`)
  console.log(`  INVALID:           ${stats.invalid}`)
  console.log(`  READY:             ${stats.ready}`)
  console.log(`  COST_UNAVAILABLE:  ${stats.costUnavailable}`)
  console.log(`  Snapshots created: ${stats.snapshotsCreated} (dry-run: 0)`)
  console.log(`  Skipped:           ${stats.skipped}`)
  console.log(`  Errors:            ${stats.errors}`)

  if (isDryRun) console.log('\n  ⚠ Dry run — no changes applied. Run with --apply to persist.\n')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
