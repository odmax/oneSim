import { prisma } from '@/lib/prisma'
import { catalogEventBus } from '@/lib/catalog-events/event-bus'
import type { CatalogEventType } from '@/lib/catalog-events/types'

export interface LoadTestResult {
  totalEvents: number
  durationMs: number
  eventsPerSecond: number
  dbEventsCreated: number
  debouncedDeduplicated: number
  errors: string[]
  lockContention: number
}

export async function simulatePackageUpdates(
  count = 10000,
  comparableKeys: string[] = ['local:NG:5GB:30', 'local:KE:1GB:7', 'roaming:INT:10GB:30'],
): Promise<LoadTestResult> {
  const startTime = Date.now()
  const errors: string[] = []
  let dbEventsCreated = 0
  let debouncedDeduplicated = 0
  let lockContention = 0

  for (let i = 0; i < count; i++) {
    const key = comparableKeys[i % comparableKeys.length]
    const eventType: CatalogEventType = 'PACKAGE_PRICING_CHANGED'

    // Simulate emitEvent
    try {
      const created = await prisma.catalogEvent.create({
        data: {
          eventType,
          status: 'PENDING',
          comparableKey: key,
          payload: {
            timestamp: new Date().toISOString(),
            changedFields: ['costPrice', 'sellingPrice'],
            trigger: 'SYSTEM',
            metadata: { loadTestIteration: i },
          },
          attempts: 0,
        },
      })
      dbEventsCreated++

      // Publish to in-memory bus (debounced)
      const debounceKey = `${key}:__noprov__`
      const wasAlreadyPending = catalogEventBus['debounceTimers'].has(debounceKey)
      if (wasAlreadyPending) debouncedDeduplicated++

      catalogEventBus.publishDebounced({
        eventId: created.id,
        timestamp: new Date().toISOString(),
        eventType,
        providerId: null,
        providerCode: null,
        packageId: null,
        comparableKey: key,
        changedFields: ['costPrice', 'sellingPrice'],
        trigger: 'SYSTEM',
        userId: null,
        metadata: { loadTestIteration: i },
      })

      // Simulate lock check
      if (i > 0 && key === comparableKeys[(i - 1) % comparableKeys.length]) {
        if (i % 100 === 0) lockContention++
      }
    } catch (err: any) {
      errors.push(`Event ${i}: ${err.message}`)
    }
  }

  const durationMs = Date.now() - startTime
  const eventsPerSecond = Math.round((count / durationMs) * 1000)

  return {
    totalEvents: count,
    durationMs,
    eventsPerSecond,
    dbEventsCreated,
    debouncedDeduplicated,
    errors,
    lockContention,
  }
}
