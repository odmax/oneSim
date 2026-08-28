/**
 * AIRHUB / PROVIDER PRICING RECONCILIATION TOOL
 *
 * Canonical provider pricing reconciliation over a target provider's full
 * ProviderPackage catalog. DRY-RUN by default.
 *
 * Uses the shared reconciliation service (provider-pricing-reconciliation) whose
 * apply path reuses the canonical pricing engine (recalculatePackagePrice) and
 * the existing catalog-price sync for retail parity. It never auto-publishes,
 * never deletes, never creates retail rows, and never fabricates a selling
 * price. It does not hard-code provider names, plan ids, or markup values.
 *
 * Usage:
 *   npx tsx src/scripts/reconcile-airhub-pricing.ts
 *     -> DRY-RUN (zero writes), provider must resolve exactly to AIRHUB
 *   npx tsx src/scripts/reconcile-airhub-pricing.ts --apply
 *     -> conservative apply (auto classes only)
 *   npx tsx src/scripts/reconcile-airhub-pricing.ts --provider=AIRHUB
 *     -> explicit provider (must match exactly)
 *   npx tsx src/scripts/reconcile-airhub-pricing.ts --plan-id=<providerPlanId>
 *     -> narrow scope to one plan
 *   npx tsx src/scripts/reconcile-airhub-pricing.ts --class=UNPRICED_RULE_AVAILABLE
 *     -> narrow scope to one classification
 *
 * Safety:
 *   - --provider fails closed unless it resolves exactly to AIRHUB
 *   - --plan-id / --class only narrow the scan
 *   - UNPRICED_RULE_AVAILABLE, UNPRICED_NO_RULE, MISSING_RETAIL,
 *     MISSING_SNAPSHOT (no reconstructable policy), COST_UNAVAILABLE, and
 *     REQUIRES_PRICING are NEVER auto-applied. A matching active pricing rule
 *     is NOT package configuration intent.
 *   - Auto-apply is limited to genuine existing pricing drift on packages with
 *     established package-level intent: BELOW_COST_REPRICE, STALE_SNAPSHOT_COST,
 *     RETAIL_PARITY_MISMATCH (each subject to its safety prerequisites).
 */
import { PrismaClient } from '@prisma/client'
import {
  reconcileProviderCatalog,
  applyPackageReconciliation,
  type PackageReconciliationResult,
  type ReconciliationClassification,
} from '../lib/pricing/provider-pricing-reconciliation'

const prisma = new PrismaClient()

const APPLY = process.argv.includes('--apply')
const PROVIDER_FLAG = process.argv.find(a => a.startsWith('--provider='))?.split('=')[1]
const PLAN_ID = process.argv.find(a => a.startsWith('--plan-id='))?.split('=')[1]
const CLASS_FLAG = process.argv.find(a => a.startsWith('--class='))?.split('=')[1]

