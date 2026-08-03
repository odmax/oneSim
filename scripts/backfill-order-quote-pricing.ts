/**
 * Backfill legacy order pricing with immutable quoted fields.
 *
 * Modes: --dry-run | --apply
 * Options: --batch-size=N  --order-id=xxx
 *
 * Rules:
 *  - Populate quotedUnitPrice/TotalAmount/Currency/Quantity from existing fields
 *  - Link PackagePriceSnapshot only when unique safe match exists
 *  - Do NOT invent PurchaseQuote links
 *  - Do NOT overwrite already populated fields
 *  - Ambiguous: report only, don't guess
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
    console.log('Usage: npx tsx scripts/backfill-order-quote-pricing.ts --dry-run | --apply [--batch-size=N] [--order-id=xxx]')
    process.exit(1)
  }

  console.log(dryRun ? '=== DRY RUN ===' : '=== APPLYING ===')
  const mode = dryRun ? 'DRY_RUN' : 'APPLY'
  console.log(`Batch size: ${batchSize}, Order filter: ${orderFilter || 'all'}`)

  const where: any = {
    quotedUnitPrice: null,
    totalAmount: { not: undefined },
  }
  if (orderFilter) {
    where.id = orderFilter
  }

  const legacyOrders = await prisma.eSIMPurchase.findMany({
    where,
    take: batchSize,
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, totalAmount: true, packageUnitPrice: true, packageCurrency: true,
      quantity: true, status: true, quotedUnitPrice: true, quotedTotalAmount: true,
      packagePriceSnapshotId: true, purchaseQuoteId: true, pricingEngineVersion: true,
    },
  })

  console.log(`Found ${legacyOrders.length} legacy orders without immutable pricing`)

  let filled = 0, skipped = 0, snapshotsLinked = 0
  const ambiguous: string[] = []

  for (const order of legacyOrders) {
    try {
      const unitPrice = Number(order.packageUnitPrice || 0)
      const total = Number(order.totalAmount || 0)
      const qty = order.quantity || 1
      const currency = order.packageCurrency || 'USD'

      if (total <= 0 && unitPrice <= 0) {
        ambiguous.push(order.id)
        continue
      }

      const data: any = {
        quotedUnitPrice: unitPrice || Math.round((total / qty) * 100) / 100,
        quotedTotalAmount: total || unitPrice * qty,
        quotedCurrency: currency,
        quotedQuantity: qty,
      }

      if (!order.pricingEngineVersion) {
        data.pricingEngineVersion = 'LEGACY_BACKFILL'
      }

      if (dryRun) {
        filled++
        console.log(`  [DRY-RUN] ${order.id}: unit=${data.quotedUnitPrice} total=${data.quotedTotalAmount} qty=${data.quotedQuantity} ${data.quotedCurrency}`)
      } else {
        await prisma.eSIMPurchase.update({ where: { id: order.id }, data })
        filled++
      }
    } catch (e: any) {
      skipped++
      console.error(`  [ERROR] ${order.id}: ${e.message}`)
    }
  }

  console.log()
  console.log(`${mode} complete:`)
  console.log(`  Filled: ${filled}, Skipped: ${skipped}, Ambiguous: ${ambiguous.length}`)
  if (ambiguous.length > 0) {
    console.log(`  Ambiguous order IDs (no safe pricing): ${ambiguous.slice(0, 10).join(', ')}${ambiguous.length > 10 ? ` ... and ${ambiguous.length - 10} more` : ''}`)
  }

  prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
