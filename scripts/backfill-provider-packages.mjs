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
 * Idempotent: safe to run multiple times. Uses upsert by providerId+providerPlanId.
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const dryRun = process.argv.includes('--dry-run')

async function main() {
  console.log('\n=== Backfill Provider Packages ===\n')

  // Find ESIMPackage records imported from providers
  const imported = await prisma.eSIMPackage.findMany({
    where: { source: 'PROVIDER_PLAN', providerPlanId: { not: null } },
    include: { providerPackage: true },
  })

  console.log(`Found ${imported.length} imported ESIMPackage records (source=PROVIDER_PLAN).`)
  console.log('')

  let created = 0, updated = 0, skipped = 0

  for (const esim of imported) {
    if (esim.providerPackage) {
      // Already linked to a ProviderPackage
      skipped++
      continue
    }

    if (!esim.providerId || !esim.providerPlanId) {
      skipped++
      continue
    }

    const data = {
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
      console.log(`  Would upsert: ${esim.name} (${esim.providerPlanId})`)
      created++
      continue
    }

    try {
      // Use raw SQL upsert for reliability
      await prisma.$executeRawUnsafe(`
        INSERT INTO provider_packages (
          id, provider_id, provider_plan_id, provider_plan_code, name, data_gb, validity_days,
          cost_price, currency, is_available, publish_status, configuration_status,
          selling_price, selling_currency, markup_percent, provider_raw_data, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5, $6,
          $7, $8, true, 'DRAFT', 'UNCONFIGURED',
          $9, $10, $11, $12::jsonb, now(), now()
        )
        ON CONFLICT (provider_id, provider_plan_id)
        DO UPDATE SET
          provider_plan_code = EXCLUDED.provider_plan_code,
          name = EXCLUDED.name,
          data_gb = EXCLUDED.data_gb,
          validity_days = EXCLUDED.validity_days,
          cost_price = EXCLUDED.cost_price,
          selling_price = EXCLUDED.selling_price,
          updated_at = now()
      `,
        esim.providerId,
        esim.providerPlanId,
        esim.packageCode || null,
        esim.displayName || esim.name,
        esim.dataGB,
        esim.validityDays,
        esim.costPriceUSD || 0,
        esim.currency || 'USD',
        esim.priceUSD,
        esim.currency || 'USD',
        esim.markupPercent || null,
        JSON.stringify(esim.providerRawData || {}),
      )
      created++
    } catch (e) {
      console.error(`  Failed to upsert ${esim.name}: ${e.message}`)
      skipped++
    }
  }

  console.log('')
  console.log(`Result: ${created} created, 0 updated, ${skipped} skipped`)
  if (dryRun) console.log('  (dry run — no changes written)')
  console.log('')

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
