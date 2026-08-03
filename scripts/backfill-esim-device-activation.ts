/**
 * Backfill script: repair eSIM lifecycle status from provider data.
 *
 * Rules:
 *  ACTIVE + activatedAt=null + dataUsedMB=0 → PENDING_ACTIVATION
 *  ACTIVE + dataUsedMB>0 → keep ACTIVE, set activatedAt from lastUsageAt
 *  SUSPENDED/EXPIRED + dataUsedMB>0 + activatedAt=null → set activatedAt from lastUsageAt
 *  NEVER change FAILED/CANCELLED
 *
 * Usage:
 *   npx tsx scripts/backfill-esim-device-activation.ts --dry-run
 *   npx tsx scripts/backfill-esim-device-activation.ts --apply
 */

import { prisma } from '../src/lib/prisma'

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const apply = process.argv.includes('--apply')

  if (!dryRun && !apply) {
    console.log('Usage: npx tsx scripts/backfill-esim-device-activation.ts --dry-run | --apply')
    process.exit(1)
  }

  console.log(dryRun ? '=== DRY RUN (no writes) ===' : '=== APPLYING ===')

  // All non-terminal eSIMs
  const candidates = await prisma.eSIM.findMany({
    where: {
      status: { in: ['ACTIVE', 'SUSPENDED', 'EXPIRED', 'PENDING_ACTIVATION'] },
    },
    select: { id: true, status: true, dataUsedMB: true, activatedAt: true, lastUsageAt: true },
  })

  const repairs: Array<{ id: string; from: string; to: string; reason: string }> = []
  let pendingFix = 0
  let activeKeep = 0
  let setActivated = 0
  let unchanged = 0

  for (const esim of candidates) {
    const hasUsage = (esim.dataUsedMB || 0) > 0
    const hasActivated = esim.activatedAt != null

    // ACTIVE + no activatedAt + no usage → PENDING_ACTIVATION
    if (esim.status === 'ACTIVE' && !hasActivated && !hasUsage) {
      pendingFix++
      repairs.push({ id: esim.id, from: 'ACTIVE', to: 'PENDING_ACTIVATION', reason: 'no-activation-evidence' })
      continue
    }

    // ACTIVE + usage but no activatedAt → stay ACTIVE, set activatedAt
    if (esim.status === 'ACTIVE' && !hasActivated && hasUsage) {
      setActivated++
      repairs.push({ id: esim.id, from: 'ACTIVE', to: 'ACTIVE (set activatedAt)', reason: 'usage-evidence' })
      continue
    }

    // SUSPENDED/EXPIRED with usage but no activatedAt
    if (['SUSPENDED', 'EXPIRED'].includes(esim.status) && !hasActivated && hasUsage) {
      setActivated++
      repairs.push({ id: esim.id, from: esim.status, to: esim.status + ' (set activatedAt)', reason: 'historic-usage' })
      continue
    }

    if (esim.status === 'ACTIVE') activeKeep++
    unchanged++
  }

  console.log(`  Total candidates: ${candidates.length}`)
  console.log(`  ACTIVE→PENDING_ACTIVATION (no evidence): ${pendingFix}`)
  console.log(`  ACTIVE with usage (keep + set activatedAt): ${setActivated}`)
  console.log(`  ACTIVE already ok: ${activeKeep}`)
  console.log(`  Other unchanged: ${unchanged - activeKeep}`)
  console.log()

  if (dryRun) {
    console.log(`Would apply ${repairs.length} changes.`)
    for (const r of repairs.slice(0, 5)) {
      console.log(`  eSIM ${r.id}  ${r.from} → ${r.to}  (${r.reason})`)
    }
    if (repairs.length > 5) console.log(`  ... and ${repairs.length - 5} more`)
    return
  }

  // Apply
  let applied = 0
  for (const r of repairs) {
    const data: any = {}
    if (r.reason === 'no-activation-evidence') {
      data.status = 'PENDING_ACTIVATION'
    } else if (r.reason === 'usage-evidence' || r.reason === 'historic-usage') {
      const esim = candidates.find(e => e.id === r.id)!
      data.activatedAt = esim.lastUsageAt || new Date()
    }

    if (Object.keys(data).length) {
      await prisma.eSIM.update({ where: { id: r.id }, data } as any)
      applied++
    }
  }

  console.log(`Applied ${applied} changes.`)
  prisma.$disconnect()
}

main().catch(err => { console.error(err); process.exit(1) })
