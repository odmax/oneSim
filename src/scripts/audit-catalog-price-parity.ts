/**
 * Catalog Price Parity Audit Script
 *
 * Scans all BOUND retail ESIMPackages (those with a providerPackageId) and
 * checks whether priceUSD matches the ProviderPackage.sellingPrice and the
 * active PriceSnapshot.finalSellingPrice.
 *
 * Usage:
 *   npx tsx src/scripts/audit-catalog-price-parity.ts          # dry-run (default)
 *   npx tsx src/scripts/audit-catalog-price-parity.ts --apply   # repair stale prices
 */

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const APPLY = process.argv.includes('--apply')

async function main() {
  console.log(`\n=== Catalog Price Parity Audit ${APPLY ? '(APPLY MODE)' : '(DRY RUN)'} ===\n`)

  const boundPackages = await prisma.eSIMPackage.findMany({
    where: {
      providerPackageId: { not: null },
      isActive: true,
      source: { in: ['CATALOG_PRODUCT', 'MANUAL'] },
    },
    include: {
      providerPackage: {
        select: {
          id: true,
          sellingPrice: true,
          sellingCurrency: true,
          activePriceSnapshotId: true,
        },
      },
    },
  })

  console.log(`Found ${boundPackages.length} BOUND retail packages to audit\n`)

  let consistent = 0
  let stale = 0
  let repaired = 0

  for (const pkg of boundPackages) {
    if (!pkg.providerPackage) {
      console.log(`  SKIP ${pkg.id} (${pkg.displayName || pkg.name}): providerPackage not found`)
      continue
    }

    const retailPrice = parseFloat(pkg.priceUSD.toString())
    const ppSell = parseFloat(pkg.providerPackage.sellingPrice.toString())

    let snapshotPrice: number | null = null
    let snapshotStatus: string | null = null
    if (pkg.providerPackage.activePriceSnapshotId) {
      const snap = await prisma.packagePriceSnapshot.findUnique({
        where: { id: pkg.providerPackage.activePriceSnapshotId },
        select: { finalSellingPrice: true, status: true },
      })
      if (snap) {
        snapshotPrice = parseFloat(snap.finalSellingPrice.toString())
        snapshotStatus = snap.status
      }
    }

    const diffs: string[] = []
    if (Math.abs(retailPrice - ppSell) >= 0.005) {
      diffs.push(`retail=$${retailPrice.toFixed(2)} pp=$${ppSell.toFixed(2)}`)
    }
    if (snapshotPrice !== null && Math.abs(ppSell - snapshotPrice) >= 0.005) {
      diffs.push(`pp=$${ppSell.toFixed(2)} snapshot=$${snapshotPrice.toFixed(2)}`)
    }

    if (diffs.length === 0) {
      consistent++
      continue
    }

    stale++
    console.log(`  STALE ${pkg.id} (${pkg.displayName || pkg.name}): ${diffs.join(' | ')}`)

    if (APPLY) {
      await prisma.eSIMPackage.update({
        where: { id: pkg.id },
        data: {
          priceUSD: ppSell,
          localPrice: ppSell,
        },
      })
      repaired++
      console.log(`    → REPAIRED: retail price set to $${ppSell.toFixed(2)}`)
    }
  }

  console.log(`\n=== Summary ===`)
  console.log(`  Total BOUND packages: ${boundPackages.length}`)
  console.log(`  Consistent: ${consistent}`)
  console.log(`  Stale: ${stale}`)
  if (APPLY) {
    console.log(`  Repaired: ${repaired}`)
  }
  console.log(`\nDone.\n`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
