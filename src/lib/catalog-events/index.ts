export * from './types'
export * from './events'
export { catalogEventBus } from './event-bus'
export { emitEvent, getRecentEvents, clearRecentEvents } from './dispatcher'
export { registerEventHandlers, handleCatalogEvent } from './handlers'

// Auto-register on first import (idempotent via internal guard in event-bus)
import { registerEventHandlers } from './handlers'
registerEventHandlers()
