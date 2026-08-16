import { prisma } from '@/lib/prisma'
import { getStatusNextSync, getUsageNextSync, shouldStopRetrying } from '../sync-policy'
import { claimEsimForSync } from '../recurring-jobs'
import type { IProviderConnector } from '@/lib/providers/connectors/connector-interface'
import { deriveEsimLifecycleStatus } from '@/lib/services/esims/lifecycle-status'
import { capabilitySupported, resolveStatusLookup, resolveUsageLookup, buildProviderConnector } from '@/lib/services/esims/sync-lookup'

async function getConnector(providerId: string): Promise<IProviderConnector | null> {
  return buildProviderConnector(providerId)
}

function maskIccid(iccid: string | null | undefined): string {
  if (!iccid) return ''
  return iccid.length <= 8 ? '****' : `${iccid.slice(0, 4)}••••${iccid.slice(-4)}`
}

/** Backfill null sync schedules for existing eSIMs. Idempotent. */
export async function backfillEsimSyncSchedules(): Promise<void> {
  const now = new Date()
  await prisma.eSIM.updateMany({
    where: { statusNextSyncAt: null, status: { in: ['PENDING', 'PENDING_ACTIVATION', 'PROCESSING', 'PROVISIONING', 'RESERVED'] }, createdAt: { gte: new Date(now.getTime() - 86400000) } },
    data: { statusNextSyncAt: new Date(now.getTime() + 60000) },
  }).catch(() => {})
  await prisma.eSIM.updateMany({
    where: { statusNextSyncAt: null, status: { in: ['ACTIVE', 'INSTALLED', 'INSTALLING'] } },
    data: { statusNextSyncAt: new Date(now.getTime() + 3600000) },
  }).catch(() => {})
  await prisma.eSIM.updateMany({
    where: { usageNextSyncAt: null, status: { in: ['ACTIVE', 'INSTALLED'] }, dataTotalMB: null },
    data: { usageNextSyncAt: new Date(now.getTime() + 3600000) },
  }).catch(() => {})
  await prisma.eSIM.updateMany({
    where: { status: { in: ['FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED'] }, statusNextSyncAt: { not: null } },
    data: { statusNextSyncAt: null, usageNextSyncAt: null },
  }).catch(() => {})
}

