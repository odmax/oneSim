/* eslint-disable no-console */
/**
 * HISTORICAL ORDER CANONICALIZATION REPAIR (dry-run by default).
 *
 * Operational surface for FIX B. Repairs persisted METADATA ONLY for legacy
 * FULFILLED orders and their eSIMs (see src/lib/services/orders/
 * historical-canonicalization.ts). It performs ZERO provider calls, ZERO wallet
 * mutations, ZERO dispatch/failover/reconciliation/fulfillment, and NO
 * transitionOrder. Provider identity is only ever backfilled from an
 * already-persisted, authoritative order.providerFulfillId (exact-C), never
 * inferred. Rerunnable: a second --apply pass produces zero additional material
 * changes.
 *
 * Options:
 *   --order-id <id>   limit to one order (optional)
 *   --batch-size <n>  bounded batch size (default 25)
 *   --apply           EXECUTE writes (default is dry-run)
 *
 * Output: deterministic counts + per-order reason codes. Never prints
 * providerFulfillId / ICCID / activationCode / credentials / raw payloads.
 */
import { canonicalizeHistoricalOrders } from '../src/lib/services/orders/historical-canonicalization'

function parseArgs(argv: string[]): { orderId?: string; batchSize?: number; apply: boolean } {
  const opts: { orderId?: string; batchSize?: number; apply: boolean } = { apply: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') opts.apply = true
    else if (a === '--order-id') opts.orderId = argv[++i]
    else if (a === '--batch-size') opts.batchSize = parseInt(argv[++i], 10) || undefined
  }
  return opts
}

export async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  console.log(`[HISTORICAL_REPAIR] mode=${opts.apply ? 'APPLY' : 'DRY-RUN'} orderId=${opts.orderId || '*'} batchSize=${opts.batchSize ?? 25}`)

  const result = await canonicalizeHistoricalOrders({
    orderId: opts.orderId,
    apply: opts.apply,
    batchSize: opts.batchSize,
  })

  console.log(`[HISTORICAL_REPAIR] scanned=${result.scanned} eligible=${result.eligible} repaired=${result.repaired} skipped=${result.skipped} conflicts=${result.conflicts} errors=${result.errors} dryRun=${result.dryRun}`)
  for (const o of result.outcomes) {
    console.log(`[HISTORICAL_REPAIR] orderId=${o.orderId} reason=${o.reason} repaired=${o.repaired}`)
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[HISTORICAL_REPAIR] fatal=${e?.message || e}`)
    process.exit(1)
  })
}