/**
 * Targeted diagnostic for a specific AirHub plan by upstream plan ID.
 * Usage: npx tsx scripts/diag-airhub-plan-pricing.ts --plan-id 1000593
 */

import { prisma } from '../src/lib/prisma'

async function main() {
  const planId = process.argv.find(a => a.startsWith('--plan-id='))?.split('=')[1]
  if (!planId) { console.error('Usage: --plan-id=<planId>'); process.exit(1) }

  // Find all ProviderPackage rows for this upstream plan
  const rows = await prisma.providerPackage.findMany({
    where: { providerPlanId: planId },
    select: {
      id: true, providerPlanId: true, providerId: true, name: true,
      costPrice: true, currency: true, costSource: true, costStatus: true, pricingStatus: true,
      publishStatus: true, configurationStatus: true, adminCostPrice: true,
      activePriceSnapshotId: true, providerRawData: true,
      createdAt: true, updatedAt: true,
      provider: { select: { code: true, name: true, status: true } },
    },
    orderBy: { updatedAt: 'desc' },
  })

  console.log(`=== Plan ${planId} — ${rows.length} ProviderPackage row(s) ===\n`)

  for (const row of rows) {
    const rawData = (row.providerRawData as any) || {}
    const priceKeys = Object.keys(rawData).filter(k => k.toLowerCase().includes('price') || k.toLowerCase().includes('cost'))

    console.log(`PP ID:           ${row.id}`)
    console.log(`Provider:        ${row.provider?.name} (${row.provider?.code}) — ${row.provider?.status}`)
    console.log(`Plan name:       ${row.name}`)
    console.log(`costPrice raw:   ${row.costPrice != null ? 'Present' : 'MISSING'}`)
    console.log(`costPrice value: ${row.costPrice != null && Number(row.costPrice) > 0 ? 'Positive (>0)' : row.costPrice != null && Number(row.costPrice) === 0 ? 'ZERO' : 'NULL'}`)
    console.log(`currency:        ${row.currency}`)
    console.log(`costSource:      ${row.costSource || 'NULL'}`)
    console.log(`costStatus:      ${row.costStatus}`)
    console.log(`pricingStatus:   ${row.pricingStatus}`)
    console.log(`publishStatus:   ${row.publishStatus}`)
    console.log(`configStatus:    ${row.configurationStatus}`)
    console.log(`adminCostPrice:  ${row.adminCostPrice ? 'Present' : 'NO'}`)
    console.log(`snapshot:        ${row.activePriceSnapshotId || 'none'}`)
    console.log(`providerRawData price-like keys: ${priceKeys.length ? priceKeys.join(', ') : 'NONE'}`)
    console.log(`created:         ${row.createdAt?.toISOString()}`)
    console.log(`updated:         ${row.updatedAt?.toISOString()}`)
    console.log()
  }

  // Check linked ESIMPackage
  const retailPkg = await prisma.eSIMPackage.findFirst({
    where: { providerPackageId: rows[0]?.id },
    select: { id: true, name: true, displayName: true, isActive: true, priceUSD: true },
  })
  if (retailPkg) {
    console.log(`Linked retail package: ${retailPkg.id} — ${retailPkg.displayName || retailPkg.name}`)
    console.log(`Active: ${retailPkg.isActive}, selling price: ${retailPkg.priceUSD ? 'Present' : 'No'}`)
  }

  prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
