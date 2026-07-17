import { prisma } from '@/lib/prisma'

const STAGE_DETAIL_RETENTION_DAYS = 30
const RUN_SUMMARY_RETENTION_DAYS = 180

export async function cleanupOldPipelineRecords(dryRun = false): Promise<{
  deletedStages: number
  deletedRuns: number
}> {
  const stageCutoff = new Date()
  stageCutoff.setDate(stageCutoff.getDate() - STAGE_DETAIL_RETENTION_DAYS)

  const runCutoff = new Date()
  runCutoff.setDate(runCutoff.getDate() - RUN_SUMMARY_RETENTION_DAYS)

  // Find old runs whose stages should be purged
  const oldRuns = await prisma.catalogPipelineRun.findMany({
    where: { startedAt: { lt: stageCutoff } },
    select: { id: true },
  })

  const oldRunIds = oldRuns.map(r => r.id)

  let deletedStages = 0
  let deletedRuns = 0

  if (oldRunIds.length > 0 && !dryRun) {
    // Delete stage details for runs older than STAGE_DETAIL_RETENTION_DAYS
    const stageResult = await prisma.catalogPipelineStage.deleteMany({
      where: { pipelineRunId: { in: oldRunIds } },
    })
    deletedStages = stageResult.count
  }

  // Find runs older than RUN_SUMMARY_RETENTION_DAYS
  const veryOldRuns = await prisma.catalogPipelineRun.findMany({
    where: { startedAt: { lt: runCutoff } },
    select: { id: true },
  })

  const veryOldRunIds = veryOldRuns.map(r => r.id)

  if (veryOldRunIds.length > 0 && !dryRun) {
    const runResult = await prisma.catalogPipelineRun.deleteMany({
      where: { id: { in: veryOldRunIds } },
    })
    deletedRuns = runResult.count
  }

  if (dryRun) {
    deletedStages = oldRunIds.length > 0 ? -1 : 0
    deletedRuns = veryOldRunIds.length
  }

  console.log('[CATALOG_PIPELINE_CLEANUP]', JSON.stringify({
    dryRun,
    stageCutoffDays: STAGE_DETAIL_RETENTION_DAYS,
    runCutoffDays: RUN_SUMMARY_RETENTION_DAYS,
    oldRunsWithStages: oldRunIds.length,
    veryOldRuns: veryOldRunIds.length,
    wouldDeleteStages: deletedStages,
    wouldDeleteRuns: deletedRuns,
  }))

  return { deletedStages, deletedRuns }
}
