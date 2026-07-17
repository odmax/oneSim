export interface CatalogEvent {
  eventId: string
  timestamp: string
  eventType: CatalogEventType
  providerId: string | null
  providerCode: string | null
  packageId: string | null
  comparableKey: string | null
  changedFields: string[]
  trigger: EventTrigger
  userId: string | null
  metadata: Record<string, any>
}

export interface CatalogEventHandler {
  (event: CatalogEvent): Promise<void>
}

export type CatalogEventType =
  | 'PACKAGE_CREATED'
  | 'PACKAGE_UPDATED'
  | 'PACKAGE_CONFIGURED'
  | 'PACKAGE_PRICING_CHANGED'
  | 'PACKAGE_AVAILABILITY_CHANGED'
  | 'PACKAGE_PUBLISH_STATUS_CHANGED'
  | 'PACKAGE_ARCHIVED'
  | 'PACKAGE_UNARCHIVED'
  | 'PROVIDER_SYNC_COMPLETED'
  | 'PROVIDER_DISABLED'
  | 'PROVIDER_ENABLED'
  | 'CATALOG_PUBLISHED'
  | 'SIM_CREATED'
  | 'SIM_UPDATED'
  | 'SIM_ARCHIVED'
  | 'SIM_STATUS_CHANGED'
  | 'SIM_PACKAGE_ASSIGNED'
  | 'SIM_PACKAGE_CHANGED'
  | 'SIM_PROFILE_UPDATED'
  | 'SIM_USAGE_UPDATED'
  | 'SIM_BALANCE_UPDATED'
  | 'SIM_SESSION_RECORDED'
  | 'SIM_ALERT_CREATED'

export type EventTrigger = 'MANUAL' | 'SCHEDULED' | 'SYSTEM' | 'WEBHOOK' | 'USER_ACTION'

export interface EventRecord {
  eventId: string
  eventType: CatalogEventType
  timestamp: string
  providerId: string | null
  providerCode: string | null
  packageId: string | null
  comparableKey: string | null
  changedFields: string[]
  trigger: EventTrigger
  userId: string | null
  metadata: Record<string, any>
  handlerDurationMs: number
  handlerStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED'
  handlerResult: string | null
  affectedGroups: string[]
  packagesUpdated: number
  pipelineRunId: string | null
}
