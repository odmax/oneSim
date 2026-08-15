import { prisma } from '@/lib/prisma'
import { getAdapterForType } from '@/lib/providers/adapter-manager'
import { hasUsableInstallData, extractInstallDataFromProviderResponse, normalizeConnectorInstallData, mergeInstallData } from '@/lib/esim/installation-data'

const RETRY_WINDOWS = [
  { maxMinutes: 10, intervalMinutes: 1 },
  { maxMinutes: 60, intervalMinutes: 5 },
  { maxMinutes: 1440, intervalMinutes: 30 },
]

export const MAX_INSTALLATION_RETRIES = 10
export const MAX_RECONCILIATION_AGE_HOURS = 24

function getRetryInterval(retryCount: number): number {
  let cumulative = 0
  let interval = 30 // default
  for (const w of RETRY_WINDOWS) {
    const remaining = retryCount - cumulative * Math.floor(w.maxMinutes / w.intervalMinutes)
    if (remaining <= 0) return w.intervalMinutes
    cumulative += Math.floor(w.maxMinutes / w.intervalMinutes)
  }
  return interval
}

function isDueForRetry(lastChecked: Date | null, retryCount: number): boolean {
  if (!lastChecked) return true
  const intervalMs = getRetryInterval(retryCount) * 60 * 1000
  return Date.now() - lastChecked.getTime() > intervalMs
}

/**
 * STALE must mean "we attempted reconciliation repeatedly / for too long and
 * could not recover installation data" — never "the eSIM itself is old".
 *
 * A PENDING record may become STALE only after reconciliation activity has
 * actually begun:
 *  - retries exhausted (`retryCount >= MAX_INSTALLATION_RETRIES`), OR
 *  - reconciliation has been running for more than
 *    `MAX_RECONCILIATION_AGE_HOURS`, measured from the LAST check (only rows
 *    that have been checked at least once can satisfy this).
 *
 * The raw `createdAt` is never used as a pre-attempt cutoff: a legacy eSIM
 * created before the reconciliation subsystem existed and never checked gets a
 * real recovery attempt regardless of its age.
 */
function isStale(retryCount: number, lastChecked: Date | null): boolean {
  if (retryCount >= MAX_INSTALLATION_RETRIES) return true
  if (lastChecked && (Date.now() - lastChecked.getTime()) > MAX_RECONCILIATION_AGE_HOURS * 3600_000) return true
  return false
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

    // 2. STALE only after reconciliation activity has begun (never raw eSIM age).
    if (isStale(esim.installationRetryCount, esim.installationLastCheckedAt)) {
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