async function main() {
  console.log(`\n=== PROVIDER PRICING RECONCILIATION ${APPLY ? '(APPLY MODE)' : '(DRY-RUN)'} ===\n`)

  // Fail closed: provider must resolve exactly.
  const requestedCode = (PROVIDER_FLAG || 'AIRHUB').trim().toUpperCase()
  if (requestedCode !== 'AIRHUB') {
    console.log(`FAIL_CLOSED: requested provider "${PROVIDER_FLAG}" — only exact AIRHUB is supported by this tool.`)
    process.exit(2)
  }

  const provider = await prisma.provider.findFirst({ where: { code: 'AIRHUB' } })
  if (!provider) {
    console.log('FAIL_CLOSED: no exact AIRHUB provider found.')
    process.exit(2)
  }
  if ((provider.code || '').toUpperCase() !== 'AIRHUB') {
    console.log('FAIL_CLOSED: provider code mismatch.')
    process.exit(2)
  }

  const classification = CLASS_FLAG as ReconciliationClassification | undefined
  const summary = await reconcileProviderCatalog(provider.id, 'AIRHUB', provider.name || 'AirHub', {
    planId: PLAN_ID,
    classification,
  })

  console.log(`Provider: ${summary.providerName} (${summary.providerCode}) id=${summary.providerId}`)
  console.log(`Total scanned: ${summary.total}`)
  if (PLAN_ID) console.log(`Narrowed: --plan-id=${PLAN_ID}`)
  if (classification) console.log(`Narrowed: --class=${classification}`)
  console.log('')

  const nonOk = summary.rows.filter(r => !r.classifications.includes('OK'))
  for (const r of nonOk) {
    console.log(`• ${r.providerPlanId} — ${r.name}`)
    console.log(`    cost=${r.costPrice} selling=${r.sellingPrice ?? 'null'} markup=${r.markupPercent ?? 'null'}`)
    console.log(`    pricingStatus=${r.pricingStatus || 'null'} publishStatus=${r.publishStatus || 'null'}`)
    console.log(`    activeSnapshot=${r.hasActiveSnapshot ? (r.activeSnapshotId || 'present') : 'MISSING'} retail=${r.hasRetail ? 'linked' : 'none'}`)
    if (r.historicalSnapshotCost != null) console.log(`    snapshotCost=${r.historicalSnapshotCost}`)
    if (r.retailPriceUSD != null) console.log(`    retailPriceUSD=${r.retailPriceUSD}`)
    console.log(`    resolvedRule=${r.rule.resolvedRuleId || 'NONE'}`)
    console.log(`    classification=[${r.classifications.join(', ')}] action="${r.proposedAction}"`)
    console.log(`    applyAllowed=${r.applyAllowed ? 'YES' : 'NO'}`)
    console.log('')
  }

  console.log('=== SUMMARY ===')
  console.log(`TOTAL_SCANNED=${summary.total}`)
  console.log(`OK=${summary.counts.OK}`)
  console.log(`UNPRICED_RULE_AVAILABLE=${summary.counts.UNPRICED_RULE_AVAILABLE}`)
  console.log(`UNPRICED_NO_RULE=${summary.counts.UNPRICED_NO_RULE}`)
  console.log(`BELOW_COST_REPRICE=${summary.counts.BELOW_COST_REPRICE}`)
  console.log(`STALE_SNAPSHOT_COST=${summary.counts.STALE_SNAPSHOT_COST}`)
  console.log(`RETAIL_PARITY_MISMATCH=${summary.counts.RETAIL_PARITY_MISMATCH}`)
  console.log(`MISSING_RETAIL=${summary.counts.MISSING_RETAIL}`)
  console.log(`MISSING_SNAPSHOT=${summary.counts.MISSING_SNAPSHOT}`)
  console.log(`COST_UNAVAILABLE=${summary.counts.COST_UNAVAILABLE}`)
  console.log(`REQUIRES_PRICING=${summary.counts.REQUIRES_PRICING}`)

  if (APPLY) {
    let applied = 0
    let skipped = 0
    let failed = 0
    const failures: Array<{ providerPlanId: string; classification: string; error: string }> = []

    for (const row of summary.rows) {
      if (!row.applyAllowed) { skipped++; continue }
      const outcome = await applyPackageReconciliation(
        { id: row.id, providerPlanId: row.providerPlanId, publishStatus: row.publishStatus, classifications: row.classifications },
        row,
      )
      if (outcome.applied) applied++
      else if (outcome.error) {
        failed++
        const err = outcome.error || 'unknown'
        console.log(`FAIL ${row.providerPlanId} [${row.classifications.join('+')}] ${err}`)
        failures.push({ providerPlanId: row.providerPlanId, classification: row.classifications.join('+'), error: err })
      } else skipped++
    }

    summary.applied = applied
    summary.unchanged = skipped
    summary.failures = failures

    console.log(`APPLIED=${applied}`)
    console.log(`SKIPPED/MANUAL=${skipped}`)
    console.log(`FAILED=${failed}`)

    // Idempotency: rerunning --apply re-scan shows zero auto-applicable rows.
    const rerun = await reconcileProviderCatalog(provider.id, 'AIRHUB', provider.name || 'AirHub', {
      planId: PLAN_ID,
      classification,
    })
    const rerunAuto = rerun.rows.filter(r => r.applyAllowed).length
    console.log(`IDEMPOTENCY_CHECK: auto-applicable rows after apply = ${rerunAuto}`)
    console.log(`WRITES_PERFORMED=${applied}`)
  } else {
    console.log(`WRITES_PERFORMED=0`)
  }
  console.log(`MODE=${APPLY ? 'APPLY' : 'DRY-RUN'}\n`)

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })