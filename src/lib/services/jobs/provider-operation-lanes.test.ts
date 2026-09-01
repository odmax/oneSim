import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockPrismaDb = vi.hoisted(() => ({
  backgroundJob: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
  },
  provider: { findMany: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: mockPrismaDb }))

import { prisma } from '@/lib/prisma'
import { admitProviderOperation, refreshLanedProviders, providerOperationLaneGate, type LaneGateJob } from './provider-operation-lanes'

const mock = vi.mocked(prisma)

function makeTx(options: { config?: any; count?: number; claimCount?: number; providerRow?: boolean }) {
  const raw = options.providerRow === false ? [] : [{ config: options.config ?? {} }]
  return {
    $queryRaw: vi.fn().mockResolvedValue(raw),
    backgroundJob: {
      count: vi.fn().mockResolvedValue(options.count ?? 0),
      updateMany: vi.fn().mockResolvedValue({ count: options.claimCount ?? 1 }),
    },
  }
}

function laneJob(overrides: Partial<LaneGateJob> = {}): LaneGateJob {
  return { id: 'job-1', type: 'PROVIDER_OPERATION', payload: { providerId: 'p1', operation: 'purchase' }, providerId: 'p1', ...overrides }
}

const PROVIDERS_LANED = [{ id: 'p1', config: { execution: { purchaseConcurrency: 2, statusConcurrency: 5 } } }]

beforeEach(() => {
  vi.clearAllMocks()
  mock.$transaction.mockImplementation((cb: any) => cb(makeTx({ config: { execution: { purchaseConcurrency: 2 } }, count: 0 })))
  mock.provider.findMany.mockResolvedValue(PROVIDERS_LANED)
})

afterEach(() => {
  // Refresh force-empty so membership never leaks across the module.
  mock.provider.findMany.mockResolvedValueOnce([])
  void refreshLanedProviders(true)
})

describe('provider operation lane admission (distributed-safe)', () => {
  it('lane membership hydrates from provider.config.execution', async () => {
    const n = await refreshLanedProviders(true)
    expect(n).toBe(1)
  })

  it('admits + claims when provider lane has capacity (count < limit)', async () => {
    const tx = makeTx({ config: { execution: { purchaseConcurrency: 2 } }, count: 1, claimCount: 1 })
    mock.$transaction.mockImplementation((cb: any) => cb(tx))
    const ok = await admitProviderOperation('job-1', 'p1', 'PURCHASE_ESIM')
    expect(ok).toBe(true)
    expect(tx.$queryRaw).toHaveBeenCalled()
    expect(tx.backgroundJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'job-1', status: 'PENDING' } }))
  })

  it('DEFERS (returns false, no claim) when provider lane is at limit', async () => {
    const tx = makeTx({ config: { execution: { purchaseConcurrency: 2 } }, count: 2 })
    mock.$transaction.mockImplementation((cb: any) => cb(tx))
    const ok = await admitProviderOperation('job-1', 'p1', 'PURCHASE_ESIM')
    expect(ok).toBe(false)
    expect(tx.backgroundJob.updateMany).not.toHaveBeenCalled()
  })

  it('DEFERS when over limit', async () => {
    const tx = makeTx({ config: { execution: { purchaseConcurrency: 2 } }, count: 5 })
    mock.$transaction.mockImplementation((cb: any) => cb(tx))
    expect(await admitProviderOperation('job-1', 'p1', 'PURCHASE_ESIM')).toBe(false)
  })

  it('missing provider row does NOT strand the job — claims so the handler reconciles', async () => {
    const tx = makeTx({ providerRow: false, claimCount: 1 })
    mock.$transaction.mockImplementation((cb: any) => cb(tx))
    const ok = await admitProviderOperation('job-1', 'missing', 'PURCHASE_ESIM')
    expect(ok).toBe(true)
    expect(tx.backgroundJob.updateMany).toHaveBeenCalled()
  })

  it('status operations use statusConcurrency', async () => {
    const tx = makeTx({ config: { execution: { purchaseConcurrency: 2, statusConcurrency: 5 } }, count: 5 })
    mock.$transaction.mockImplementation((cb: any) => cb(tx))
    // 5 in flight is ≥ statusConcurrency? No: 5 < ...? 5 >= 5 → defer.
    expect(await admitProviderOperation('job-1', 'p1', 'GET_STATUS')).toBe(false)
    const tx2 = makeTx({ config: { execution: { purchaseConcurrency: 2, statusConcurrency: 5 } }, count: 4, claimCount: 1 })
    mock.$transaction.mockImplementation((cb: any) => cb(tx2))
    expect(await admitProviderOperation('job-2', 'p1', 'GET_STATUS')).toBe(true)
  })

  it('lane gate: non-laned provider and non-provider-operation jobs use the plain claim (0 lane queries)', async () => {
    await refreshLanedProviders(true) // hydrates p1 as laned
    mock.backgroundJob.updateMany.mockResolvedValue({ count: 1 })
    const gate = providerOperationLaneGate()

    // provider p2 is NOT laned → plain claim via prisma.backgroundJob.updateMany.
    const okP2 = await gate(laneJob({ id: 'job-p2', providerId: 'p2', payload: { providerId: 'p2', operation: 'purchase' } }))
    expect(okP2).toBe(true)
    // non-provider-operation type → plain claim.
    const okEmail = await gate({ id: 'job-e', type: 'EMAIL_DELIVERY', payload: {}, providerId: null })
    expect(okEmail).toBe(true)
    // The plain claim never opened a transaction.
    expect(mock.$transaction).not.toHaveBeenCalled()
  })

  it('lane gate: laned provider goes through transaction admission', async () => {
    await refreshLanedProviders(true)
    const tx = makeTx({ config: { execution: { purchaseConcurrency: 2 } }, count: 1, claimCount: 1 })
    mock.$transaction.mockImplementation((cb: any) => cb(tx))
    const gate = providerOperationLaneGate()
    await expect(gate(laneJob())).resolves.toBe(true)
    expect(mock.$transaction).toHaveBeenCalled()
  })

  it('lane gate: laned provider at limit defers the job (stays PENDING)', async () => {
    await refreshLanedProviders(true)
    const tx = makeTx({ config: { execution: { purchaseConcurrency: 2 } }, count: 2 })
    mock.$transaction.mockImplementation((cb: any) => cb(tx))
    const gate = providerOperationLaneGate()
    await expect(gate(laneJob())).resolves.toBe(false)
    expect(tx.backgroundJob.updateMany).not.toHaveBeenCalled()
  })
})