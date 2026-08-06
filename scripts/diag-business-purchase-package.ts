/**
 * Diagnostic script for a business purchase package.
 * Prints safe operational fields — never costs, tokens, or credentials.
 *
 * Usage: npx tsx scripts/diag-business-purchase-package.ts <packageId>
 */

import { prisma } from '../src/lib/prisma'
import { getPackagePurchaseReadiness } from '../src/lib/packages/purchase-readiness'

async function main() {
  const packageId = process.argv[2]
  if (!packageId) { console.error('Usage: npx tsx scripts/diag-business-purchase-package.ts <packageId>'); process.exit(1) }

  const pkg = await prisma.eSIMPackage.findUnique({
    where: { id: packageId },
    include: {
      provider: { select: { id: true, name: true, code: true, status: true, adapterStrategy: true, type: true, enabledCapabilities: true } },
      providerPackage: { select: { id: true, providerPlanId: true, costStatus: true, pricingStatus: true, publishStatus: true, configurationStatus: true, costSource: true, adminCostPrice: true, sellingPrice: true, costPrice: true, activePriceSnapshotId: true } },
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
    console.log(`Capabilities:    ${(pkg.provider.enabledCapabilities as string[])?.join(', ') || 'none'}`)
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

  // Purchase readiness via centralized helper
  console.log('=== Purchase Readiness ===')
  const readiness = getPackagePurchaseReadiness({
    pkg: { isActive: pkg.isActive, hiddenFromCatalog: pkg.hiddenFromCatalog, archivedAt: pkg.archivedAt, source: pkg.source, providerPackageId: pkg.providerPackageId },
    providerPkg: pkg.providerPackage,
    provider: pkg.provider ? { status: pkg.provider.status, enabledCapabilities: pkg.provider.enabledCapabilities, code: pkg.provider.code } : null,
  })

  console.log(`purchaseReady: ${readiness.ready}`)
  console.log(`readinessReasons: ${readiness.reasons.length > 0 ? readiness.reasons.join('; ') : '(none)'}`)

  prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
