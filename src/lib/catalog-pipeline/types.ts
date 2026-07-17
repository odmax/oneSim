export type PipelineStage =
  | 'PROVIDER_SYNC'
  | 'CONFIGURATION'
  | 'CATALOG_HEALTH'
  | 'CHEAPEST_SELECTION'
  | 'READY_FOR_PUBLISH'
  | 'PUBLISH'
  | 'MARKETPLACE'
  | 'ORDERABLE'
  | 'GROUP_RECALCULATION'

export type PipelineStatus = 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED'
export type StageStatus = 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED'
export type PipelineTrigger = 'MANUAL' | 'SCHEDULED' | 'WEBHOOK' | 'SYSTEM' | 'EVENT'

export interface StageCounts {
  total: number
  passed: number
  failed: number
  skipped: number
}

export interface ReasonCounts {
  [reason: string]: number
}

export interface StageRecord {
  stage: PipelineStage
  status: StageStatus
  total: number
  passed: number
  failed: number
  skipped: number
  durationMs: number
  reasonCounts?: ReasonCounts
  metadata?: Record<string, any>
}

export interface RunResult {
  runId: string
  providerId?: string
  providerCode?: string
  trigger: PipelineTrigger
  status: PipelineStatus
  startedAt: Date
  finishedAt?: Date
  durationMs?: number
  totalInput: number
  totalOutput: number
  errorMessage?: string
}
