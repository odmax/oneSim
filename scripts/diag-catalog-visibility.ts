/**
 * CATALOG VISIBILITY DIAGNOSTIC
 * READ ONLY
 *
 * Diagnose why published packages are not appearing in the Business Buy eSIM
 * catalog / client API on staging.
 *
 * Usage (run on staging with the staging DATABASE_URL):
 *   npx tsx scripts/diag-catalog-visibility.ts
 *
 * Optional filter:
 *   npx tsx scripts/diag-catalog-visibility.ts --provider-code=CHOICE
 *
 * This script:
 *   - executes the CANONICAL queryPurchasablePackages('portal') and ('api')
 *   - reads the SAME initial retail candidate population
 *   - runs the SAME canonical getPackagePurchaseReadiness
 *   - reads capability exposure via isCapabilityExposedToPortal / ToApi
 *   - reports CHOICE-specific stage counts with EXACT reasons
 *   - reports the AIRHUB orphan (published ProviderPackage without a linked
 *     ESIMPackage) — diagnostic only
 *
 * It is strictly READ-ONLY:
 *   NO prisma.create/update/upsert/delete
 *   NO raw INSERT/UPDATE/DELETE
 *   NO provider HTTP calls
 *   NO catalog publishing
 *   NO price recalculation
 *   NO snapshot creation
 *   NO recovery or repair
 *
 * Exits non-zero only on unexpected errors. Never attempts repair.
 */
import { prisma } from '../src/lib/prisma'
import { queryPurchasablePackages } from '../src/lib/packages/query-purchasable'
import { isCapabilityExposedToPortal, isCapabilityExposedToApi } from '../src/lib/providers/capabilities/exposure'
import { ProviderCapability } from '../src/lib/providers/capabilities/types'
import { analyzeCatalogVisibility, formatCatalogVisibilityReport, type DiagnosticRetailCandidate, type DiagnosticExposureState, type DiagnosticProviderInfo } from '../src/lib/packages/catalog-visibility-diagnostic'

const RETRYABLE_ERROR_CODES = new Set(['PROTOCOL_CONNECTION_LOST', 'P1001', 'P1002', 'P2024'])

async function safeRawExposure(providerId: string): Promise<{ capability: string; clientPortalEnabled: boolean; clientApiEnabled: boolean }[]> {
  return prisma.$queryRawUnsafe<{ capability: string; clientPortalEnabled: boolean; clientApiEnabled: boolean }[]>(
    `SELECT capability, "clientPortalEnabled", "clientApiEnabled" FROM provider_capability_exposure WHERE "providerId"=$1 AND capability=$2`,
    providerId,
    ProviderCapability.PURCHASE,
  ).catch(() => [])
}

