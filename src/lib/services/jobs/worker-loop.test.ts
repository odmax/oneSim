import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./queue', () => ({
  processDueJobs: vi.fn().mockResolvedValue([]),
}))

vi.mock('./provider-operation-lanes', () => ({
  refreshLanedProviders: vi.fn().mockResolvedValue(0),
  providerOperationLaneGate: vi.fn().mockReturnValue(async () => true),
}))

import { processDueJobs } from './queue'
import { workerTick, startJobWorkerLoop } from './worker-loop'

const mockProcess = vi.mocked(processDueJobs)

describe('low-latency job worker loop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProcess.mockResolvedValue([])
  })

  it('each tick claims purchase jobs FIRST, then all other jobs (no starvation)', async () => {
    await workerTick()

    expect(mockProcess).toHaveBeenNthCalledWith(1, expect.objectContaining({ types: ['PROVIDER_OPERATION'], limit: 5 }))
    expect(mockProcess).toHaveBeenNthCalledWith(1, expect.objectContaining({ laneGate: expect.any(Function) }))
    expect(mockProcess).toHaveBeenNthCalledWith(2, { limit: 10 })
  })

  it('starts at most one loop per process and polls continuously while idle', async () => {
    vi.useFakeTimers()
    try {
      startJobWorkerLoop()
      startJobWorkerLoop() // second call must be a no-op

      // First tick fires immediately (priority + general pass).
      await vi.advanceTimersByTimeAsync(0)
      expect(mockProcess).toHaveBeenCalledTimes(2)

      // Idle cadence ~1s keeps pickup latency low without hammering the DB.
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockProcess).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('loops again immediately after processing fresh purchase work (no idle wait)', async () => {
    vi.useFakeTimers()
    try {
      mockProcess.mockImplementation(async (opts: any) => {
        if (opts && typeof opts === 'object' && opts.types?.includes('PROVIDER_OPERATION')) return [{ id: 'j', type: 'PROVIDER_OPERATION', status: 'COMPLETED' }]
        return []
      })

      const { startJobWorkerLoop: start } = await import('./worker-loop')
      // The per-process guard may already be set by the previous test; emulate a
      // fresh process for this scenario.
      ;(globalThis as any).__onesimJobWorkerStarted = false
      start()

      await vi.advanceTimersByTimeAsync(0)
      const callsAfterFirstTick = mockProcess.mock.calls.length
      expect(callsAfterFirstTick).toBeGreaterThanOrEqual(2)

      // Because the priority pass processed a purchase, the next tick must be
      // scheduled WITHOUT waiting the full idle interval.
      await vi.advanceTimersByTimeAsync(1)
      expect(mockProcess.mock.calls.length).toBeGreaterThan(callsAfterFirstTick)
    } finally {
      vi.useRealTimers()
      ;(globalThis as any).__onesimJobWorkerStarted = false
    }
  })
})