export async function executeStatusSynchronization(batchSize = 20): Promise<{ processed: number; updated: number; failed: number; skipped: number }> {
  const now = new Date()
  const esims = await prisma.eSIM.findMany({
    where: {
      statusNextSyncAt: { lte: now },
      status: { notIn: ['FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED'] },
    },
    include: { purchase: { select: { package: { select: { providerId: true } } } } },
    take: batchSize,
    orderBy: { statusSyncRetryCount: 'asc' },
  })

  let updated = 0; let failed = 0; let skipped = 0

  for (const esim of esims) {
    if (!await claimEsimForSync(esim.id, 'statusNextSyncAt')) continue

    const providerId = esim.purchase?.package?.providerId
    if (!providerId) { skipped++; continue }

    const provider = await prisma.provider.findUnique({ where: { id: providerId } })
    if (!provider || !['ACTIVE', 'DEGRADED', 'TESTING'].includes(provider.status)) { skipped++; continue }

    const connectorName = provider.adapterStrategy || provider.type || 'UNKNOWN'

    try {
      const connector = await getConnector(provider.id)
      if (!connector) { skipped++; continue }

      // Capability gate: only call connectors that declare status lookup support.
      if (!capabilitySupported(connector, 'statusLookup')) {
        console.log(`[ESIM_STATUS_SYNC_SKIP] providerId=${providerId} connector=${connectorName} esimId=${esim.id} reason=STATUS_CAPABILITY_NOT_SUPPORTED`)
        // Stop polling unsupported providers instead of counting endless failures.
        await prisma.eSIM.update({ where: { id: esim.id }, data: { statusNextSyncAt: null, statusSyncRetryCount: 0 } })
        skipped++
        continue
      }

      // SAFE provider-neutral identifier — never a local OneSIM database id.
      const lookup = resolveStatusLookup(connector, esim)
      if (!lookup.ok) {
        console.log(`[ESIM_STATUS_SYNC_SKIP] providerId=${providerId} connector=${connectorName} esimId=${esim.id} reason=${lookup.skipReason}`)
        skipped++
        continue
      }

      const result = await connector.getStatus(lookup.identifier)

      if (result.success && result.data) {
        const providerStatus = result.data.status
        // Canonical lifecycle derivation: evidence-aware, monotonic (never
        // regress ACTIVE → PENDING without explicit evidence).
        const lifecycle = deriveEsimLifecycleStatus({
          providerNormalizedStatus: providerStatus,
          currentStatus: esim.status,
          dataUsedMB: esim.dataUsedMB || 0,
          activatedAt: esim.activatedAt,
        })
        const newStatus = lifecycle.status
        const updateData: any = {
          status: newStatus,
          providerStatus: (result.data as any).providerStatus || providerStatus || null,
          lastStatusSyncAt: new Date(),
          statusNextSyncAt: getStatusNextSync(newStatus, 0),
          statusSyncRetryCount: 0,
          providerResponse: {
            ...((esim as any).providerResponse && typeof (esim as any).providerResponse === 'object' ? (esim as any).providerResponse : {}),
            evidence: lifecycle.reason,
            evidenceObservedAt: new Date().toISOString(),
          },
        }
        if (lifecycle.setActivatedAt && !esim.activatedAt) {
          updateData.activatedAt = new Date()
          updateData.activationDetectedAt = new Date()
        }
        await prisma.eSIM.update({ where: { id: esim.id }, data: updateData })
        updated++
      } else {
        const errCode = result.error?.code || 'UNKNOWN'
        const stop = shouldStopRetrying(esim.statusSyncRetryCount + 1, errCode)
        console.log(`[ESIM_STATUS_SYNC_FAILURE] providerId=${providerId} connector=${connectorName} iccid=${maskIccid(esim.iccid)} errorCode=${errCode} retryCount=${esim.statusSyncRetryCount + 1} stopRetrying=${stop}`)
        await prisma.eSIM.update({
          where: { id: esim.id },
          data: {
            statusSyncRetryCount: { increment: 1 },
            ...(stop ? { statusNextSyncAt: null } : { statusNextSyncAt: getStatusNextSync(esim.status, esim.statusSyncRetryCount + 1) }),
          },
        })
        failed++
      }
    } catch (e: any) {
      console.log(`[ESIM_STATUS_SYNC_FAILURE] providerId=${providerId} connector=${connectorName} iccid=${maskIccid(esim.iccid)} errorCode=THROWN retryCount=${esim.statusSyncRetryCount + 1} stopRetrying=${shouldStopRetrying(esim.statusSyncRetryCount + 1)}`)
      await prisma.eSIM.update({ where: { id: esim.id }, data: { statusSyncRetryCount: { increment: 1 }, statusNextSyncAt: getStatusNextSync(esim.status, esim.statusSyncRetryCount + 1) } })
      failed++
    }
  }

  console.log(`[ESIM_STATUS_SYNC] processed=${esims.length} updated=${updated} failed=${failed} skipped=${skipped}`)
  return { processed: esims.length, updated, failed, skipped }
}

