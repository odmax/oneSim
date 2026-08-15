import { prisma } from '@/lib/prisma'
import { hasUsableInstallData } from '@/lib/esim/installation-data'
import { lookupEsimInstallationData, persistInstallationLookup } from '@/lib/providers/installation-lookup'

const RETRY_WINDOWS = [
  { maxMinutes: 10, intervalMinutes: 1 },
  { maxMinutes: 60, intervalMinutes: 5 },
  { maxMinutes: 1440, intervalMinutes: 30 },
]

/**
 * Bounded retry budget = one attempt per backoff slot across the full schedule:
 * 10 × 1 min + 12 × 5 min + 48 × 30 min = 70 attempts ≈ 24h of reconciliation.
 * STALE is reached when this budget is exhausted. This is the sole STALE
 * boundary: no time-based condition is used (esim.createdAt and
 * installationLastCheckedAt are never treated as "reconciliation age").
 */
export const MAX_INSTALLATION_RETRIES = RETRY_WINDOWS.reduce(
  (sum, w) => sum + Math.floor(w.maxMinutes / w.intervalMinutes),
  0,
) // 10 + 12 + 48 = 70

/**
 * Backoff interval AFTER `retryCount` failed attempts:
 *   retryCount 0–9   → 1 min  (first ~10 minutes)
 *   retryCount 10–21 → 5 min  (10–70 minutes)
 *   retryCount 22+   → 30 min (up to the 24h budget)
 */
export function getRetryInterval(retryCount: number): number {
  let remaining = retryCount
  for (const w of RETRY_WINDOWS) {
    const attemptsInWindow = Math.floor(w.maxMinutes / w.intervalMinutes)
    if (remaining < attemptsInWindow) return w.intervalMinutes
    remaining -= attemptsInWindow
  }
  return RETRY_WINDOWS[RETRY_WINDOWS.length - 1].intervalMinutes // 30
}

function isDueForRetry(lastChecked: Date | null, retryCount: number): boolean {
  if (!lastChecked) return true
  const intervalMs = getRetryInterval(retryCount) * 60 * 1000
  return Date.now() - lastChecked.getTime() > intervalMs
}

/**
 * STALE means "we attempted reconciliation repeatedly and could not recover
 * installation data". It is reached ONLY when the bounded retry budget is
 * exhausted (`retryCount >= MAX_INSTALLATION_RETRIES`). The raw eSIM createdAt
 * is never a pre-attempt cutoff, and installationLastCheckedAt is never
 * interpreted as "reconciliation age" (it is rewritten on every attempt, so it
 * would reset under normal cron cadence).
 */
function isStale(retryCount: number): boolean {
  return retryCount >= MAX_INSTALLATION_RETRIES
}

/**
 * Requeue legacy STALE rows that were incorrectly marked STALE by the old logic
 * without ever attempting reconciliation.
 *
 * This signature — STALE + retryCount=0 + never checked + no error + no install
 * data — proves the row was marked stale before any recovery attempt, so it is
 * safe to return to PENDING for a real attempt. Genuinely exhausted STALE rows
 * (retryCount > 0) are never touched. Idempotent: after requeue, the row no
 * longer matches (installationLastCheckedAt becomes set once it is processed).
 */
export async function repairLegacyStaleInstallationRows(): Promise<number> {
  const result = await prisma.eSIM.updateMany({
    where: {
      installationStatus: 'STALE',
      installationRetryCount: 0,
      installationLastCheckedAt: null,
      installationLastError: null,
      AND: [
        { OR: [{ qrCode: null }, { qrCode: '' }] },
        { OR: [{ qrCodeUrl: null }, { qrCodeUrl: '' }] },
        { OR: [{ activationCode: null }, { activationCode: '' }] },
        { OR: [{ smdpAddress: null }, { smdpAddress: '' }] },
        { OR: [{ matchingId: null }, { matchingId: '' }] },
      ],
    },
    data: { installationStatus: 'PENDING' },
  })
  return result.count
}

/**
 * Provider-neutral installation reconciliation. Delegates the read-only lookup
 * to the canonical `lookupEsimInstallationData` service; no provider-name
 * branches; never purchases/subscribes/mutates wallet; never creates eSIMs.
 */
