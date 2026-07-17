import { prisma } from '@/lib/prisma'
import type { PipelineStage, PipelineStatus, PipelineTrigger, StageStatus, ReasonCounts, StageRecord } from './types'
import { STAGE_ORDER } from './stages'

export async function startPipelineRun(params: {
  providerId?: string
  providerCode?: string
  trigger: PipelineTrigger
  totalInput?: number
}): Promise<string> {
  const run = await prisma.catalogPipelineRun.create({
    data: {
      providerId: params.providerId || null,
      providerCode: params.providerCode || null,
      trigger: params.trigger,
      status: 'RUNNING',
      startedAt: new Date(),
      totalInput: params.totalInput || 0,
      totalOutput: 0,
    },
  })

  console.log('[CATALOG_PIPELINE_RUN]', JSON.stringify({
    runId: run.id,
    providerCode: params.providerCode || null,
    trigger: params.trigger,
    status: 'RUNNING',
    durationMs: 0,
  }))

  return run.id
}

export async function recordPipelineStage(params: {
  pipelineRunId: string
  stage: PipelineStage
  status: StageStatus
  total: number
  passed: number
  failed: number
  skipped: number
  durationMs: number
  reasonCounts?: ReasonCounts
  metadata?: Record<string, any>
}): Promise<void> {
  await prisma.catalogPipelineStage.create({
    data: {
      pipelineRunId: params.pipelineRunId,
      stage: params.stage,
      status: params.status,
      total: params.total,
      passed: params.passed,
      failed: params.failed,
      skipped: params.skipped,
      durationMs: params.durationMs,
      reasonCounts: params.reasonCounts || undefined,
      metadata: params.metadata || undefined,
    },
  })

  console.log('[CATALOG_PIPELINE_STAGE]', JSON.stringify({
    runId: params.pipelineRunId,
    stage: params.stage,
    total: params.total,
    passed: params.passed,
    failed: params.failed,
    skipped: params.skipped,
    durationMs: params.durationMs,
  }))
}

export async function completePipelineRun(
  runId: string,
  status: PipelineStatus,
  totalOutput?: number,
  errorMessage?: string,
): Promise<void> {
  const finishedAt = new Date()
  const run = await prisma.catalogPipelineRun.findUnique({ where: { id: runId } })
  const durationMs = run ? finishedAt.getTime() - run.startedAt.getTime() : 0

  await prisma.catalogPipelineRun.update({
    where: { id: runId },
    data: {
      status,
      finishedAt,
      durationMs,
      totalOutput: totalOutput ?? 0,
      errorMessage: errorMessage || null,
    },
  })

  console.log('[CATALOG_PIPELINE_RUN]', JSON.stringify({
    runId,
    providerCode: run?.providerCode || null,
    trigger: run?.trigger || null,
    status,
    durationMs,
  }))
}

export async function failPipelineRun(runId: string, errorMessage: string): Promise<void> {
  await completePipelineRun(runId, 'FAILED', undefined, errorMessage)
}

export async function recordStageFromCounts(params: {
  pipelineRunId: string
  stage: PipelineStage
  startTime: number
  total: number
  passed: number
  failed: number
  skipped: number
  statusOverride?: StageStatus
  reasonCounts?: ReasonCounts
  metadata?: Record<string, any>
}): Promise<void> {
  const durationMs = Date.now() - params.startTime
  const status = params.statusOverride || (params.failed > 0 ? 'PARTIAL' : 'SUCCESS')

  await recordPipelineStage({
    pipelineRunId: params.pipelineRunId,
    stage: params.stage,
    status,
    total: params.total,
    passed: params.passed,
    failed: params.failed,
    skipped: params.skipped,
    durationMs,
    reasonCounts: params.reasonCounts,
    metadata: params.metadata,
  })
}
