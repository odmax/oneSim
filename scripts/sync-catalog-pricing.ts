import { PrismaClient } from '@prisma/client'
import { buildCatalogProductSyncData, getCatalogPricingDifferences, parseDecimalSafe, decimalValuesEqual } from '../src/lib/services/catalog-price-sync'

interface CliArgs {
  dryRun: boolean
  provider?: string
  packageId?: string
  limit?: number
  batchSize: number
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2)
  const result: CliArgs = { dryRun: true, batchSize: 50 }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--execute':
        result.dryRun = false
        break
      case '--dry-run':
        result.dryRun = true
        break
      case '--provider':
        result.provider = args[++i]
        break
      case '--package-id':
        result.packageId = args[++i]
        break
      case '--limit':
        result.limit = parseInt(args[++i], 10)
        break
      case '--batch-size':
        result.batchSize = parseInt(args[++i], 10)
        break
    }
  }

  return result
}

async function main() {
  const args = parseArgs()
  const prisma = new PrismaClient()

  const startedAt = Date.now()
  let checked = 0
  let linked = 0
  let stale = 0
  let updated = 0
  let synced = 0
  let skipped = 0
  let failures = 0

  console.log(`[CATALOG_SYNC_PRICING] mode=${args.dryRun ? 'DRY_RUN' : 'EXECUTE'} batchSize=${args.batchSize}`)

  try {
    const where: any = {}

    if (args.packageId) {
      where.id = args.packageId
    }

    if (args.provider) {
      where.OR = [
        { provider: { id: args.provider } },
        { provider: { code: args.provider } },
      ]
    }

    const totalCount = await prisma.providerPackage.count({ where })
    console.log(`[CATALOG_SYNC_PRICING] total eligible provider packages: ${totalCount}`)

    let skip = 0
    const limit = args.limit ?? totalCount

    while (skip < limit) {
      const take = Math.min(args.batchSize, limit - skip)
      const packages = await prisma.providerPackage.findMany({
        where,
        skip,
        take,
        include: { provider: { select: { id: true, code: true } } },
      })

      if (packages.length === 0) break

      for (const pp of packages) {
        checked++

        const linkedProducts = await prisma.eSIMPackage.findMany({
          where: { providerPackageId: pp.id },
          select: { id: true, priceUSD: true, markupPercent: true, hiddenFromCatalog: true, archivedAt: true },
        })

        if (linkedProducts.length === 0) {
          skipped++
          continue
        }

        linked++

        for (const product of linkedProducts) {
          const diffs = getCatalogPricingDifferences(pp as any, product as any)

          if (diffs.length === 0) {
            synced++
            continue
          }

          stale++

          if (!args.dryRun) {
            try {
              const syncData = buildCatalogProductSyncData(pp as any)
              await prisma.eSIMPackage.update({
                where: { id: product.id },
                data: syncData,
              })
              updated++
            } catch (e) {
              failures++
              console.error(`[CATALOG_SYNC_PRICING] Failed to update product ${product.id} for package ${pp.id}:`, e)
            }
          } else {
            updated++
          }
        }
      }

      skip += take
    }

    const durationMs = Date.now() - startedAt
    console.log()
    console.log('=== CATALOG SYNC PRICING SUMMARY ===')
    console.log(`  Provider packages checked:   ${checked}`)
    console.log(`  Linked products found:       ${linked}`)
    console.log(`  Stale products found:        ${stale}`)
    console.log(`  Products updated:            ${updated}`)
    console.log(`  Already synchronized:        ${synced}`)
    console.log(`  Packages skipped (no link):  ${skipped}`)
    console.log(`  Failures:                    ${failures}`)
    console.log(`  Total duration:              ${durationMs}ms`)
    console.log(`  Mode:                        ${args.dryRun ? 'DRY RUN (no writes)' : 'EXECUTE'}`)
    console.log('===================================')

    if (args.dryRun && stale > 0) {
      console.log()
      console.log(`To apply these ${stale} updates, run with --execute`)
    }

    if (failures > 0) {
      process.exitCode = 1
    }
  } catch (e) {
    console.error('[CATALOG_SYNC_PRICING] Fatal error:', e)
    process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
}

main()