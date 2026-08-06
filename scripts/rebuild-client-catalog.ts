/**
 * Rebuild client-facing retail catalog from configured provider plans.
 *
 * Flow:
 * 1. Load configured provider plans
 * 2. Build comparison keys
 * 3. Apply pricing rules (recalculatePackagePrice)
 * 4. Select cheapest eligible plan per comparison group
 * 5. Publish one retail ESIMPackage per group via canonical publish service
 * 6. Unpublish stale duplicate retail winners
 *
 * Modes: --dry-run | --apply [--provider-code=X] [--package-id=X]
 */

import { prisma } from '../src/lib/prisma'
import { buildComparisonKey, type ComparisonKeyInput } from '../src/lib/catalog/comparison-key'
import { recalculatePackagePrice } from '../src/lib/pricing/price-recalculation-service'
import { publishProviderPackageToRetailCatalog } from '../src/lib/services/catalog/publish-to-retail'
import { getPackagePurchaseReadiness } from '../src/lib/packages/purchase-readiness'

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const apply = args.includes('--apply')
  const codeIdx = args.indexOf('--provider-code')
  const codeFilter = codeIdx >= 0 ? args[codeIdx + 1]?.toUpperCase() : undefined
  const idIdx = args.indexOf('--package-id')
  const idFilter = idIdx >= 0 ? args[idIdx + 1] : undefined

  if (!dryRun && !apply) { console.log('Usage: --dry-run | --apply [--provider-code=X] [--package-id=X]'); process.exit(1) }
  console.log(dryRun ? '=== DRY RUN ===' : '=== APPLYING ===')

  const where: any = {}
  if (codeFilter) where.provider = { code: { equals: codeFilter, mode: 'insensitive' } }
  if (idFilter) where.id = idFilter

  const allPlans = await prisma.providerPackage.findMany({
    where,
    include: {
      provider: { select: { id: true, name: true, code: true, status: true, enabledCapabilities: true, catalogPriority: true, activationSuccessRate: true } },
    },
    orderBy: { name: 'asc' },
  })

  const operationalStatuses = ['ACTIVE', 'DEGRADED', 'TESTING']
  let configuredPlans = 0
  let eligiblePlans = 0
  let blockedByCost = 0
  let blockedByConfig = 0
  let blockedByProvider = 0
  let snapshotsCreated = 0
  let retailCreated = 0
  let retailUpdated = 0
  let staleDeactivated = 0
  let groups = 0
  let winnersSelected = 0

  // Step 1-2: Normalize + assess eligibility
  const candidates: any[] = []
  for (const pp of allPlans) {
    const input: ComparisonKeyInput = {
      country: pp.country, region: pp.region,
      dataGB: pp.dataGB, validityDays: pp.validityDays,
    }
    const key = buildComparisonKey(input)
    const configured = ['CONFIGURED', 'AUTO_CONFIGURED'].includes(pp.configurationStatus || '')
    if (configured) configuredPlans++

    const prov = pp.provider
    const caps = (prov?.enabledCapabilities || []) as string[]
    let eligible = true
    if (!prov || !operationalStatuses.includes(prov.status)) { eligible = false; blockedByProvider++ }
    if (!caps.includes('PURCHASE')) { eligible = false; blockedByProvider++ }
    if (!configured) { eligible = false; blockedByConfig++ }
    if (Number(pp.costPrice || 0) <= 0 && !pp.adminCostPrice) { eligible = false; blockedByCost++ }
    if (pp.excludedFromAutoPick) eligible = false
    if (eligible) eligiblePlans++

    candidates.push({ pp, key, eligible })
  }

  // Group
  const groupMap = new Map<string, typeof candidates>()
  for (const c of candidates) { if (!groupMap.has(c.key)) groupMap.set(c.key, []); groupMap.get(c.key)!.push(c) }
  groups = groupMap.size

  // Step 3: Apply pricing (create snapshots)
  if (apply) {
    for (const c of candidates) {
      if (!c.eligible) continue
      const result = await recalculatePackagePrice(c.pp.id, 'REBUILD')
      if (result.success) snapshotsCreated++
    }
  }

  // Step 4: Select cheapest per group
  const winners: { key: string; pp: any }[] = []
  for (const [key, group] of groupMap) {
    const eligibleGroup = group.filter(c => c.eligible)
    if (eligibleGroup.length === 0) continue

    eligibleGroup.sort((a, b) => {
      const aCost = Number(a.pp.costPrice || 0)
      const bCost = Number(b.pp.costPrice || 0)
      if (aCost !== bCost) return aCost - bCost
      return a.pp.id.localeCompare(b.pp.id)
    })

    const winner = eligibleGroup[0]
    winners.push({ key, pp: winner.pp })
    winnersSelected++
    console.log(`  Winner for ${key}: ${winner.pp.name} ($${Number(winner.pp.costPrice || 0).toFixed(2)})`)
  }

  // Step 5: Publish one retail package per group
  if (apply) {
    for (const w of winners) {
      const result = await publishProviderPackageToRetailCatalog(w.pp.id, { reason: 'REBUILD' })
      if (result.success) {
        if (result.created) retailCreated++
        else retailUpdated++
      }
    }
  } else {
    retailCreated = winners.length
  }

  // Check for stale duplicate retail winners (multiple retail packages for same comparison key)
  // Unpublish non-winners
  const allRetail = await prisma.eSIMPackage.findMany({
    where: { isActive: true, source: { in: ['CATALOG_PRODUCT', 'MANUAL'] }, hiddenFromCatalog: false },
    include: { providerPackage: { select: { id: true, country: true, region: true, dataGB: true, validityDays: true } } },
  })
  const retailByKey = new Map<string, typeof allRetail>()
  for (const r of allRetail) {
    const k = buildComparisonKey({
      country: r.providerPackage?.country, region: r.providerPackage?.region,
      dataGB: r.providerPackage?.dataGB, validityDays: r.providerPackage?.validityDays,
    })
    if (!retailByKey.has(k)) retailByKey.set(k, [])
    retailByKey.get(k)!.push(r)
  }

  for (const [key, packages] of retailByKey) {
    if (packages.length <= 1) continue
    const winner = winners.find(w => w.key === key)
    if (!winner) continue
    for (const pkg of packages) {
      if (pkg.providerPackageId === winner.pp.id) continue
      if (apply) {
        await prisma.eSIMPackage.update({ where: { id: pkg.id }, data: { isActive: false } })
        staleDeactivated++
      } else {
        staleDeactivated++
      }
      console.log(`  Stale duplicate: deactivating ${pkg.displayName || pkg.name} (not the selected winner)`)
    }
  }

  // Count client-visible
  const purchasable = await prisma.eSIMPackage.findMany({
    where: { isActive: true, hiddenFromCatalog: false, archivedAt: null, source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
    include: {
      providerPackage: { select: { costStatus: true, pricingStatus: true, publishStatus: true, configurationStatus: true, activePriceSnapshotId: true, sellingPrice: true, costPrice: true } },
      provider: { select: { status: true, enabledCapabilities: true, code: true } },
    },
  })
  const ready = purchasable.filter(p => getPackagePurchaseReadiness({
    pkg: { isActive: p.isActive, hiddenFromCatalog: p.hiddenFromCatalog, archivedAt: p.archivedAt, source: p.source, providerPackageId: p.providerPackageId },
    providerPkg: p.providerPackage, provider: p.provider,
  }).ready)

  console.log(`\n--- Results ---`)
  console.log(`Total provider plans:    ${allPlans.length}`)
  console.log(`Configured plans:        ${configuredPlans}`)
  console.log(`Eligible plans:          ${eligiblePlans}`)
  console.log(`Comparison groups:       ${groups}`)
  console.log(`Cheapest winners:        ${winnersSelected}`)
  console.log(`Blocked by cost:         ${blockedByCost}`)
  console.log(`Blocked by config:       ${blockedByConfig}`)
  console.log(`Blocked by provider:     ${blockedByProvider}`)
  if (apply) {
    console.log(`Snapshots created:       ${snapshotsCreated}`)
    console.log(`Retail created:          ${retailCreated}`)
    console.log(`Retail updated:          ${retailUpdated}`)
    console.log(`Stale deactivated:       ${staleDeactivated}`)
  }
  console.log(`Client-ready count:      ${ready.length}`)
  console.log(`Total retail packages:   ${purchasable.length}`)

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
