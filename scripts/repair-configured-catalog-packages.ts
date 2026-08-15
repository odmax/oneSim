/**
 * Repair configured catalog packages that are missing active snapshots,
 * costStatus/pricingStatus, or failing purchase readiness.
 *
 * SAFETY-FIRST SURGICAL TOOL.
 *
 * Canonical repair: runs finalizeCatalogPackageConfiguration() which invokes
 * recalculatePackagePrice() (establishes effective cost via computeEffectiveCost,
 * costStatus, pricingStatus, markup, active price snapshot) and then verifies
 * purchase readiness — the SAME pipeline a newly configured package uses. No
 * manual field patching, no provider-name branches, no provider calls, no
 * publish, no sync.
 *
 * Filters are applied BEFORE any classification/apply work:
 *   --provider=<code>            exact (case-insensitive) provider code
 *   --publish-status=<status>     DRAFT|READY|PUBLISHED|HIDDEN|ARCHIVED
 *   --published-only              alias for --publish-status=PUBLISHED
 *   --package-id=<ProviderPackage.id>
 *   --require-retail-link         skip + report packages with no linked ESIMPackage
 *   --all                         explicitly allow broad (unfiltered) apply
 *
 * Safety:
 *   - default mode is DRY-RUN (zero DB writes).
 *   - --apply is REFUSED unless --all or at least one targeting filter is set.
 *   - --published-only conflicting with --publish-status fails loudly.
 *   - invalid provider codes / publish-status values fail loudly.
 *
 * Modes:
 *   --dry-run                         default-safe, zero DB writes
 *   --apply                           perform canonical repair
 *
 * READ ONLY when --dry-run: no prisma writes, no snapshot creation, no
 * provider calls, no publish, no sync.
 */
import { prisma } from '../src/lib/prisma'
import { finalizeCatalogPackageConfiguration } from '../src/lib/pricing/configuration-finalizer'
import {
  parseRepairArgs,
  buildRepairWhere,
  classifyRepairPackage,
  aggregateReasons,
  emptyRepairReport,
  formatRepairHeader,
  formatRepairReport,
  type RepairClassifiedPackage,
} from '../src/lib/catalog/repair-catalog-tooling'

async function main() {
  const parsed = parseRepairArgs(process.argv.slice(2))
  if (parsed.error) {
    console.error(parsed.error)
    console.error('Usage: --dry-run | --apply [--provider=CODE] [--publish-status=STATUS|--published-only] [--package-id=ID] [--require-retail-link] [--all]')
    process.exit(2)
  }

  const { mode, filters } = parsed
  console.log(formatRepairHeader(mode, filters).join('\n'))

  const where = buildRepairWhere(filters)
  const packages = await prisma.providerPackage.findMany({
    where,
    include: {
      provider: { select: { status: true, enabledCapabilities: true, code: true, name: true } },
      publishedAs: { select: { id: true } },
    },
    orderBy: { name: 'asc' },
  })

  if (packages.length === 0) {
    console.log('Matched: 0 (no configured packages matched the filters)')
    console.log()
    console.log('NO DATABASE WRITE | NO PROVIDER CALL | NO PUBLISH | NO SYNC')
    await prisma.$disconnect()
    return
  }

  // Orphans (published, no linked retail ESIMPackage) — report only, never repaired.
  const orphans = await prisma.providerPackage.findMany({
    where: { ...buildRepairWhere({ ...filters, all: true, requireRetailLink: true, publishStatus: 'PUBLISHED' }), publishedAs: null },
    select: { id: true, name: true, provider: { select: { code: true } }, publishStatus: true, sellingPrice: true, configurationStatus: true },
  })

  const report = emptyRepairReport()
  const classified: RepairClassifiedPackage[] = []
  const beforeReasons: string[][] = []
  const afterReasons: string[][] = []

  for (const pp of packages) {
    const c = classifyRepairPackage(pp, { requireRetailLink: filters.requireRetailLink })
    classified.push(c)
    beforeReasons.push(c.ready ? [] : c.reasons)

    if (c.ready) { report.ready++; continue }
    if (c.missingRetailLink) {
      report.skippedMissingRetailLink++
      console.log(`  [SKIP missing retail link] ${c.providerCode || '?'} | ${c.name} (${c.id.slice(-8)}) — never repaired`)
      continue
    }
    if (c.repairable) {
      report.repairable++
      console.log(`  [REPAIRABLE] ${c.providerCode || '?'} | ${c.name} (${c.id.slice(-8)}): ${c.reasons.join('; ')}`)

      if (mode === 'apply') {
        report.attempted++
        const result = await finalizeCatalogPackageConfiguration(c.id, { reason: 'REPAIR' })
        if (result.success) {
          report.repaired++
          console.log(`    -> REPAIRED: snapshot=${result.snapshotId}`)
        } else {
          report.failed++
          console.log(`    -> FAILED at ${result.failedStage}: ${result.error}`)
        }
      }
    } else {
      report.notRepairable++
      console.log(`  [NOT REPAIRABLE] ${c.providerCode || '?'} | ${c.name} (${c.id.slice(-8)}): ${c.reasons.join('; ')}`)
      if (mode === 'apply') {
        // No pricing data to repair — clear the false CONFIGURED/PUBLISHED state.
        await prisma.providerPackage.update({
          where: { id: c.id },
          data: { configurationStatus: 'UNCONFIGURED', publishStatus: 'DRAFT' },
        }).catch(() => {})
        console.log(`    -> DOWNGRADED to UNCONFIGURED/DRAFT (no pricing data to repair)`)
        report.skipped++
      }
    }
  }

  report.matched = classified.length
  report.beforeReasons = aggregateReasons(beforeReasons)

  // After verification (apply only) — re-read repaired candidates.
  if (mode === 'apply') {
    const repairedIds = classified.filter(c => c.repairable).map(c => c.id)
    if (repairedIds.length > 0) {
      const refreshed = await prisma.providerPackage.findMany({
        where: { id: { in: repairedIds } },
        include: { provider: { select: { status: true, enabledCapabilities: true, code: true } }, publishedAs: { select: { id: true } } },
      })
      for (const pp of refreshed) {
        const after = classifyRepairPackage(pp, { requireRetailLink: filters.requireRetailLink })
        afterReasons.push(after.ready ? [] : after.reasons)
        if (after.ready) {
          console.log(`  [AFTER: READY] ${after.providerCode || '?'} | ${after.name} (${after.id.slice(-8)})`)
        } else {
          report.stillBlocked++
          console.log(`  [AFTER: BLOCKED] ${after.providerCode || '?'} | ${after.name} (${after.id.slice(-8)}): ${after.reasons.join('; ')}`)
        }
      }
    }
    report.afterReasons = aggregateReasons(afterReasons)
  }

  console.log('\n--- Results ---')
  console.log(formatRepairReport(report).join('\n'))

  console.log('\n--- Orphans (published, no linked ESIMPackage) — REPORT ONLY, NOT REPAIRED ---')
  console.log(`Orphan count: ${orphans.length}`)
  for (const o of orphans) {
    console.log(`  ${o.provider?.code || '?'} | ${o.name} (${o.id.slice(-8)}) publishStatus=${o.publishStatus} config=${o.configurationStatus} sellingPrice=${o.sellingPrice ?? 'null'}`)
  }

  console.log()
  console.log(mode === 'dry-run'
    ? 'NO DATABASE WRITE | NO PROVIDER CALL | NO PUBLISH | NO SYNC'
    : 'APPLY COMPLETE | NO PROVIDER CALL | NO PUBLISH | NO SYNC')

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
