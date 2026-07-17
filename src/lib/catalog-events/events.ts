import type { CatalogEventType, EventTrigger } from './types'

export const CATALOG_EVENT_TYPES: CatalogEventType[] = [
  'PACKAGE_CREATED',
  'PACKAGE_UPDATED',
  'PACKAGE_CONFIGURED',
  'PACKAGE_PRICING_CHANGED',
  'PACKAGE_AVAILABILITY_CHANGED',
  'PACKAGE_PUBLISH_STATUS_CHANGED',
  'PACKAGE_ARCHIVED',
  'PACKAGE_UNARCHIVED',
  'PROVIDER_SYNC_COMPLETED',
  'PROVIDER_DISABLED',
  'PROVIDER_ENABLED',
  'CATALOG_PUBLISHED',
  'SIM_CREATED',
  'SIM_UPDATED',
  'SIM_ARCHIVED',
  'SIM_STATUS_CHANGED',
  'SIM_PACKAGE_ASSIGNED',
  'SIM_PACKAGE_CHANGED',
  'SIM_PROFILE_UPDATED',
  'SIM_USAGE_UPDATED',
  'SIM_BALANCE_UPDATED',
  'SIM_SESSION_RECORDED',
  'SIM_ALERT_CREATED',
]

export function shouldTriggerRecalculation(eventType: CatalogEventType): boolean {
  switch (eventType) {
    case 'PACKAGE_CREATED':
    case 'PACKAGE_UPDATED':
    case 'PACKAGE_CONFIGURED':
    case 'PACKAGE_PRICING_CHANGED':
    case 'PACKAGE_AVAILABILITY_CHANGED':
    case 'PACKAGE_PUBLISH_STATUS_CHANGED':
    case 'PACKAGE_ARCHIVED':
    case 'PACKAGE_UNARCHIVED':
    case 'PROVIDER_SYNC_COMPLETED':
    case 'PROVIDER_DISABLED':
    case 'PROVIDER_ENABLED':
      return true
    case 'CATALOG_PUBLISHED':
    case 'SIM_CREATED':
    case 'SIM_UPDATED':
    case 'SIM_ARCHIVED':
    case 'SIM_STATUS_CHANGED':
    case 'SIM_PACKAGE_ASSIGNED':
    case 'SIM_PACKAGE_CHANGED':
    case 'SIM_PROFILE_UPDATED':
    case 'SIM_USAGE_UPDATED':
    case 'SIM_BALANCE_UPDATED':
    case 'SIM_SESSION_RECORDED':
    case 'SIM_ALERT_CREATED':
      return false
  }
}

export function getAffectedComparableKeys(event: {
  comparableKey: string | null
  eventType: string
  providerId: string | null
}): string[] {
  if (event.comparableKey) return [event.comparableKey]
  if (event.eventType.startsWith('PROVIDER_')) return []
  return []
}
