import { prisma } from '@/lib/prisma'
import { getAdapterForType } from '@/lib/providers/adapter-manager'
import { hasUsableInstallData, extractInstallDataFromProviderResponse, normalizeConnectorInstallData, mergeInstallData } from '@/lib/esim/installation-data'

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

/** True when a connector definitively reports the operation is not supported. */
function isDefinitiveUnsupported(error?: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  const code = error.code || ''
  return code === 'NOT_SUPPORTED' || code === 'NOT_IMPLEMENTED' || /not support|not implemented/i.test(error.message || '')
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

    // 3. Provider resolution — canonical chain: esim.purchaseId → purchase.packageId → package.providerId.
    const providerId = esim.purchase?.package?.providerId
    if (!providerId) continue

    const provider = await prisma.provider.findUnique({ where: { id: providerId } })
    if (!provider) continue

    try {
      let found = false
      let lookupAttempted = false
      let lookupUnsupported = false

      // 4. Read-only install lookup via the provider's connector (never a
      //    purchase/subscription mutation, never a wallet/order touch). The
      //    attempt is gated on having an ICCID only — a stale `supportsQRCode`
      //    boolean must not block an implemented connector capability; the
      //    connector itself decides support via its response.
      if (esim.iccid) {
        const adapter = await getAdapterForType(provider.type, {
          apiBaseUrl: provider.apiBaseUrl, apiToken: provider.apiToken,
          providerId: provider.id, environment: provider.environment, authUrl: provider.authUrl,
        })
        if (adapter?.getQRCode) {
          lookupAttempted = true
          const qrResult = await adapter.getQRCode(esim.iccid)
          if (qrResult.success && qrResult.data) {
            const installData = normalizeConnectorInstallData(qrResult.data)
            const merged = mergeInstallData(esim, installData)
            if (hasUsableInstallData(merged)) {
              await prisma.eSIM.update({
                where: { id: esim.id },
                data: {
                  ...(installData.qrCodeUrl && !esim.qrCodeUrl ? { qrCodeUrl: installData.qrCodeUrl } : {}),
                  ...(installData.qrCode && !esim.qrCode ? { qrCode: installData.qrCode } : {}),
                  ...(installData.activationCode && !esim.activationCode ? { activationCode: installData.activationCode } : {}),
                  ...(installData.smdpAddress && !esim.smdpAddress ? { smdpAddress: installData.smdpAddress } : {}),
                  ...(installData.matchingId && !esim.matchingId ? { matchingId: installData.matchingId } : {}),
                  installationStatus: 'READY', installationLastCheckedAt: new Date(),
                },
              })
              found = true
              updated++
            }
          } else if (isDefinitiveUnsupported(qrResult.error)) {
            lookupUnsupported = true
          }
        }
      }

      // 5. Stored providerResponse whitelist (data saved at purchase time).
      if (!found) {
        const extracted = extractInstallDataFromProviderResponse(esim.providerResponse)
        const merged = mergeInstallData(esim, extracted)
        if (hasUsableInstallData(merged)) {
          await prisma.eSIM.update({
            where: { id: esim.id },
            data: {
              ...(extracted.activationCode && !esim.activationCode ? { activationCode: extracted.activationCode } : {}),
              ...(extracted.qrCodeUrl && !esim.qrCodeUrl ? { qrCodeUrl: extracted.qrCodeUrl } : {}),
              ...(extracted.qrCode && !esim.qrCode ? { qrCode: extracted.qrCode } : {}),
              ...(extracted.smdpAddress && !esim.smdpAddress ? { smdpAddress: extracted.smdpAddress } : {}),
              ...(extracted.matchingId && !esim.matchingId ? { matchingId: extracted.matchingId } : {}),
              installationStatus: 'READY', installationLastCheckedAt: new Date(),
            },
          })
          found = true
          updated++
        }
      }

      if (!found) {
        // Permanent NOT_SUPPORTED comes from the connector itself (or from the
        // provider declaring no QR capability when no lookup could be made).
        // Otherwise it is a retryable miss — bounded by the stale policy.
        if (lookupUnsupported || (!lookupAttempted && !provider.supportsQRCode)) {
          await prisma.eSIM.update({ where: { id: esim.id }, data: { installationStatus: 'NOT_SUPPORTED' } })
          notSupported++
        } else {
          await prisma.eSIM.update({
            where: { id: esim.id },
            data: { installationRetryCount: { increment: 1 }, installationLastCheckedAt: new Date() },
          })
          failed++
        }
      }
    } catch (e: any) {
      const isPermanent = e.code === 'NOT_SUPPORTED' || e.message?.includes('permanent')
      await prisma.eSIM.update({
        where: { id: esim.id },
        data: {
          installationRetryCount: { increment: 1 },
          installationLastCheckedAt: new Date(),
          installationLastError: e.message?.substring(0, 200),
          ...(isPermanent ? { installationStatus: 'FAILED' } : {}),
        },
      })
      if (isPermanent) failed++
    }
  }

  return { processed: esims.length, updated, failed, stale: stale, notSupported }
}
