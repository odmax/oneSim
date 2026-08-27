/**
 * Catalog Price Parity Audit Script
 *
 * Scans all BOUND retail ESIMPackages and classifies each by price parity.
 *
 * Classifications:
 *   OK                       — all prices consistent, nothing to do
 *   RETAIL_STALE             — retail price is the only stale field (repairable)
 *   PROVIDER_SNAPSHOT_MISMATCH — PP sellingPrice ≠ snapshot (not repairable)
 *   NO_SNAPSHOT              — no active snapshot (not repairable)
 *   MISSING_RETAIL           — no linked retail package (not applicable here)
 *   NOT_READY                — cost/pricing/publish/config status issue
 *   AMBIGUOUS                — multiple retail packages for same PP
 *   OTHER                    — uncategorised edge case
 *
 * Usage:
 *   npx tsx src/scripts/audit-catalog-price-parity.ts          # dry-run (default)
 *   npx tsx src/scripts/audit-catalog-price-parity.ts --apply   # repair RETAIL_STALE only
 */

import { PrismaClient } from '@prisma/client'
import { classifyPackage, buildSyncDataFromClassifierInput } from '../lib/pricing/catalog-parity-classifier'
const prisma = new PrismaClient()

const APPLY = process.argv.includes('--apply')
const TOLERANCE = 0.005

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
          id: true, name: true, dataGB: true, validityDays: true,
          sellingPrice: true, sellingCurrency: true, costPrice: true, currency: true,
          markupPercent: true, providerPlanId: true, providerId: true,
          activePriceSnapshotId: true,
          costStatus: true, pricingStatus: true, publishStatus: true, configurationStatus: true,
        },
      },
    },
  })

  console.log(`Found ${boundPackages.length} BOUND retail packages\n`)

  const counts: Record<string, number> = {}
  let repaired = 0

  for (const pkg of boundPackages) {
    const ppId = pkg.providerPackageId
    let linkedRetailCount = 1
    if (ppId) {
      const count = await prisma.eSIMPackage.count({ where: { providerPackageId: ppId, isActive: true } })
      linkedRetailCount = count
    }

    let snapshotFinalSellingPrice: number | null = null
    let snapshotStatus: string | null = null
    if (pkg.providerPackage?.activePriceSnapshotId) {
      const snap = await prisma.packagePriceSnapshot.findUnique({
        where: { id: pkg.providerPackage.activePriceSnapshotId },
        select: { finalSellingPrice: true, status: true },
      })
      if (snap) {
        snapshotFinalSellingPrice = parseFloat(snap.finalSellingPrice.toString())
        snapshotStatus = snap.status
      }
    }

    const result = classifyPackage({
      retailPackageId: pkg.id,
      retailDisplayName: pkg.displayName || pkg.name,
      retailPriceUSD: parseFloat(pkg.priceUSD.toString()),
      retailLocalPrice: pkg.localPrice ? parseFloat(pkg.localPrice.toString()) : null,
      retailCurrency: pkg.currency,
      providerPackageId: ppId,
      providerPackageSellingPrice: pkg.providerPackage && pkg.providerPackage.sellingPrice != null ? parseFloat(pkg.providerPackage.sellingPrice.toString()) : null,
      providerPackageSellingCurrency: pkg.providerPackage?.sellingCurrency ?? null,
      providerPackageCostStatus: pkg.providerPackage?.costStatus ?? null,
      providerPackagePricingStatus: pkg.providerPackage?.pricingStatus ?? null,
      providerPackagePublishStatus: pkg.providerPackage?.publishStatus ?? null,
      providerPackageConfigurationStatus: pkg.providerPackage?.configurationStatus ?? null,
      providerPackageActivePriceSnapshotId: pkg.providerPackage?.activePriceSnapshotId ?? null,
      linkedRetailCount,
      snapshotFinalSellingPrice,
      snapshotStatus,
    })

    counts[result.classification] = (counts[result.classification] || 0) + 1

    if (result.classification === 'OK') continue

    const label = result.classification.padEnd(28)
    console.log(`  ${label} ${pkg.id} (${pkg.displayName || pkg.name}): ${result.reason}`)

    if (result.classification === 'RETAIL_STALE' && APPLY) {
      if (!result.repairable) {
        console.log(`    → SKIP: classified as non-repairable`)
        continue
      }
      if (!pkg.providerPackage) {
        console.log(`    → SKIP: no providerPackage`)
        continue
      }

      const syncData = buildSyncDataFromClassifierInput({
        retailPackageId: pkg.id,
        retailDisplayName: pkg.displayName || pkg.name,
        retailPriceUSD: parseFloat(pkg.priceUSD.toString()),
        retailLocalPrice: pkg.localPrice ? parseFloat(pkg.localPrice.toString()) : null,
        retailCurrency: pkg.currency,
        providerPackageId: ppId,
        providerPackageSellingPrice: pkg.providerPackage.sellingPrice != null ? parseFloat(pkg.providerPackage.sellingPrice.toString()) : null,
        providerPackageSellingCurrency: pkg.providerPackage.sellingCurrency,
        providerPackageCostStatus: pkg.providerPackage.costStatus,
        providerPackagePricingStatus: pkg.providerPackage.pricingStatus,
        providerPackagePublishStatus: pkg.providerPackage.publishStatus,
        providerPackageConfigurationStatus: pkg.providerPackage.configurationStatus,
        providerPackageActivePriceSnapshotId: pkg.providerPackage.activePriceSnapshotId,
        linkedRetailCount,
        snapshotFinalSellingPrice,
        snapshotStatus,
      })

      const oldRetail = parseFloat(pkg.priceUSD.toString())

      console.log(`    → retailPackageId: ${pkg.id}`)
      console.log(`    → providerPackageId: ${ppId}`)
      console.log(`    → old retail: $${oldRetail.toFixed(2)}`)
      console.log(`    → new retail: $${syncData.priceUSD.toFixed(2)}`)
      console.log(`    → snapshot: $${snapshotFinalSellingPrice?.toFixed(2) ?? 'N/A'}`)
      console.log(`    → classification: RETAIL_STALE`)

      await prisma.eSIMPackage.update({
        where: { id: pkg.id },
        data: {
          priceUSD: syncData.priceUSD,
          localPrice: syncData.localPrice,
          currency: syncData.currency,
        },
      })

      const verify = await prisma.eSIMPackage.findUnique({
        where: { id: pkg.id },
        select: { priceUSD: true, localPrice: true },
      })
      const verifiedPrice = verify ? parseFloat(verify.priceUSD.toString()) : null
      if (verifiedPrice === null || Math.abs(verifiedPrice - syncData.priceUSD) >= TOLERANCE) {
        console.log(`    ✗ VERIFICATION FAILED: retail=$${verifiedPrice} expected=$${syncData.priceUSD}`)
      } else {
        console.log(`    ✓ VERIFIED: retail=$${verifiedPrice.toFixed(2)} matches PP=$${syncData.priceUSD.toFixed(2)}`)
        repaired++
      }
    }
  }

  console.log(`\n=== Summary ===`)
  console.log(`  Total BOUND packages: ${boundPackages.length}`)
  for (const [cls, count] of Object.entries(counts).sort()) {
    console.log(`  ${cls}: ${count}`)
  }
  if (APPLY) {
    console.log(`  Repaired: ${repaired}`)
  }
  console.log(`\nDone.\n`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