async function main() {
  const args = process.argv.slice(2)
  const providerCodeFilter = (() => {
    const idx = args.indexOf('--provider-code')
    return idx >= 0 ? args[idx + 1]?.toUpperCase() : undefined
  })()

  console.log('CATALOG VISIBILITY DIAGNOSTIC')
  console.log('READ ONLY')
  console.log('')

  // 1. Canonical query final counts
  const portal = await queryPurchasablePackages('portal')
  const api = await queryPurchasablePackages('api')
  console.log('--- CANONICAL QUERY RESULTS ---')
  console.log(`PORTAL_FINAL_COUNT=${portal.length}`)
  console.log(`API_FINAL_COUNT=${api.length}`)

  const groupByProvider = (pkgs: Array<{ providerPackage?: { providerId?: string | null } | null; provider?: { code?: string | null } | null }>) => {
    const map = new Map<string, number>()
    for (const p of pkgs) {
      const code = p.provider?.code || p.providerPackage?.providerId || '(none)'
      map.set(code, (map.get(code) || 0) + 1)
    }
    return Array.from(map.entries()).map(([code, count]) => `${code}: ${count}`)
  }
  console.log(`PORTAL_BY_PROVIDER=${groupByProvider(portal).join(' | ')}`)
  console.log(`API_BY_PROVIDER=${groupByProvider(api).join(' | ')}`)
  console.log('')

  // 2. Initial retail candidates (same population as the canonical query)
  const candidates = await prisma.eSIMPackage.findMany({
    where: { isActive: true, source: { in: ['CATALOG_PRODUCT', 'MANUAL'] } },
    include: {
      providerPackage: {
        select: {
          id: true, providerId: true, costStatus: true, pricingStatus: true, publishStatus: true,
          configurationStatus: true, activePriceSnapshotId: true, sellingPrice: true, costPrice: true,
        },
      },
      provider: { select: { id: true, status: true, enabledCapabilities: true, code: true, adapterStrategy: true } },
    },
    orderBy: { priceUSD: 'asc' },
  })

  const filtered = providerCodeFilter
    ? candidates.filter(c => (c.provider?.code || '').toUpperCase() === providerCodeFilter)
    : candidates

  console.log(`INITIAL_RETAIL_CANDIDATES=${filtered.length}`)

  // 3. Exposure + provider info for every involved provider
  const providerIds = [...new Set(filtered.map(c => c.provider?.id || c.providerPackage?.providerId).filter(Boolean) as string[])]
  const exposureByProvider: Record<string, DiagnosticExposureState> = {}
  const providerInfo: Record<string, DiagnosticProviderInfo> = {}

  for (const pid of providerIds) {
    const rows = await safeRawExposure(pid)
    const purchaseRow = rows.find(r => r.capability === ProviderCapability.PURCHASE)
    const portalExposure = purchaseRow ? purchaseRow.clientPortalEnabled : await isCapabilityExposedToPortal(pid, ProviderCapability.PURCHASE)
    const apiExposure = purchaseRow ? purchaseRow.clientApiEnabled : await isCapabilityExposedToApi(pid, ProviderCapability.PURCHASE)
    exposureByProvider[pid] = { portalPurchase: portalExposure, apiPurchase: apiExposure }

    const prov = await prisma.provider.findUnique({
      where: { id: pid },
      select: { id: true, code: true, status: true, adapterStrategy: true, enabledCapabilities: true },
    })
    if (prov) {
      providerInfo[pid] = {
        id: prov.id,
        code: prov.code,
        status: prov.status,
        adapterStrategy: prov.adapterStrategy,
        enabledCapabilities: prov.enabledCapabilities,
      }
    }
  }

  // 4. Aggregate stage counts using the canonical helpers
  const diagnosticCandidates: DiagnosticRetailCandidate[] = filtered.map(c => ({
    id: c.id,
    displayName: c.displayName,
    name: c.name,
    isActive: c.isActive,
    hiddenFromCatalog: c.hiddenFromCatalog,
    archivedAt: c.archivedAt,
    source: c.source,
    providerPackageId: c.providerPackageId,
    priceUSD: c.priceUSD,
    providerPackage: c.providerPackage
      ? {
          id: c.providerPackage.id,
          providerId: c.providerPackage.providerId,
          costStatus: c.providerPackage.costStatus,
          pricingStatus: c.providerPackage.pricingStatus,
          publishStatus: c.providerPackage.publishStatus,
          configurationStatus: c.providerPackage.configurationStatus,
          activePriceSnapshotId: c.providerPackage.activePriceSnapshotId,
          sellingPrice: c.providerPackage.sellingPrice,
          costPrice: c.providerPackage.costPrice,
        }
      : null,
    provider: c.provider
      ? { id: c.provider.id, code: c.provider.code, status: c.provider.status, enabledCapabilities: c.provider.enabledCapabilities }
      : null,
  }))

  const report = analyzeCatalogVisibility({ candidates: diagnosticCandidates, exposureByProvider, providerInfo })
  console.log(formatCatalogVisibilityReport(report))

  // 5. Price snapshot state for the 39 CHOICE published ProviderPackages
  const publishedProviderPackages = await prisma.providerPackage.findMany({
    where: { publishStatus: 'PUBLISHED' },
    select: { id: true, providerId: true, name: true, publishStatus: true, sellingPrice: true, configurationStatus: true, activePriceSnapshotId: true, provider: { select: { code: true } } },
  })

  const choicePublished = publishedProviderPackages.filter(p => p.provider?.code === 'CHOICE')
  console.log('--- PRICE SNAPSHOT STATE (published CHOICE) ---')
  console.log(`CHOICE_PUBLISHED_TOTAL=${choicePublished.length}`)
  console.log(`CHOICE_PUBLISHED_WITH_SNAPSHOT=${choicePublished.filter(p => !!p.activePriceSnapshotId).length}`)
  console.log(`CHOICE_PUBLISHED_WITHOUT_SNAPSHOT=${choicePublished.filter(p => !p.activePriceSnapshotId).length}`)

  // 6. Orphan detection — PUBLISHED ProviderPackage with no linked ESIMPackage (read-only)
  const allPublished = publishedProviderPackages
  const linkedRetailCounts = new Map<string, number>()
  const linkedRetail = await prisma.eSIMPackage.findMany({
    where: { providerPackageId: { in: allPublished.map(p => p.id) } },
    select: { providerPackageId: true },
  })
  for (const lr of linkedRetail) {
    if (lr.providerPackageId) linkedRetailCounts.set(lr.providerPackageId, (linkedRetailCounts.get(lr.providerPackageId) || 0) + 1)
  }
  const orphans = allPublished.filter(p => !(linkedRetailCounts.get(p.id) || 0))

  console.log('--- ORPHANS (PUBLISHED ProviderPackage with no linked ESIMPackage) — DIAGNOSTIC ONLY ---')
  console.log(`ORPHAN_COUNT=${orphans.length}`)
  for (const o of orphans) {
    console.log(`  provider=${o.provider?.code || '?'} packageId=${o.id} name=${o.name} publishStatus=${o.publishStatus} sellingPrice=${o.sellingPrice ?? 'null'} configurationStatus=${o.configurationStatus ?? 'null'}`)
  }

  console.log('')
  console.log('NO DATABASE WRITE')
  console.log('NO PROVIDER CALL')
  console.log('NO PUBLISH')
  console.log('NO SYNC')

  await prisma.$disconnect()
}

main().catch((e) => {
  const code = String(e?.code || '')
  const message = String(e?.message || e || 'Unknown error')
  console.error(`FATAL: ${message}`)
  // Non-retryable/unknown errors exit non-zero; connection blips are surfaced
  // without pretending to have repaired anything.
  if (!RETRYABLE_ERROR_CODES.has(code)) {
    process.exit(1)
  }
})
