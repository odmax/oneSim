import { catalogEventBus } from './event-bus'
import { emitEvent, recordEvent } from './dispatcher'
import { getAffectedComparableKeys, shouldTriggerRecalculation } from './events'
import { startPipelineRun, recordStageFromCounts, completePipelineRun } from '@/lib/catalog-pipeline'
import type { CatalogEvent, EventRecord, CatalogEventType } from './types'

export async function handleCatalogEvent(event: CatalogEvent): Promise<void> {
  const startTime = Date.now()
  const affectedKeys = getAffectedComparableKeys(event)
  const needsRecalculation = shouldTriggerRecalculation(event.eventType)

  let packagesUpdated = 0
  let handlerStatus: EventRecord['handlerStatus'] = 'SUCCESS'
  let handlerResult: string | null = null
  let pipelineRunId: string | null = null

  const resolvedGroups: string[] = []

  if (needsRecalculation) {
    if (affectedKeys.length > 0) {
      pipelineRunId = await startPipelineRun({
        providerId: event.providerId ?? undefined,
        providerCode: event.providerCode ?? undefined,
        trigger: 'EVENT' as any,
      })
    }

    for (const key of affectedKeys) {
      try {
        const { recalculateComparableGroup } = await import('@/lib/packages/cheapest-utils')
        const result = await recalculateComparableGroup(key, pipelineRunId ?? undefined)
        packagesUpdated += result.winners + result.alternatives
        resolvedGroups.push(key)
      } catch (err: any) {
        handlerResult = `Group ${key} failed: ${err.message}`
        handlerStatus = 'PARTIAL'
        console.error(`[CATALOG_EVENT] Recalculation error for group ${key}:`, err)
      }
    }

    if (event.eventType === 'PROVIDER_SYNC_COMPLETED' || event.eventType === 'PROVIDER_DISABLED' || event.eventType === 'PROVIDER_ENABLED') {
      const { recalculateCheapestPlans } = await import('@/lib/packages/cheapest-utils')
      try {
        const result = await recalculateCheapestPlans()
        packagesUpdated = result.winners + result.alternatives
      } catch (err: any) {
        handlerResult = handlerResult
          ? `${handlerResult}; Full recalc failed: ${err.message}`
          : `Full recalc failed: ${err.message}`
        handlerStatus = 'PARTIAL'
      }
    }

    if (pipelineRunId) {
      await completePipelineRun(pipelineRunId, handlerStatus === 'PARTIAL' ? 'PARTIAL' : 'SUCCESS', packagesUpdated)
    }
  }

  const durationMs = Date.now() - startTime

  const record: EventRecord = {
    eventId: event.eventId,
    eventType: event.eventType,
    timestamp: event.timestamp,
    providerId: event.providerId,
    providerCode: event.providerCode,
    packageId: event.packageId,
    comparableKey: event.comparableKey,
    changedFields: event.changedFields,
    trigger: event.trigger,
    userId: event.userId,
    metadata: event.metadata,
    handlerDurationMs: durationMs,
    handlerStatus,
    handlerResult,
    affectedGroups: resolvedGroups,
    packagesUpdated,
    pipelineRunId,
  }

  recordEvent(record)

  console.log('[CATALOG_EVENT_HANDLED]', JSON.stringify({
    eventId: event.eventId,
    eventType: event.eventType,
    durationMs,
    status: handlerStatus,
    groups: resolvedGroups.length,
    packagesUpdated,
  }))
}

export function registerEventHandlers(): void {
  catalogEventBus.subscribeAll(handleCatalogEvent)
  console.log('[CATALOG_EVENT] Handlers registered')
}
