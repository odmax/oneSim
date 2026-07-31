'use server'

import { prisma } from '@/lib/prisma'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/config'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import type { IbasisConnector } from '@/lib/providers/connectors/ibasis-connector'
import { startPipelineRun, recordStageFromCounts, completePipelineRun, failPipelineRun } from '@/lib/catalog-pipeline'
import { mapIbasisSim, activationCodeFingerprint, maskIccid, maskActivationCode } from '@/lib/providers/mappers/ibasis-sim-mapper'
import type { MappedIbasisSim } from '@/lib/providers/mappers/ibasis-sim-mapper'

function isIbasisConnector(c: unknown): c is IbasisConnector {
  return c !== null && typeof c === 'object' && 'listInventorySims' in c
}

function makeSimSignature(mapped: MappedIbasisSim): string {
  return JSON.stringify({
    s: mapped.providerStatus,
    t: mapped.simType,
    c: mapped.carrier,
    a: activationCodeFingerprint(mapped.activationCode),
  })
}

const MAX_PAGES = 10000

export async function ibasisSyncSims(providerId: string) {
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
    if (!isIbasisConnector(connector)) return { error: 'Provider does not support iBASIS SIM sync' }

    // Paginated fetch of the full SIM inventory, following iBASIS `next` URLs.
    const allSims: any[] = []
    let nextUrl: string | null | undefined = undefined
    let pages = 0
    let total = 0

    do {
      const result = await connector.listInventorySims({ nextUrl })
      if (!result.success) {
        await failPipelineRun(pipelineRunId, result.error?.message || 'Failed to list SIM inventory')
        return { error: `Failed to list SIM inventory: ${result.error?.message}` }
      }
      const items = result.data?.items || []
      allSims.push(...items)
      total = result.data?.total ?? total
      nextUrl = result.data?.next
      pages++
      if (pages > MAX_PAGES) {
        await failPipelineRun(pipelineRunId, `SIM inventory pagination exceeded ${MAX_PAGES} pages`)
        return { error: `SIM inventory pagination exceeded ${MAX_PAGES} pages` }
      }
    } while (nextUrl)

    const fetched = allSims.length

    // Map and process — update matching ESIMs by ICCID.
    const processed: Record<string, { action: 'created' | 'updated' | 'skipped'; mapped: MappedIbasisSim; oldStatus: string | null }> = {}

    for (const raw of allSims) {
      const mapped = mapIbasisSim(raw)
      const iccid = mapped.iccid
      if (!iccid) continue

      const sig = makeSimSignature(mapped)

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
        await prisma.eSIM.update({
          where: { id: existing.id },
          data: {
            status: mapped.normalizedStatus,
            providerStatus: mapped.providerStatus,
            activationCode: mapped.activationCode || undefined,
            lastSyncAt: new Date(),
            providerResponse: { ...mapped.rawData, __syncSig: sig },
          },
        })
        processed[iccid] = { action: 'updated', mapped, oldStatus }
      } else {
        // Cannot create ESIM without a purchase association.
        console.log(`[IBASIS_SIM_SYNC] No matching ESIM for iccid=${maskIccid(iccid)} — skipping (no purchase association)`)
        processed[iccid] = { action: 'skipped', mapped, oldStatus: null }
      }
    }

    let created = 0, updated = 0, skipped = 0
    for (const [, v] of Object.entries(processed)) {
      if (v.action === 'created') created++
      else if (v.action === 'updated') updated++
      else skipped++
    }
    const durationMs = Date.now() - syncStartTime

    console.log(`[IBASIS_SIM_SYNC] provider=${provider.code} fetched=${fetched} created=${created} updated=${updated} skipped=${skipped} duration=${durationMs}ms activationCodesFetched=${allSims.filter((s) => typeof s?.activation_code === 'string' && s.activation_code).length}`)

    await prisma.provider.update({
      where: { id: providerId },
      data: {
        lastSyncAt: new Date(),
        lastSyncCount: fetched,
        lastSyncResult: `SIM Sync: ${fetched} SIMs: ${created}c ${updated}u ${skipped}s`,
      },
    })

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

    const { emitEvent } = await import('@/lib/catalog-events')
    for (const [iccid, info] of Object.entries(processed)) {
      if (info.action === 'updated') {
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
          metadata: {
            iccid,
            oldStatus: info.oldStatus,
            newStatus: info.mapped.normalizedStatus,
            simType: info.mapped.simType,
            carrier: info.mapped.carrier,
            activationCode: info.mapped.activationCode ? maskActivationCode(info.mapped.activationCode) : null,
          },
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
