#!/usr/bin/env node
/**
 * Backfill ProviderPackage records from imported ESIMPackage records.
 *
 * Problem: Old import flow created ESIMPackage records directly (source=PROVIDER_PLAN).
 * These never created ProviderPackage records, so Provider Catalog was empty.
 *
 * Usage:
 *   node scripts/backfill-provider-packages.mjs
 *   node scripts/backfill-provider-packages.mjs --dry-run
 *
 * Idempotent: safe to run multiple times.
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const dryRun = process.argv.includes('--dry-run')

async function main() {
  console.log('\n=== Backfill Provider Packages ===\n')

  const imported = await prisma.eSIMPackage.findMany({
    where: { source: 'PROVIDER_PLAN', providerPlanId: { not: null } },
    include: { providerPackage: true },
  })

  console.log(`Found: ${imported.length}`)

  let created = 0, updated = 0, skipped = 0

  for (const esim of imported) {
    if (esim.providerPackage) {
      skipped++
      continue
    }

    if (!esim.providerId || !esim.providerPlanId) {
      skipped++
      continue
    }

    const pkgData = {
      providerId: esim.providerId,
      providerPlanId: esim.providerPlanId,
      providerPlanCode: esim.packageCode || esim.sku || null,
      name: esim.displayName || esim.name,
      dataGB: esim.dataGB,
      validityDays: esim.validityDays,
      costPrice: esim.costPriceUSD || 0,
      currency: esim.costCurrency || 'USD',
      country: null,
      region: null,
      isAvailable: true,
      publishStatus: 'DRAFT',
      configurationStatus: 'UNCONFIGURED',
      sellingPrice: esim.priceUSD,
      sellingCurrency: esim.currency || 'USD',
      markupPercent: esim.markupPercent,
      providerRawData: esim.providerRawData || {},
    }

    if (dryRun) {
      console.log(`  Would create: ${pkgData.name} (${pkgData.providerPlanId})`)
      created++
      continue
    }

    try {
      const existing = await prisma.providerPackage.findFirst({
        where: { providerId: esim.providerId, providerPlanId: esim.providerPlanId },
      })

      if (existing) {
        await prisma.providerPackage.update({
          where: { id: existing.id },
          data: pkgData,
        })
        updated++
      } else {
        await prisma.providerPackage.create({ data: pkgData })
        created++
      }
    } catch (e) {
      console.error(`  Failed for ${pkgData.name}: ${e.message}`)
      skipped++
    }
  }

  console.log(`Created: ${created}`)
  console.log(`Updated: ${updated}`)
  console.log(`Skipped: ${skipped}`)
  if (dryRun) console.log('  (dry run — no changes written)')

  const total = await prisma.providerPackage.count()
  console.log(`\nProviderPackage total: ${total}`)
  console.log('')

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
