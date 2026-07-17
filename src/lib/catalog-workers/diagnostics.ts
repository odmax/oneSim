import { prisma } from '@/lib/prisma'

export interface EventDiagnostic {
  eventId: string
  eventType: string
  status: string
  createdAt: Date
  attempts: number
  lastError: string | null
  comparableKey: string | null
  pipelineRunId: string | null
  pipelineRun?: {
    status: string
    startedAt: Date
    finishedAt: Date | null
    durationMs: number | null
    stages: {
      stage: string
      status: string
      total: number
      passed: number
      failed: number
      durationMs: number
    }[]
  } | null
  affectedPackages: {
    id: string
    name: string
    comparableKey: string | null
    isCheapestCandidate: boolean
    publishStatus: string
  }[]
  repairHistory: {
    id: string
    eventType: string
    status: string
    createdAt: Date
    lastError: string | null
  }[]
  deadLetterEntry: {
    id: string
    reason: string
    createdAt: Date
  } | null
}

export async function getEventDiagnostic(eventId: string): Promise<EventDiagnostic | null> {
  const evt = await prisma.catalogEvent.findUnique({
    where: { id: eventId },
  })
  if (!evt) return null

  const pipelineRun = evt.comparableKey
    ? await getPipelineRunForKey(evt.comparableKey, evt.createdAt)
    : null

  const affectedPackages = evt.comparableKey
    ? (await prisma.providerPackage.findMany({
      where: { comparableKey: evt.comparableKey, isAvailable: true },
      select: {
        id: true, name: true, comparableKey: true,
        isCheapestCandidate: true, publishStatus: true,
      },
      take: 50,
    })).map(p => ({
      id: p.id,
      name: p.name,
      comparableKey: p.comparableKey,
      isCheapestCandidate: p.isCheapestCandidate,
      publishStatus: p.publishStatus || 'DRAFT',
    }))
    : []

  const repairHistory = await prisma.catalogEvent.findMany({
    where: {
      comparableKey: evt.comparableKey,
      id: { not: eventId },
      status: { in: ['COMPLETED', 'FAILED'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, eventType: true, status: true, createdAt: true, lastError: true },
  })

  const deadLetterEntry = await prisma.catalogDeadLetter.findFirst({
    where: { eventId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, reason: true, createdAt: true },
  })

  return {
    eventId: evt.id,
    eventType: evt.eventType,
    status: evt.status,
    createdAt: evt.createdAt,
    attempts: evt.attempts,
    lastError: evt.lastError,
    comparableKey: evt.comparableKey,
    pipelineRunId: pipelineRun?.id || null,
    pipelineRun: pipelineRun ? {
      status: pipelineRun.status,
      startedAt: pipelineRun.startedAt,
      finishedAt: pipelineRun.finishedAt,
      durationMs: pipelineRun.durationMs,
      stages: pipelineRun.stages.map((s: any) => ({
        stage: s.stage,
        status: s.status,
        total: s.total,
        passed: s.passed,
        failed: s.failed,
        durationMs: s.durationMs,
      })),
    } : null,
    affectedPackages,
    repairHistory,
    deadLetterEntry,
  }
}

async function getPipelineRunForKey(comparableKey: string, after: Date) {
  return prisma.catalogPipelineRun.findFirst({
    where: {
      startedAt: { gte: after },
    },
    orderBy: { startedAt: 'asc' },
    include: { stages: { orderBy: { createdAt: 'asc' as const } } },
  }) as any
}