export async function reconcileMissingInstallationDetails(batchSize = 10): Promise<{
  processed: number; updated: number; failed: number; stale: number; notSupported: number
}> {
  // Requeue legacy rows marked STALE by the old eSIM-age logic before processing.
  await repairLegacyStaleInstallationRows()

  const esims = await prisma.eSIM.findMany({
    where: {
      installationStatus: 'PENDING',
      purchase: { status: { notIn: ['FAILED', 'CANCELLED', 'REFUNDED'] } },
    },
    include: { purchase: { select: { package: { select: { providerId: true } } } } },
    take: batchSize,
    orderBy: { installationRetryCount: 'asc' },
  })

  let updated = 0; let failed = 0; let stale = 0; let notSupported = 0

  for (const esim of esims) {
    if (!isDueForRetry(esim.installationLastCheckedAt, esim.installationRetryCount)) continue

    // 1. Already-usable normalized install data → READY (never regresses).
    if (hasUsableInstallData(esim)) {
      await prisma.eSIM.update({ where: { id: esim.id }, data: { installationStatus: 'READY', installationLastCheckedAt: new Date() } })
      updated++
      continue
    }

    // 2. STALE only after the retry budget is exhausted (never raw eSIM age,
    //    never time-since-last-attempt).
    if (isStale(esim.installationRetryCount)) {
      await prisma.eSIM.update({ where: { id: esim.id }, data: { installationStatus: 'STALE' } })
      stale++
      continue
    }

    // 3. Canonical read-only lookup (provider resolution happens inside the
    //    service via purchase.package.providerId; connector decides support).
    let lookup
    try {
      lookup = await lookupEsimInstallationData(esim.id)
    } catch (e: any) {
      lookup = { esimId: esim.id, success: false, state: 'NOT_AVAILABLE_YET', errorCode: 'PROVIDER_HTTP_ERROR' } as any
    }

    switch (lookup.state) {
      case 'READY': {
        if (lookup.data && hasUsableInstallData(lookup.data)) {
          await persistInstallationLookup(esim.id, esim, lookup.data)
        }
        await prisma.eSIM.update({
          where: { id: esim.id },
          data: { installationStatus: 'READY', installationLastCheckedAt: new Date(), installationRetryCount: 0, installationLastError: null },
        })
        updated++
        break
      }
      case 'NOT_SUPPORTED': {
        await prisma.eSIM.update({
          where: { id: esim.id },
          data: { installationStatus: 'NOT_SUPPORTED', installationLastCheckedAt: new Date(), installationLastError: lookup.errorCode || 'LOOKUP_NOT_SUPPORTED' },
        })
        notSupported++
        break
      }
      case 'NOT_RECOVERABLE': {
        // Historical install data cannot be recovered read-only (e.g. Choice:
        // install data comes from the activation response, not package_detail).
        // This is a DISTINCT terminal state — the provider is NOT globally
        // NOT_SUPPORTED because NEW purchases still capture install data.
        await prisma.eSIM.update({
          where: { id: esim.id },
          data: { installationStatus: 'NOT_RECOVERABLE', installationLastCheckedAt: new Date(), installationLastError: lookup.errorCode || 'INSTALL_DATA_NOT_RECOVERABLE' },
        })
        failed++
        break
      }
      case 'PERMANENT_FAILURE': {
        await prisma.eSIM.update({
          where: { id: esim.id },
          data: { installationStatus: 'FAILED', installationLastCheckedAt: new Date(), installationLastError: lookup.errorCode || 'PERMANENT_FAILURE' },
        })
        failed++
        break
      }
      case 'NOT_AVAILABLE_YET':
      default: {
        await prisma.eSIM.update({
          where: { id: esim.id },
          data: {
            installationRetryCount: { increment: 1 },
            installationLastCheckedAt: new Date(),
            installationLastError: lookup.errorCode || 'NO_INSTALL_DATA',
          },
        })
        failed++
        break
      }
    }
  }

  return { processed: esims.length, updated, failed, stale: stale, notSupported }
}
