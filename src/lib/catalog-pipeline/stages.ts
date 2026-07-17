import type { PipelineStage } from './types'

export const STAGE_ORDER: PipelineStage[] = [
  'PROVIDER_SYNC',
  'CONFIGURATION',
  'CATALOG_HEALTH',
  'CHEAPEST_SELECTION',
  'READY_FOR_PUBLISH',
  'PUBLISH',
  'MARKETPLACE',
  'ORDERABLE',
  'GROUP_RECALCULATION',
]

export const STAGE_LABELS: Record<PipelineStage, string> = {
  PROVIDER_SYNC: 'Provider Sync',
  CONFIGURATION: 'Package Configuration',
  CATALOG_HEALTH: 'Catalog Health',
  CHEAPEST_SELECTION: 'Cheapest Selection',
  READY_FOR_PUBLISH: 'Ready for Publish',
  PUBLISH: 'Publish',
  MARKETPLACE: 'Marketplace',
  ORDERABLE: 'Orderable',
  GROUP_RECALCULATION: 'Group Recalculation',
}