export async function executeUsageSynchronization(batchSize = 20): Promise<{ processed: number; updated: number; failed: number; skipped: number }> {
  const now = new Date()
  const esims = await prisma.eSIM.findMany({
    where: {
      usageNextSyncAt: { lte: now },
      status: { in: ['ACTIVE', 'INSTALLED', 'SUSPENDED'] },
    },
    include: { purchase: { select: { package: { select: { providerId: true } } } } },
    take: batchSize,
    orderBy: { usageSyncRetryCount: 'asc' },
  })

  let updated = 0; let failed = 0; let skipped = 0

  for (const esim of esims) {
    if (!await claimEsimForSync(esim.id, 'usageNextSyncAt')) continue

    const providerId = esim.purchase?.package?.providerId
    if (!providerId) { skipped++; continue }

    const provider = await prisma.provider.findUnique({ where: { id: providerId } })
    if (!provider) { skipped++; continue }

    const connectorName = provider.adapterStrategy || provider.type || 'UNKNOWN'

    try {
      const connector = await getConnector(provider.id)
      if (!connector) { skipped++; continue }

      // Capability gate: only call connectors that declare usage lookup support.
      if (!capabilitySupported(connector, 'usageLookup')) {
        console.log(`[ESIM_USAGE_SYNC_SKIP] providerId=${providerId} connector=${connectorName} esimId=${esim.id} reason=USAGE_CAPABILITY_NOT_SUPPORTED`)
        // Stop polling unsupported providers instead of counting endless failures.
        await prisma.eSIM.update({ where: { id: esim.id }, data: { usageNextSyncAt: null, usageSyncRetryCount: 0 } })
        skipped++
        continue
      }

      // SAFE provider-neutral identifier — never a local OneSIM database id.
      const lookup = resolveUsageLookup(connector, esim)
      if (!lookup.ok) {
        console.log(`[ESIM_USAGE_SYNC_SKIP] providerId=${providerId} connector=${connectorName} esimId=${esim.id} reason=${lookup.skipReason}`)
        skipped++
        continue
      }

      const result = await connector.getUsage(lookup.identifier as any)

      if (result.success && result.data) {
        const data = result.data as any
        await prisma.eSIM.update({
          where: { id: esim.id },
          data: {
            dataUsedMB: Math.round(data.dataUsedMB || 0),
            dataRemainingMB: data.dataRemainingMB != null ? Math.round(data.dataRemainingMB) : undefined,
            dataTotalMB: data.dataTotalMB != null ? Math.round(data.dataTotalMB) : undefined,
            lastUsageSyncAt: new Date(),
            usageNextSyncAt: getUsageNextSync(esim.status, 0),
            usageSyncRetryCount: 0,
          },
        })
        updated++
      } else {
        const stop = shouldStopRetrying(esim.usageSyncRetryCount + 1)
        console.log(`[ESIM_USAGE_SYNC_FAILURE] providerId=${providerId} connector=${connectorName} iccid=${maskIccid(esim.iccid)} errorCode=${result.error?.code || 'UNKNOWN'} retryCount=${esim.usageSyncRetryCount + 1} stopRetrying=${stop}`)
        await prisma.eSIM.update({
          where: { id: esim.id },
          data: {
            usageSyncRetryCount: { increment: 1 },
            ...(stop ? { usageNextSyncAt: null } : { usageNextSyncAt: getUsageNextSync(esim.status, esim.usageSyncRetryCount + 1) }),
          },
        })
        failed++
      }
    } catch (e: any) {
      console.log(`[ESIM_USAGE_SYNC_FAILURE] providerId=${providerId} connector=${connectorName} iccid=${maskIccid(esim.iccid)} errorCode=THROWN retryCount=${esim.usageSyncRetryCount + 1} stopRetrying=${shouldStopRetrying(esim.usageSyncRetryCount + 1)}`)
      await prisma.eSIM.update({ where: { id: esim.id }, data: { usageSyncRetryCount: { increment: 1 }, usageNextSyncAt: getUsageNextSync(esim.status, esim.usageSyncRetryCount + 1) } })
      failed++
    }
  }

  console.log(`[ESIM_USAGE_SYNC] processed=${esims.length} updated=${updated} failed=${failed} skipped=${skipped}`)
  return { processed: esims.length, updated, failed, skipped }
}
