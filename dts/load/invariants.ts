import { prisma } from '../../src/lib/prisma'
import { Metrics } from './metrics'

/**
 * Post-run invariant checks executed directly against the load DB. Every count
 * must be 0 for a PASS; any >0 → RUN_STATUS=FAIL.
 */
export interface InvariantReport {
  duplicatesLogicalOrders: number
  duplicateWalletCaptures: number
  walletOverspend: number
  fulfilledWithoutIccid: number
  negativeWallets: number
  lostProviderReferences: number
  crossProviderFulfillment: number
  duplicateIccids: number
  /** Duplicate (orderId, attemptNumber) pairs — observational, not yet blocked by a unique index. */
  attemptNumberDuplicates: number
  runStatus: 'PASS' | 'FAIL'
}

type RawCount = Array<{ id?: string; orderId?: string }>

const q = async (sql: string, ids: string[]) => {
  return (await prisma.$queryRawUnsafe(sql, ids)) as unknown as RawCount
}

export async function checkDbInvariants(metrics: Metrics, orderIds: string[]): Promise<InvariantReport> {
  const ids = orderIds.length > 0 ? orderIds : ['__none__']

  const dupKeys = await q(
    `SELECT "providerPurchaseKey" FROM "esim_purchases" WHERE "providerPurchaseKey" LIKE '%:%' AND "id" = ANY($1::text[]) GROUP BY "providerPurchaseKey" HAVING COUNT(*) > 1`, ids)
  const dupCaptures = await q(
    `SELECT "orderId" FROM "wallet_transactions" WHERE "orderId" = ANY($1::text[]) AND "type" = 'WALLET_CAPTURE' GROUP BY "orderId" HAVING COUNT(*) > 1`, ids)
  const overspend = await q(
    `WITH tx AS (
        SELECT "orderId",
          SUM(CASE WHEN "type"='WALLET_CAPTURE' THEN "amount" ELSE 0 END) AS cap,
          SUM(CASE WHEN "type"='WALLET_RELEASE' THEN "amount" ELSE 0 END) AS rel,
          SUM(CASE WHEN "type"='WALLET_RESERVE' THEN ABS("amount") ELSE 0 END) AS res
        FROM "wallet_transactions" WHERE "orderId" = ANY($1::text[]) GROUP BY "orderId")
      SELECT "orderId" FROM tx WHERE cap - rel > res`, ids)
  const fulfilledNoEsim = await q(
    `SELECT o."id" FROM "esim_purchases" o
     LEFT JOIN "esims" e ON e."purchaseId" = o."id"
     WHERE o."id" = ANY($1::text[]) AND o."status" = 'FULFILLED'
     GROUP BY o."id" HAVING COUNT(e."id") = 0`, ids)
  const negativeWallets = await q(
    `SELECT "id" FROM "businesses" WHERE "walletBalance" < 0`, ids)
  const lostRefs = await q(
    `SELECT "id" FROM "esim_purchases" WHERE "id" = ANY($1::text[]) AND "status" = 'FULFILLED' AND "providerFulfillId" IS NULL`, ids)
  const crossProvider = await q(
    `SELECT DISTINCT pa."orderId" FROM "provider_attempts" pa
     JOIN "esim_purchases" o ON o."id" = pa."orderId"
     WHERE o."id" = ANY($1::text[]) AND o."status" = 'FULFILLED' AND pa."providerId" <> o."providerId"`, ids)
  const dupIccids = await q(
    `SELECT "iccid", COUNT(*)::int AS c FROM "esims" WHERE "purchaseId" = ANY($1::text[]) GROUP BY "iccid" HAVING COUNT(*) > 1`, ids)
  const attemptDupes = await q(
    `SELECT "orderId", "attemptNumber", COUNT(*)::int AS c
     FROM "provider_attempts" WHERE "orderId" = ANY($1::text[])
     GROUP BY "orderId", "attemptNumber" HAVING COUNT(*) > 1`, ids)

  const n = (rows: unknown[]) => (Array.isArray(rows) ? rows.length : 0)
  const report: InvariantReport = {
    duplicatesLogicalOrders: n(dupKeys as never[]),
    duplicateWalletCaptures: n(dupCaptures as never[]),
    walletOverspend: n(overspend as never[]),
    fulfilledWithoutIccid: n(fulfilledNoEsim as never[]),
    negativeWallets: n(negativeWallets as never[]),
    lostProviderReferences: n(lostRefs as never[]),
    crossProviderFulfillment: n(crossProvider as never[]),
    duplicateIccids: n(dupIccids as never[]),
    attemptNumberDuplicates: n(attemptDupes as never[]),
    runStatus: 'PASS',
  }
  const anyFail = report.duplicatesLogicalOrders > 0 || report.duplicateWalletCaptures > 0 || report.walletOverspend > 0
    || report.fulfilledWithoutIccid > 0 || report.negativeWallets > 0 || report.lostProviderReferences > 0
    || report.crossProviderFulfillment > 0 || report.duplicateIccids > 0
  report.runStatus = anyFail ? 'FAIL' : 'PASS'
  metrics.duplicatesLogicalOrders = report.duplicatesLogicalOrders
  metrics.duplicateWalletCaptures = report.duplicateWalletCaptures
  metrics.walletOverspend = report.walletOverspend
  metrics.fulfilledWithoutIccid = report.fulfilledWithoutIccid
  metrics.negativeWallets = report.negativeWallets
  metrics.lostProviderReferences = report.lostProviderReferences
  metrics.crossProviderFulfillment = report.crossProviderFulfillment
  metrics.duplicateIccids = report.duplicateIccids
  return report
}

/** Apply fake-boundary dispatch counter for authoritative duplicate-dispatch detection. */
export function checkFakeDispatchCounts(dispatchSeen: Map<string, number>, out: { duplicateProviderDispatches: number }): void {
  let dup = 0
  for (const [, count] of dispatchSeen) if (count > 1) dup += count - 1
  out.duplicateProviderDispatches = dup
}