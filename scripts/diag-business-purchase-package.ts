/**
 * Diagnostic script for a business purchase package.
 * Prints safe operational fields — never costs, tokens, or credentials.
 *
 * Usage: npx tsx scripts/diag-business-purchase-package.ts <packageId>
 */

import { prisma } from '../src/lib/prisma'

async function main() {
  const packageId = process.argv[2]
  if (!packageId) { console.error('Usage: npx tsx scripts/diag-business-purchase-package.ts <packageId>'); process.exit(1) }

  const pkg = await prisma.eSIMPackage.findUnique({
    where: { id: packageId },
    select: {
      id: true, name: true, displayName: true, isActive: true,
      hiddenFromCatalog: true, archivedAt: true, source: true,
      priceUSD: true, currency: true, dataGB: true, validityDays: true,
      providerId: true, providerPackageId: true,
      provider: { select: { id: true, name: true, code: true, status: true, adapterStrategy: true, type: true } },
      providerPackage: { select: { id: true, providerPlanId: true, costStatus: true, pricingStatus: true, publishStatus: true, configurationStatus: true, costSource: true, adminCostPrice: true, sellingPrice: true, activePriceSnapshotId: true } },
    },
  })

  if (!pkg) { console.error(`Package ${packageId} not found`); process.exit(1) }

  console.log('=== Package Diagnostic ===')
  console.log(`ID:              ${pkg.id}`)
  console.log(`Name:            ${pkg.displayName || pkg.name}`)
  console.log(`Active:          ${pkg.isActive}`)
  console.log(`Hidden:          ${pkg.hiddenFromCatalog}`)
  console.log(`Archived:        ${pkg.archivedAt ? 'Yes' : 'No'}`)
  console.log(`Source:          ${pkg.source}`)
  console.log(`Selling price:   ${pkg.priceUSD ? 'Present' : 'MISSING'}`)
  console.log(`Currency:        ${pkg.currency}`)
  console.log(`Data:            ${pkg.dataGB} GB`)
  console.log(`Validity:        ${pkg.validityDays} days`)
  console.log()

  console.log('=== Provider Link ===')
  if (pkg.provider) {
    console.log(`Provider ID:     ${pkg.provider.id}`)
    console.log(`Provider Name:   ${pkg.provider.name}`)
    console.log(`Provider Code:   ${pkg.provider.code}`)
    console.log(`Provider Status: ${pkg.provider.status}`)
    console.log(`Adapter:         ${pkg.provider.adapterStrategy || '(none)'}`)
    console.log(`Type:            ${pkg.provider.type}`)
  } else {
    console.log('No provider linked')
  }
  console.log()

  console.log('=== Provider Package ===')
  if (pkg.providerPackage) {
    console.log(`PP ID:           ${pkg.providerPackage.id}`)
    console.log(`Plan ID:         ${pkg.providerPackage.providerPlanId || 'none'}`)
    console.log(`Cost Status:     ${pkg.providerPackage.costStatus}`)
    console.log(`Pricing Status:  ${pkg.providerPackage.pricingStatus}`)
    console.log(`Cost Source:     ${pkg.providerPackage.costSource || 'none'}`)
    console.log(`Admin Override:  ${pkg.providerPackage.adminCostPrice ? 'Yes' : 'No'}`)
    console.log(`Snapshot ID:     ${pkg.providerPackage.activePriceSnapshotId || 'none'}`)
    console.log(`Publish Status:  ${pkg.providerPackage.publishStatus}`)
    console.log(`Config Status:   ${pkg.providerPackage.configurationStatus}`)
  } else {
    console.log('No provider package linked')
  }
  console.log()

  // Determine blocking factor
  console.log('=== Purchase Readiness ===')
  const issues: string[] = []
  if (!pkg.isActive) issues.push('Package is inactive')
  if (pkg.hiddenFromCatalog) issues.push('Package is hidden from catalog')
  if (pkg.archivedAt) issues.push('Package is archived')
  if (pkg.source === 'PROVIDER_PLAN') issues.push('Source is PROVIDER_PLAN (not purchasable)')
  if (pkg.providerPackage) {
    if (pkg.providerPackage.costStatus === 'MISSING') issues.push('Cost status is MISSING — admin cost override needed')
    if (pkg.providerPackage.costStatus === 'INVALID') issues.push('Cost status is INVALID')
    if (pkg.providerPackage.pricingStatus === 'COST_UNAVAILABLE') issues.push('Pricing status is COST_UNAVAILABLE')
    if (pkg.providerPackage.pricingStatus === 'DISABLED') issues.push('Pricing status is DISABLED')
  }
  if (!pkg.providerId) issues.push('No provider assigned')
  if (pkg.provider && !['ACTIVE','DEGRADED','TESTING'].includes(pkg.provider.status)) issues.push(`Provider is ${pkg.provider.status}`)

  if (issues.length === 0) {
    console.log('Ready for purchase ✓')
  } else {
    console.log('BLOCKED:')
    for (const issue of issues) console.log(`  - ${issue}`)
  }

  prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
