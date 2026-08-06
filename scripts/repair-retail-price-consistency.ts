/**
 * Repair retail price consistency between ESIMPackage and active PackagePriceSnapshot.
 * The snapshot is authoritative — retail display price must match snapshot selling price.
 *
 * Modes: --dry-run | --apply [--package-id=X] [--provider-code=X]
 */

import { prisma } from '../src/lib/prisma'

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const apply = args.includes('--apply')
  const idIdx = args.indexOf('--package-id')
  const idFilter = idIdx >= 0 ? args[idIdx + 1] : undefined

  if (!dryRun && !apply) { console.log('Usage: --dry-run | --apply [--package-id=X]'); process.exit(1) }
  console.log(dryRun ? '=== DRY RUN ===' : '=== APPLYING ===')

  const where: any = { isActive: true, source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } }
  if (idFilter) where.id = idFilter

  const packages = await prisma.eSIMPackage.findMany({
    where,
    include: {
      providerPackage: {
        select: {
          id: true, sellingPrice: true, activePriceSnapshotId: true,
          sellingCurrency: true, pricingStatus: true, costPrice: true,
        },
      },
    },
    orderBy: { displayName: 'asc' },
  })

  let inspected = packages.length
  let matching = 0
  let mismatched = 0
  let repaired = 0
  let missingSnapshot = 0
  let invalidPrice = 0

  for (const pkg of packages) {
    const pp = pkg.providerPackage
    if (!pp?.activePriceSnapshotId) {
      missingSnapshot++
      console.log(`  [NO SNAPSHOT] ${pkg.displayName || pkg.name}`)
      continue
    }

    const snapshot = await prisma.packagePriceSnapshot.findUnique({
      where: { id: pp.activePriceSnapshotId },
      select: { id: true, finalSellingPrice: true, status: true },
    })

    if (!snapshot || snapshot.status !== 'ACTIVE') {
      missingSnapshot++
      console.log(`  [SNAPSHOT INVALID] ${pkg.displayName || pkg.name}`)
      continue
    }

    const snapshotPrice = Number(snapshot.finalSellingPrice)
    const retailPrice = parseFloat(pkg.priceUSD.toString())

    if (Math.abs(snapshotPrice - retailPrice) < 0.01) {
      matching++
      continue
    }

    mismatched++
    console.log(`  [MISMATCH] ${pkg.displayName || pkg.name}: retail=$${retailPrice.toFixed(4)} snapshot=$${snapshotPrice.toFixed(4)} diff=$${(retailPrice - snapshotPrice).toFixed(4)}`)

    if (apply) {
      await prisma.eSIMPackage.update({
        where: { id: pkg.id },
        data: { priceUSD: snapshotPrice, localPrice: snapshotPrice, currency: pp.sellingCurrency || 'USD' },
      })
      repaired++
      console.log(`    -> Repaired: retail price set to $${snapshotPrice.toFixed(2)}`)
    }
  }

  console.log(`\n--- Results ---`)
  console.log(`Inspected:         ${inspected}`)
  console.log(`Matching:          ${matching}`)
  console.log(`Mismatched:        ${mismatched}`)
  console.log(`Missing snapshots: ${missingSnapshot}`)
  if (apply) console.log(`Repaired:          ${repaired}`)

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
