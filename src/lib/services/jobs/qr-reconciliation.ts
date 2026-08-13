import { prisma } from '@/lib/prisma'
import { getAdapterForType } from '@/lib/providers/adapter-manager'
import { hasUsableInstallData, extractInstallDataFromProviderResponse, type InstallDataFields } from '@/lib/esim/installation-data'

const RETRY_WINDOWS = [
  { maxMinutes: 10, intervalMinutes: 1 },
  { maxMinutes: 60, intervalMinutes: 5 },
  { maxMinutes: 1440, intervalMinutes: 30 },
]

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

function isStale(createdAt: Date, retryCount: number): boolean {
  const ageHours = (Date.now() - createdAt.getTime()) / 3600000
  return ageHours > 24 || retryCount > 10
}

export async function reconcileMissingInstallationDetails(batchSize = 10): Promise<{
  processed: number; updated: number; failed: number; stale: number; notSupported: number
}> {
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
    if (isStale(esim.createdAt, esim.installationRetryCount)) {
      await prisma.eSIM.update({ where: { id: esim.id }, data: { installationStatus: 'STALE' } })
      stale++
      continue
    }

    // Check if installation data already present from providerResponse
    if (hasUsableInstallData(esim)) {
      await prisma.eSIM.update({ where: { id: esim.id }, data: { installationStatus: 'READY', installationLastCheckedAt: new Date() } })
      updated++
      continue
    }

    const providerId = esim.purchase?.package?.providerId
    if (!providerId) continue

    const provider = await prisma.provider.findUnique({ where: { id: providerId } })
    if (!provider) continue

    try {
      let found = false

      // Try getQRCode if supported
      if (provider.supportsQRCode && esim.iccid) {
        const adapter = await getAdapterForType(provider.type, {
          apiBaseUrl: provider.apiBaseUrl, apiToken: provider.apiToken,
          providerId: provider.id, environment: provider.environment, authUrl: provider.authUrl,
        })
        if (adapter?.getQRCode) {
          const qrResult = await adapter.getQRCode(esim.iccid)
          if (qrResult.success && (qrResult.data?.qrCodeUrl || (qrResult.data as any)?.activationCode)) {
            const qrData = qrResult.data as any
            const installData: InstallDataFields = {
              qrCodeUrl: qrData.qrCodeUrl || undefined,
              qrCode: qrData.qrCode || undefined,
              activationCode: qrData.activationCode || undefined,
              smdpAddress: qrData.smdpAddress || undefined,
              matchingId: qrData.matchingId || undefined,
            }
            const merged = { activationCode: esim.activationCode || installData.activationCode, qrCodeUrl: esim.qrCodeUrl || installData.qrCodeUrl, qrCode: esim.qrCode || installData.qrCode, smdpAddress: esim.smdpAddress || installData.smdpAddress, matchingId: esim.matchingId || installData.matchingId }
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
          }
        }
      }

      // Check providerResponse for already-stored activation data
      if (!found) {
        const extracted = extractInstallDataFromProviderResponse(esim.providerResponse)
        const merged = { activationCode: esim.activationCode || extracted.activationCode, qrCodeUrl: esim.qrCodeUrl || extracted.qrCodeUrl, qrCode: esim.qrCode || extracted.qrCode, smdpAddress: esim.smdpAddress || extracted.smdpAddress, matchingId: esim.matchingId || extracted.matchingId }
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
        // Detect permanent NOT_SUPPORTED
        if (!provider.supportsQRCode) {
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
