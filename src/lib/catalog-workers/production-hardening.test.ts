import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    catalogEvent: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
      deleteMany: vi.fn(),
    },
    catalogDeadLetter: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
      delete: vi.fn(),
    },
    catalogPipelineRun: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
      deleteMany: vi.fn(),
    },
    catalogPipelineStage: {
      findMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    providerPackage: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    eSIMPackage: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
      upsert: vi.fn(),
    },
    maintenanceJob: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    provider: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}))

vi.mock('@/lib/auth/config', () => ({ authOptions: {} }))

vi.mock('@/lib/catalog-pipeline', () => ({
  startPipelineRun: vi.fn().mockResolvedValue('pipeline-run-1'),
  recordStageFromCounts: vi.fn(),
  completePipelineRun: vi.fn(),
  failPipelineRun: vi.fn(),
  recordPipelineStage: vi.fn(),
  runCatalogHealthDiagnostics: vi.fn().mockResolvedValue({ total: 10, eligible: 8, ineligible: 2, reasonCounts: {} }),
}))

vi.mock('@/lib/catalog-events/handlers', () => ({
  handleCatalogEvent: vi.fn().mockResolvedValue(undefined),
}))

const {
  processNextEvents, getQueueMetrics, retryEvent, cancelEvent, replayEvent,
  getDeadLetterEvents, replayDeadLetter, deleteDeadLetter,
} = await import('./processor')
const { getQueueHealth, recoverStaleProcessingEvents } = await import('./health')
const { catalogPipelineAudit } = await import('./audit')
const { validateEndToEndFlow } = await import('./flow-validator')
const { runHourlyReconciliation, runDailyReconciliation } = await import('./reconciliation')
const { acquireGroupLock, releaseGroupLock } = await import('./locks')

function mockEvent(overrides: Record<string, any> = {}): any {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    eventType: 'PACKAGE_PRICING_CHANGED',
    status: 'PENDING',
    providerId: 'prov-1',
    providerCode: 'TEST',
    packageId: 'pp-1',
    comparableKey: 'local:NG:5GB:30',
    payload: { timestamp: new Date().toISOString(), changedFields: ['costPrice'], trigger: 'SYSTEM' },
    attempts: 0,
    lastError: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    ...overrides,
  }
}

