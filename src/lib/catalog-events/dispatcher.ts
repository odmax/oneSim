import { prisma } from '@/lib/prisma'
import { catalogEventBus } from './event-bus'
import type { CatalogEvent, CatalogEventType, EventTrigger, EventRecord } from './types'
import { getAffectedComparableKeys, shouldTriggerRecalculation } from './events'

let eventCounter = 0

const recentEvents: EventRecord[] = []
const MAX_RECENT_EVENTS = 200

function generateEventId(): string {
  eventCounter++
  return `evt-${Date.now()}-${eventCounter}-${Math.random().toString(36).slice(2, 6)}`
}

export function emitEvent(params: {
  eventType: CatalogEventType
  providerId?: string | null
  providerCode?: string | null
  packageId?: string | null
  comparableKey?: string | null
  changedFields: string[]
  trigger?: EventTrigger
  userId?: string | null
  metadata?: Record<string, any>
}): void {
  const event: CatalogEvent = {
    eventId: generateEventId(),
    timestamp: new Date().toISOString(),
    eventType: params.eventType,
    providerId: params.providerId ?? null,
    providerCode: params.providerCode ?? null,
    packageId: params.packageId ?? null,
    comparableKey: params.comparableKey ?? null,
    changedFields: params.changedFields,
    trigger: params.trigger || 'SYSTEM',
    userId: params.userId ?? null,
    metadata: params.metadata || {},
  }

  const needsRecalculation = shouldTriggerRecalculation(event.eventType)
  const affectedKeys = getAffectedComparableKeys(event)

  // Persist event to DB (fire-and-forget)
  if (needsRecalculation) {
    prisma.catalogEvent.create({
      data: {
        eventType: event.eventType,
        status: 'PENDING',
        providerId: event.providerId,
        providerCode: event.providerCode,
        packageId: event.packageId,
        comparableKey: event.comparableKey,
        payload: {
          timestamp: event.timestamp,
          changedFields: event.changedFields,
          trigger: event.trigger,
          userId: event.userId,
          metadata: event.metadata,
        },
        attempts: 0,
      },
    }).catch((err: any) => console.error('[CATALOG_EVENT] Failed to persist event:', err))
  }

  // Dispatch in-process for immediate handling
  if (needsRecalculation && affectedKeys.length > 0) {
    catalogEventBus.publishDebounced(event)
  }

  if (!needsRecalculation || affectedKeys.length === 0) {
    catalogEventBus.publish(event).catch(err =>
      console.error('[CATALOG_EVENT] Publish error:', err)
    )
  }
}

export function getRecentEvents(limit = 50): EventRecord[] {
  return recentEvents.slice(0, limit)
}

export function recordEvent(record: EventRecord): void {
  recentEvents.unshift(record)
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.length = MAX_RECENT_EVENTS
  }
}

export function clearRecentEvents(): void {
  recentEvents.length = 0
}
