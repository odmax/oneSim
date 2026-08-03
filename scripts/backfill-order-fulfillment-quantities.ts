/**
 * Backfill legacy order fulfillment quantities.
 *
 * Modes: --dry-run | --apply [--batch-size=N] [--order-id=xxx]
 */

import { prisma } from '../src/lib/prisma'

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const apply = args.includes('--apply')
  const batchIdx = args.indexOf('--batch-size')
  const batchSize = batchIdx >= 0 ? parseInt(args[batchIdx + 1] || '100', 10) : 100
  const orderIdx = args.indexOf('--order-id')
  const orderFilter = orderIdx >= 0 ? args[orderIdx + 1] : undefined

  if (!dryRun && !apply) {
    console.log('Usage: --dry-run | --apply [--batch-size=N] [--order-id=xxx]')
    process.exit(1)
  }

  console.log(dryRun ? '=== DRY RUN ===' : '=== APPLYING ===')

  const where: any = { fulfilledQuantity: 0 }
  if (orderFilter) where.id = orderFilter

  const orders = await prisma.eSIMPurchase.findMany({
    where,
    take: batchSize,
    orderBy: { createdAt: 'asc' },
    include: { esims: { select: { id: true, iccid: true } } },
  })

  const wallets = await prisma.walletTransaction.findMany({
    where: { orderId: { in: orders.map(o => o.id) } },
    select: { orderId: true, amount: true, type: true },
  })

  console.log(`Found ${orders.length} orders to backfill`)

  let filled = 0, completed = 0, skipped = 0
  const flagged: string[] = []

  for (const order of orders) {
    const requested = order.quotedQuantity ?? order.quantity ?? 1
    const uniqueIccids = new Set(order.esims.map(e => e.iccid).filter(Boolean))
    const fulfilled = Math.min(uniqueIccids.size, requested)

    const txs = wallets.filter(w => w.orderId === order.id)
    const captured = txs.filter(t => t.type === 'WALLET_CAPTURE').reduce((s, t) => s + Math.abs(Number(t.amount || 0)), 0)
    const released = txs.filter(t => t.type === 'WALLET_RELEASE').reduce((s, t) => s + Math.abs(Number(t.amount || 0)), 0)

    if (fulfilled > requested) {
      flagged.push(`${order.id}: fulfilled=${fulfilled} > requested=${requested}`)
      continue
    }

    const data: any = { fulfilledQuantity: fulfilled }
    if (order.status === 'FULFILLED' && !order.fulfillmentCompletedAt) {
      data.fulfillmentCompletedAt = order.updatedAt
    }
    if (captured > 0) data.capturedAmount = captured
    if (released > 0) data.releasedAmount = released

    if (dryRun) {
      filled++
      if (fulfilled >= requested) completed++
      console.log(`  [DRY-RUN] ${order.id.slice(-8)}: requested=${requested} fulfilled=${fulfilled} captured=${captured}`)
    } else {
      await prisma.eSIMPurchase.update({ where: { id: order.id }, data }).catch(() => skipped++)
      filled++
      if (fulfilled >= requested) completed++
    }
  }

  console.log()
  console.log(`${dryRun ? 'DRY_RUN' : 'APPLY'} complete:`)
  console.log(`  Filled: ${filled}, Skipped: ${skipped}, Completed: ${completed}`)
  if (flagged.length) console.log(`  Flagged (inconsistent): ${flagged.length}`)

  prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
