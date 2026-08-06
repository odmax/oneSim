/**
 * Backfill purchasable package readiness.
 * Reports which packages are ready and which are blocked, and why.
 *
 * Modes: --dry-run | --apply [--provider-code=xxx] [--package-id=xxx]
 */

import { prisma } from '../src/lib/prisma'
import { getPackagePurchaseReadiness } from '../src/lib/packages/purchase-readiness'

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const apply = args.includes('--apply')
  const codeIdx = args.indexOf('--provider-code')
  const codeFilter = codeIdx >= 0 ? args[codeIdx + 1]?.toUpperCase() : undefined
  const idIdx = args.indexOf('--package-id')
  const idFilter = idIdx >= 0 ? args[idIdx + 1] : undefined

  if (!dryRun && !apply) { console.log('Usage: --dry-run | --apply [--provider-code=xxx] [--package-id=xxx]'); process.exit(1) }
  console.log(dryRun ? '=== DRY RUN ===' : '=== APPLYING ===')

  const where: any = { isActive: true }
  if (idFilter) where.id = idFilter

  const packages = await prisma.eSIMPackage.findMany({
    where,
    include: {
      providerPackage: { select: { costStatus: true, pricingStatus: true, publishStatus: true, configurationStatus: true, activePriceSnapshotId: true, sellingPrice: true, costPrice: true } },
      provider: { select: { status: true, enabledCapabilities: true, code: true } },
    },
    orderBy: { displayName: 'asc' },
  })

  if (codeFilter) {
    const filtered = packages.filter(p => p.provider?.code?.toUpperCase() === codeFilter)
    console.log(`Filtered to ${codeFilter}: ${filtered.length} packages\n`)
    processResults(filtered, dryRun)
  } else {
    processResults(packages, dryRun)
  }

  prisma.$disconnect()
}

function processResults(pkgs: any[], dryRun: boolean) {
  let ready = 0, blockedByCost = 0, blockedByPrice = 0, blockedBySnapshot = 0, blockedByProvider = 0, blockedByConfig = 0

  for (const p of pkgs) {
    const r = getPackagePurchaseReadiness({ pkg: p, providerPkg: p.providerPackage, provider: p.provider })
    if (r.ready) {
      ready++
    } else {
      for (const reason of r.reasons) {
        if (reason.includes('Cost')) blockedByCost++
        else if (reason.includes('selling price')) blockedByPrice++
        else if (reason.includes('snapshot')) blockedBySnapshot++
        else if (reason.includes('Provider') && !reason.includes('PURCHASE')) blockedByProvider++
        else if (reason.includes('Configuration') || reason.includes('published')) blockedByConfig++
      }
    }
    if (!r.ready) {
      console.log(`  ${p.displayName || p.name} (${p.id.slice(-8)}): ${r.reasons.join('; ')}`)
    }
  }

  console.log(`\nTotal: ${pkgs.length}`)
  console.log(`  Ready: ${ready}`)
  console.log(`  Blocked by cost: ${blockedByCost}`)
  console.log(`  Blocked by selling price: ${blockedByPrice}`)
  console.log(`  Blocked by snapshot: ${blockedBySnapshot}`)
  console.log(`  Blocked by provider: ${blockedByProvider}`)
  console.log(`  Blocked by configuration: ${blockedByConfig}`)
}

main().catch(e => { console.error(e); process.exit(1) })