describe('Phase 3.5 - Production Hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(prisma.catalogPipelineRun.create).mockResolvedValue({ id: 'pipeline-run-1' } as any)
    vi.mocked(prisma.catalogPipelineRun.findUnique).mockResolvedValue({ id: 'pipeline-run-1', startedAt: new Date() } as any)
    vi.mocked(prisma.catalogPipelineRun.update).mockResolvedValue({} as any)
    vi.mocked(prisma.catalogPipelineStage.create).mockResolvedValue({} as any)
    vi.mocked(prisma.catalogEvent.update).mockResolvedValue({} as any)
    vi.mocked(prisma.catalogEvent.create).mockResolvedValue({} as any)

    // Default: no stale events, no pending events
    vi.mocked(prisma.catalogEvent.findMany).mockResolvedValue([])
  })

  describe('1. Event Idempotency', () => {
    it('retryEvent can safely execute multiple times', async () => {
      await retryEvent('evt-1')
      await retryEvent('evt-1')

      expect(prisma.catalogEvent.update).toHaveBeenCalledTimes(2)
      for (const call of vi.mocked(prisma.catalogEvent.update).mock.calls) {
        expect(call[0].data).toEqual({ status: 'PENDING', lastError: null })
      }
    })

    it('replaying a COMPLETED event creates a new PENDING event', async () => {
      vi.mocked(prisma.catalogEvent.findUnique).mockResolvedValue({
        id: 'evt-1',
        status: 'COMPLETED',
        eventType: 'PACKAGE_CONFIGURED',
        providerId: 'prov-1',
        providerCode: 'TEST',
        packageId: 'pp-1',
        comparableKey: 'local:NG:5GB:30',
        payload: { changedFields: ['sellingPrice'] },
        attempts: 1,
        createdAt: new Date(),
      } as any)

      vi.mocked(prisma.catalogEvent.create).mockResolvedValue({ id: 'evt-replay' } as any)

      const ok = await replayEvent('evt-1')
      expect(ok).toBe(true)
      expect(prisma.catalogEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PENDING', attempts: 0 }),
        }),
      )
    })

    it('cancelEvent on same event twice is safe', async () => {
      await cancelEvent('evt-1')
      await cancelEvent('evt-1')

      expect(prisma.catalogEvent.update).toHaveBeenCalledTimes(2)
    })
  })

  describe('2. Worker Crash Recovery', () => {
    it('recoverStaleProcessingEvents resets stale PROCESSING events to PENDING', async () => {
      const staleTime = new Date(Date.now() - 30 * 60 * 1000)
      vi.mocked(prisma.catalogEvent.findMany).mockResolvedValue([
        { id: 'stale-1', startedAt: staleTime },
        { id: 'stale-2', startedAt: staleTime },
      ] as any)

      const result = await recoverStaleProcessingEvents(10)
      expect(result.recovered).toBe(2)
      expect(prisma.catalogEvent.update).toHaveBeenCalledTimes(2)
      expect(vi.mocked(prisma.catalogEvent.update).mock.calls[0][0].data).toEqual({
        status: 'PENDING',
        lastError: expect.stringContaining('Recovered from stale PROCESSING'),
        startedAt: null,
      })
    })

    it('does not touch recent PROCESSING events', async () => {
      vi.mocked(prisma.catalogEvent.findMany).mockResolvedValue([])

      const result = await recoverStaleProcessingEvents(10)
      expect(result.recovered).toBe(0)
    })

    it('processNextEvents handles no events gracefully', async () => {
      const count = await processNextEvents('worker-1')
      expect(count).toBe(0)
    })
  })

  describe('3. Distributed Lock Validation', () => {
    it('prevents concurrent processing of same comparable group', async () => {
      vi.mocked(prisma.maintenanceJob.create)
        .mockResolvedValueOnce({} as any)
        .mockRejectedValueOnce({ code: 'P2002' })

      const lock1 = await acquireGroupLock('local:NG:5GB:30', 'worker-1')
      expect(lock1).toBe(true)

      vi.mocked(prisma.maintenanceJob.findUnique).mockResolvedValue({
        status: 'LOCKED',
        metadata: { expiresAt: new Date(Date.now() + 60000).toISOString() },
      } as any)

      const lock2 = await acquireGroupLock('local:NG:5GB:30', 'worker-2')
      expect(lock2).toBe(false)
    })

    it('allows different comparable groups to process concurrently', async () => {
      vi.mocked(prisma.maintenanceJob.create)
        .mockResolvedValueOnce({} as any)
        .mockResolvedValueOnce({} as any)

      const lock1 = await acquireGroupLock('local:NG:5GB:30', 'worker-1')
      const lock2 = await acquireGroupLock('local:KE:1GB:7', 'worker-1')

      expect(lock1).toBe(true)
      expect(lock2).toBe(true)
    })

    it('allows expired lock to be re-acquired', async () => {
      vi.mocked(prisma.maintenanceJob.create)
        .mockRejectedValueOnce({ code: 'P2002' })
      vi.mocked(prisma.maintenanceJob.findUnique).mockResolvedValue({
        status: 'LOCKED',
        metadata: { expiresAt: new Date(Date.now() - 60000).toISOString() },
      } as any)
      vi.mocked(prisma.maintenanceJob.update).mockResolvedValue({} as any)

      const lock = await acquireGroupLock('local:NG:5GB:30', 'worker-2')
      expect(lock).toBe(true)
    })
  })

  describe('4. Queue Health', () => {
    it('returns metrics with age tracking', async () => {
      const now = new Date()
      vi.mocked(prisma.catalogEvent.count)
        .mockResolvedValueOnce(5)  // pending
        .mockResolvedValueOnce(2)  // processing
        .mockResolvedValueOnce(100) // completed
        .mockResolvedValueOnce(3)  // failed
      vi.mocked(prisma.catalogDeadLetter.count)
        .mockResolvedValueOnce(1)  // total
        .mockResolvedValueOnce(0)  // 24h
      vi.mocked(prisma.catalogEvent.aggregate)
        .mockResolvedValueOnce({ _avg: { attempts: 0.5 } } as any)
        .mockResolvedValueOnce({ _avg: { attempts: null } } as any)
      vi.mocked(prisma.catalogEvent.findFirst)
        .mockResolvedValueOnce({ createdAt: new Date(now.getTime() - 300000) } as any)
        .mockResolvedValueOnce({ startedAt: new Date(now.getTime() - 60000) } as any)

      const health = await getQueueHealth()
      expect(health.pending).toBe(5)
      expect(health.processing).toBe(2)
      expect(health.completed).toBe(100)
      expect(health.failed).toBe(3)
      expect(health.deadLetterCount).toBe(1)
      expect(health.oldestPendingSec).toBeGreaterThan(0)
      expect(health.longestProcessingSec).toBeGreaterThan(0)
    })

    it('getQueueMetrics returns basic counts', async () => {
      vi.mocked(prisma.catalogEvent.count).mockResolvedValue(10)
      vi.mocked(prisma.catalogDeadLetter.count).mockResolvedValue(2)
      vi.mocked(prisma.catalogEvent.aggregate).mockResolvedValue({ _avg: { attempts: 0.3 } } as any)

      const metrics = await getQueueMetrics()
      expect(metrics.pending).toBe(10)
      expect(metrics.deadLetter).toBe(2)
      expect(metrics.avgRetries).toBe(0.3)
    })
  })

  describe('5. Pipeline Consistency Audit', () => {
    it('detects winner mismatch between cheapest and published', async () => {
      vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([
        { id: 'pp-1', name: 'Plan A', providerId: 'prov-1', comparableKey: 'local:NG:5GB:30', isAvailable: true, isCheapestCandidate: false, publishStatus: 'PUBLISHED', excludedFromCheapest: false, exclusionReason: null, provider: { id: 'prov-1', name: 'Test', code: 'TEST', status: 'ACTIVE' }, publishedAs: { id: 'esim-1', isActive: true, archivedAt: null, hiddenFromCatalog: false }, configurationStatus: 'CONFIGURED', sellingPrice: 5, sellingCurrency: 'USD', costPrice: 2, effectiveCostPrice: 2, dataGB: 5, validityDays: 30 },
        { id: 'pp-2', name: 'Plan B', providerId: 'prov-1', comparableKey: 'local:NG:5GB:30', isAvailable: true, isCheapestCandidate: true, publishStatus: 'READY', excludedFromCheapest: false, exclusionReason: null, provider: { id: 'prov-1', name: 'Test', code: 'TEST', status: 'ACTIVE' }, publishedAs: null, configurationStatus: 'CONFIGURED', sellingPrice: 4, sellingCurrency: 'USD', costPrice: 1.5, effectiveCostPrice: 1.5, dataGB: 5, validityDays: 30 },
      ] as any)
      vi.mocked(prisma.eSIMPackage.findMany).mockResolvedValue([])

      const result = await catalogPipelineAudit()
      expect(result.findings.some(f => f.category === 'WINNER_MISMATCH')).toBe(true)
    })

    it('detects missing comparableKey on available packages', async () => {
      vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([
        { id: 'pp-1', name: 'No Key Plan', providerId: 'prov-1', comparableKey: null, isAvailable: true, isCheapestCandidate: false, publishStatus: 'DRAFT', excludedFromCheapest: false, exclusionReason: null, provider: { id: 'prov-1', name: 'Test', code: 'TEST', status: 'ACTIVE' }, publishedAs: null, configurationStatus: 'CONFIGURED', sellingPrice: 5, sellingCurrency: 'USD', costPrice: 2, effectiveCostPrice: 2, dataGB: 5, validityDays: 30 },
      ] as any)
      vi.mocked(prisma.eSIMPackage.findMany).mockResolvedValue([])

      const result = await catalogPipelineAudit()
      expect(result.findings.some(f => f.category === 'MISSING_COMPARABLE_KEY')).toBe(true)
    })

    it('detects orphaned published packages', async () => {
      vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([
        { id: 'pp-1', name: 'Orphaned', providerId: 'prov-1', comparableKey: 'local:NG:5GB:30', isAvailable: false, isCheapestCandidate: false, publishStatus: 'PUBLISHED', excludedFromCheapest: false, exclusionReason: null, provider: { id: 'prov-1', name: 'Test', code: 'TEST', status: 'ACTIVE' }, publishedAs: { id: 'esim-1', isActive: true, archivedAt: null, hiddenFromCatalog: false }, configurationStatus: 'CONFIGURED', sellingPrice: 5, sellingCurrency: 'USD', costPrice: 2, effectiveCostPrice: 2, dataGB: 5, validityDays: 30 },
      ] as any)
      vi.mocked(prisma.eSIMPackage.findMany).mockResolvedValue([])

      const result = await catalogPipelineAudit()
      expect(result.findings.some(f => f.category === 'ORPHANED_PUBLISHED')).toBe(true)
    })

    it('returns summary with counts', async () => {
      vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([])
      vi.mocked(prisma.eSIMPackage.findMany).mockResolvedValue([])

      const result = await catalogPipelineAudit()
      expect(result.summary).toBeDefined()
      expect(typeof result.summary.totalPackages).toBe('number')
      expect(typeof result.summary.totalGroups).toBe('number')
    })
  })

  describe('6. End-to-End Flow Validation', () => {
    it('reports stage counts with accurate reconciliation', async () => {
      vi.mocked(prisma.providerPackage.count)
        .mockResolvedValueOnce(100)  // total
        .mockResolvedValueOnce(10)   // unavailable
        .mockResolvedValueOnce(90)   // available
        .mockResolvedValueOnce(20)   // not configured
        .mockResolvedValueOnce(70)   // configured
        .mockResolvedValueOnce(10)   // auto-configured (extra call)
        .mockResolvedValueOnce(60)   // health eligible
        .mockResolvedValueOnce(50)   // withCheapestCandidate
        .mockResolvedValueOnce(55)   // withRank
        .mockResolvedValueOnce(45)   // ready
        .mockResolvedValueOnce(30)   // published
      vi.mocked(prisma.eSIMPackage.count).mockResolvedValue(28)

      const result = await validateEndToEndFlow()
      expect(result.stageCounts.providerSync.input).toBe(100)
      expect(result.stageCounts.configuration.input).toBe(90)
      expect(result.stageCounts.marketplace.output).toBe(28)
      expect(typeof result.durationMs).toBe('number')
    })

    it('identifies count discrepancies as issues', async () => {
      vi.mocked(prisma.providerPackage.count)
        .mockResolvedValueOnce(100)  // total
        .mockResolvedValueOnce(10)   // unavailable
        .mockResolvedValueOnce(90)   // available
        .mockResolvedValueOnce(0)    // not configured
        .mockResolvedValueOnce(90)   // configured
        .mockResolvedValueOnce(0)    // auto-configured
        .mockResolvedValueOnce(90)   // health eligible
        .mockResolvedValueOnce(80)   // withCheapestCandidate
        .mockResolvedValueOnce(85)   // withRank
        .mockResolvedValueOnce(80)   // ready
        .mockResolvedValueOnce(30)   // published
      vi.mocked(prisma.eSIMPackage.count).mockResolvedValue(28)

      const result = await validateEndToEndFlow()
      expect(Array.isArray(result.issues)).toBe(true)
    })
  })

  describe('7. Reconciliation Dry Run', () => {
    it('runHourlyReconciliation with dryRun=true does not create pipeline run', async () => {
      vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([])

      const result = await runHourlyReconciliation(true)
      expect(result.dryRun).toBe(true)
      expect(prisma.catalogPipelineRun.create).not.toHaveBeenCalled()
    })

    it('runDailyReconciliation with dryRun=true reports correctly', async () => {
      vi.mocked(prisma.providerPackage.findMany).mockResolvedValue([])

      const result = await runDailyReconciliation(true)
      expect(result.dryRun).toBe(true)
    })
  })

  describe('8. Dead Letter Operations', () => {
    it('replayDeadLetter creates new PENDING event', async () => {
      vi.mocked(prisma.catalogDeadLetter.findUnique).mockResolvedValue({
        id: 'dl-1',
        eventType: 'PACKAGE_PRICING_CHANGED',
        payload: { providerId: 'prov-1', providerCode: 'TEST', packageId: 'pp-1', comparableKey: 'local:NG:5GB:30', changedFields: ['costPrice'] },
        reason: 'Max retries exceeded',
        createdAt: new Date(),
      } as any)
      vi.mocked(prisma.catalogEvent.create).mockResolvedValue({ id: 'evt-replay' } as any)

      const ok = await replayDeadLetter('dl-1')
      expect(ok).toBe(true)
      expect(prisma.catalogEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PENDING', attempts: 0 }),
        }),
      )
    })

    it('deleteDeadLetter removes the record', async () => {
      vi.mocked(prisma.catalogDeadLetter.delete).mockResolvedValue({} as any)
      expect(await deleteDeadLetter('dl-1')).toBe(true)
    })

    it('replayDeadLetter on non-existent returns false', async () => {
      vi.mocked(prisma.catalogDeadLetter.findUnique).mockResolvedValue(null)
      expect(await replayDeadLetter('missing')).toBe(false)
    })
  })

  describe('9. Edge Cases', () => {
    it('replayEvent on non-existent returns false', async () => {
      vi.mocked(prisma.catalogEvent.findUnique).mockResolvedValue(null)
      expect(await replayEvent('missing')).toBe(false)
    })

    it('replayEvent on PENDING returns false', async () => {
      vi.mocked(prisma.catalogEvent.findUnique).mockResolvedValue({ id: 'p', status: 'PENDING' } as any)
      expect(await replayEvent('p')).toBe(false)
    })

    it('retryEvent on non-existent returns false', async () => {
      vi.mocked(prisma.catalogEvent.update).mockRejectedValue(new Error('Not found'))
      expect(await retryEvent('missing')).toBe(false)
    })

    it('acquireGroupLock on DB error returns false', async () => {
      vi.mocked(prisma.maintenanceJob.create).mockRejectedValue(new Error('DB error'))
      expect(await acquireGroupLock('key', 'w')).toBe(false)
    })

    it('releaseGroupLock does not throw', async () => {
      vi.mocked(prisma.maintenanceJob.upsert).mockResolvedValue({} as any)
      await expect(releaseGroupLock('key')).resolves.toBeUndefined()
    })
  })
})
