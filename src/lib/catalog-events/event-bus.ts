import type { CatalogEvent, CatalogEventType, CatalogEventHandler } from './types'

type HandlerEntry = {
  handler: CatalogEventHandler
  once: boolean
}

class CatalogEventBus {
  private handlers = new Map<CatalogEventType, HandlerEntry[]>()
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private debouncedEvents = new Map<string, CatalogEvent>()

  subscribe(eventType: CatalogEventType, handler: CatalogEventHandler, once = false): void {
    const existing = this.handlers.get(eventType) || []
    existing.push({ handler, once })
    this.handlers.set(eventType, existing)
  }

  subscribeAll(handler: CatalogEventHandler): void {
    for (const type of [
      'PACKAGE_CREATED', 'PACKAGE_UPDATED', 'PACKAGE_CONFIGURED',
      'PACKAGE_PRICING_CHANGED', 'PACKAGE_AVAILABILITY_CHANGED',
      'PACKAGE_PUBLISH_STATUS_CHANGED', 'PACKAGE_ARCHIVED', 'PACKAGE_UNARCHIVED',
      'PROVIDER_SYNC_COMPLETED', 'PROVIDER_DISABLED', 'PROVIDER_ENABLED',
      'CATALOG_PUBLISHED',
    ] as CatalogEventType[]) {
      this.subscribe(type, handler, false)
    }
  }

  async publish(event: CatalogEvent): Promise<void> {
    const handlers = this.handlers.get(event.eventType) || []
    const onceHandlers: number[] = []

    for (let i = 0; i < handlers.length; i++) {
      const entry = handlers[i]
      try {
        await entry.handler(event)
      } catch (err) {
        console.error(`[CATALOG_EVENT] Handler error for ${event.eventType}:`, err)
      }
      if (entry.once) onceHandlers.push(i)
    }

    for (let i = onceHandlers.length - 1; i >= 0; i--) {
      handlers.splice(onceHandlers[i], 1)
    }
  }

  publishDebounced(event: CatalogEvent, delayMs = 50): void {
    const key = this.debounceKey(event)
    if (this.debounceTimers.has(key)) {
      clearTimeout(this.debounceTimers.get(key)!)
    }
    this.debouncedEvents.set(key, event)
    this.debounceTimers.set(key, setTimeout(() => {
      const evt = this.debouncedEvents.get(key)
      if (evt) {
        this.debouncedEvents.delete(key)
        this.publish(evt).catch(err =>
          console.error(`[CATALOG_EVENT] Debounced publish error:`, err)
        )
      }
      this.debounceTimers.delete(key)
    }, delayMs))
  }

  flushDebounced(): void {
    for (const [key, timer] of this.debounceTimers) {
      clearTimeout(timer)
      const evt = this.debouncedEvents.get(key)
      if (evt) {
        this.debouncedEvents.delete(key)
        this.publish(evt).catch(err =>
          console.error(`[CATALOG_EVENT] Flush publish error:`, err)
        )
      }
    }
    this.debounceTimers.clear()
  }

  private debounceKey(event: CatalogEvent): string {
    const group = event.comparableKey || '__nogroup__'
    const provider = event.providerId || '__noprov__'
    return `${group}:${provider}`
  }

  clear(): void {
    this.flushDebounced()
    this.handlers.clear()
  }

  handlerCount(): number {
    let count = 0
    for (const entries of this.handlers.values()) {
      count += entries.length
    }
    return count
  }
}

export const catalogEventBus = new CatalogEventBus()
