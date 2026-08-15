'use server'

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import type { TelnaConnector } from '@/lib/providers/connectors/telna-connector'
import { startPipelineRun, recordStageFromCounts, completePipelineRun, failPipelineRun } from '@/lib/catalog-pipeline'
import { mapTelnaSimRegistry } from '@/lib/providers/mappers/telna-sim-mapper'
import { maskIccid } from '@/lib/providers/mappers/ibasis-sim-mapper'

function isTelnaConnector(c: unknown): c is TelnaConnector {
  return c !== null && typeof c === 'object' && 'listSimRegistries' in c
}

function makeSimSignature(mapped: ReturnType<typeof mapTelnaSimRegistry>): string {
  return JSON.stringify({
    s: mapped.providerStatus,
    i: mapped.imsi,
    m: mapped.msisdn,
    p: mapped.currentPackageId,
    t: mapped.packageTemplateId,
    a: mapped.activationDate,
    l: mapped.lastSession,
  })
}

export async function telnaSyncSims(providerId: string, inventoryId?: number) {
  const session = await getServerSession(authOptions)
  if (!session || session.user.role !== 'INTERNAL_ADMIN') throw new Error('Unauthorized')

  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { error: 'Provider not found' }

  const pipelineRunId = await startPipelineRun({
    providerId: provider.id,
    providerCode: provider.code || undefined,
    trigger: 'MANUAL',
  })
  const syncStartTime = Date.now()

  try {
    const connector = await buildConnectorFromProvider(providerId)
    if (!connector) return { error: 'Provider not found' }
    if (!isTelnaConnector(connector)) return { error: 'Provider does not support Telna SIM sync' }

    // Paginated fetch all SIMs
    const allSims: any[] = []
    let offset = 0
    const PAGE_SIZE = 100
    let hasMore = true

    while (hasMore) {
      const result = await connector.listSimRegistries(inventoryId, undefined, undefined, undefined, undefined, PAGE_SIZE, offset)
      if (!result.success) {
        await failPipelineRun(pipelineRunId, result.error?.message || 'Failed to list SIM registries')
        return { error: `Failed to list SIM registries: ${result.error?.message}` }
      }
      const items = result.data?.items || []
      allSims.push(...items)
      const total = result.data?.total || 0
      offset += PAGE_SIZE
      if (offset >= total || items.length === 0) hasMore = false
    }

    const fetched = allSims.length

    // Map and process — update matching ESIMs by ICCID
    const processed: Record<string, { action: 'created' | 'updated' | 'skipped'; mapped: ReturnType<typeof mapTelnaSimRegistry>; oldStatus: string | null }> = {}

    const incomingIccids = new Set<string>()

    for (const raw of allSims) {
      const mapped = mapTelnaSimRegistry(raw)
      const iccid = mapped.iccid
      if (!iccid) continue
      incomingIccids.add(iccid)

      const sig = makeSimSignature(mapped)

      // Check existing ESIM record by ICCID
      const existing = await prisma.eSIM.findFirst({
        where: { iccid },
      })

      if (existing) {
        const existingSig = existing.providerResponse
          ? ((existing.providerResponse as Record<string, unknown>)?.__syncSig as string) || ''
          : ''
        const oldStatus = existing.status
        if (existingSig === sig) {
          processed[iccid] = { action: 'skipped', mapped, oldStatus }
          continue
        }
        // Update existing ESIM
        await prisma.eSIM.update({
          where: { id: existing.id },
          data: {
            imsi: mapped.imsi || undefined,
            status: mapped.normalizedStatus,
            providerStatus: mapped.providerStatus,
            lastSyncAt: new Date(),
            providerResponse: { ...mapped.rawData, __syncSig: sig },
          },
        })
        processed[iccid] = { action: 'updated', mapped, oldStatus }
      } else {
        // Cannot create ESIM without a purchase association
        console.log(`[TELNA_SIM_SYNC] No matching ESIM for iccid=${maskIccid(iccid)} — skipping (no purchase association)`)
        processed[iccid] = { action: 'skipped', mapped, oldStatus: null }
      }
    }

    // Count results
    let created = 0, updated = 0, skipped = 0
    for (const [, v] of Object.entries(processed)) {
      if (v.action === 'created') created++
      else if (v.action === 'updated') updated++
      else skipped++
    }
    const durationMs = Date.now() - syncStartTime

    // Log diagnostics
    console.log(`[TELNA_SIM_SYNC] provider=${provider.code} fetched=${fetched} created=${created} updated=${updated} skipped=${skipped} duration=${durationMs}ms`)

    // Update provider sync metadata
    await prisma.provider.update({
      where: { id: providerId },
      data: {
        lastSyncAt: new Date(),
        lastSyncCount: fetched,
        lastSyncResult: `SIM Sync: ${fetched} SIMs: ${created}c ${updated}u ${skipped}s`,
      },
    })

    // Record pipeline stage
    await recordStageFromCounts({
      pipelineRunId,
      stage: 'PROVIDER_SYNC',
      startTime: syncStartTime,
      total: fetched,
      passed: created + updated,
      failed: 0,
      skipped,
      metadata: { created, updated, skipped, fetched, type: 'sim_sync' },
    })
    await completePipelineRun(
      pipelineRunId,
      'SUCCESS',
      created + updated,
    )

    // Emit events
    const { emitEvent } = await import('@/lib/catalog-events')
    for (const [iccid, info] of Object.entries(processed)) {
      if (info.action === 'created') {
        emitEvent({
          eventType: 'SIM_CREATED',
          providerId,
          providerCode: provider.code,
          packageId: null,
          comparableKey: null,
          changedFields: [],
          trigger: 'USER_ACTION',
          userId: session.user.id,
          metadata: { iccid, imsi: info.mapped.imsi, providerStatus: info.mapped.providerStatus },
        })
      } else if (info.action === 'updated') {
        const changedFields: string[] = []
        if (info.oldStatus !== info.mapped.normalizedStatus) {
          changedFields.push('status')
        }
        emitEvent({
          eventType: changedFields.includes('status') ? 'SIM_STATUS_CHANGED' : 'SIM_UPDATED',
          providerId,
          providerCode: provider.code,
          packageId: null,
          comparableKey: null,
          changedFields,
          trigger: 'USER_ACTION',
          userId: session.user.id,
          metadata: { iccid, oldStatus: info.oldStatus, newStatus: info.mapped.normalizedStatus },
        })
      }
    }

    return {
      success: true,
      result: { fetched, created, updated, archived: 0, skipped, durationMs },
    }
  } catch (error: any) {
    await prisma.provider.update({
      where: { id: providerId },
      data: {
        lastSyncAt: new Date(),
        lastSyncResult: `SIM Sync failed: ${error.message || 'Unknown error'}`,
        lastSyncCount: 0,
      },
    })
    await recordStageFromCounts({
      pipelineRunId, stage: 'PROVIDER_SYNC', startTime: syncStartTime,
      total: 0, passed: 0, failed: 0, skipped: 0, statusOverride: 'FAILED',
      metadata: { error: error.message || 'Unknown', type: 'sim_sync' },
    })
    await failPipelineRun(pipelineRunId, error.message || 'Unknown error')
    return { error: `SIM Sync failed: ${error.message || 'Unknown error'}` }
  }
}
