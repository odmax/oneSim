import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockOpFindUnique,
  mockOpCreate,
  mockOpUpdateMany,
  mockOpUpdate,
  mockLockUpsert,
  mockLockFindUnique,
  mockLockDelete,
} = vi.hoisted(() => ({
  mockOpFindUnique: vi.fn(),
  mockOpCreate: vi.fn(),
  mockOpUpdateMany: vi.fn(),
  mockOpUpdate: vi.fn(),
  mockLockUpsert: vi.fn(),
  mockLockFindUnique: vi.fn(),
  mockLockDelete: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    upstreamPackageCreationOperation: {
      findUnique: mockOpFindUnique,
      create: mockOpCreate,
      updateMany: mockOpUpdateMany,
      update: mockOpUpdate,
    },
    systemJobLock: { upsert: mockLockUpsert, findUnique: mockLockFindUnique, delete: mockLockDelete },
  },
}))

import {
  isAllowedTransition,
  loadOrCreateUpstreamOperation,
  acquireUpstreamOperationLease,
  transitionUpstreamOperation,
  markUpstreamOperationFailed,
  markUpstreamOperationAmbiguous,
  markUpstreamOperationAlreadyExists,
  isUpstreamOperationLeaseActive,
  releaseUpstreamOperationLease,
  UPSTREAM_OP_STATUS,
} from './upstream-operation-service'

describe('upstream-operation-service — state machine', () => {
  beforeEach(() => vi.clearAllMocks())

  it('allows only safe transitions', () => {
    expect(isAllowedTransition('PENDING', 'UPSTREAM_IN_PROGRESS')).toBe(true)
    expect(isAllowedTransition('UPSTREAM_IN_PROGRESS', 'UPSTREAM_SUCCEEDED')).toBe(true)
    expect(isAllowedTransition('UPSTREAM_SUCCEEDED', 'COMPLETED')).toBe(true)
    expect(isAllowedTransition('PARTIAL_FAILURE', 'COMPLETED')).toBe(true)
    // Reverse / illegal transitions are blocked.
    expect(isAllowedTransition('COMPLETED', 'UPSTREAM_IN_PROGRESS')).toBe(false)
    expect(isAllowedTransition('FAILED', 'UPSTREAM_IN_PROGRESS')).toBe(false)
    expect(isAllowedTransition('COMPLETED', 'FAILED')).toBe(false)
  })

  it('transition uses CAS updateMany with status predicate and returns whether it won', async () => {
    mockOpUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    expect(await transitionUpstreamOperation('op-1', 'PENDING', 'UPSTREAM_IN_PROGRESS', { upstreamStartedAt: new Date() })).toBe(true)
    // The updateMany where must include the expected current status.
    const where = mockOpUpdateMany.mock.calls[0][0].where
    expect(where.id).toBe('op-1')
    expect(where.status).toBe('PENDING')
    expect(await transitionUpstreamOperation('op-1', 'PENDING', 'UPSTREAM_IN_PROGRESS')).toBe(false)
  })

  it('rejects an illegal transition outright', async () => {
    await expect(transitionUpstreamOperation('op-1', 'COMPLETED', 'FAILED')).rejects.toThrow('Invalid upstream operation transition')
    expect(mockOpUpdateMany).not.toHaveBeenCalled()
  })
})

describe('upstream-operation-service — load-or-create + idempotency', () => {
  const base = {
    idempotencyKey: 'cpb_upstream_key1',
    requestFingerprint: 'fp-abc',
    providerId: 'prov-choice',
    providerCode: 'CHOICE',
    requestedSku: 'TZN-5GB-7D',
  }

  beforeEach(() => vi.clearAllMocks())

  it('creates a PENDING operation row when the key does not exist', async () => {
    mockOpFindUnique.mockResolvedValue(null)
    mockOpCreate.mockResolvedValue({ id: 'op-1', requestFingerprint: 'fp-abc', status: 'PENDING', idempotencyKey: 'cpb_upstream_key1' })
    const r = await loadOrCreateUpstreamOperation(base)
    expect(r.existing).toBe(false)
    expect(r.conflict).toBe(false)
    expect(mockOpCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ idempotencyKey: 'cpb_upstream_key1', requestFingerprint: 'fp-abc', status: 'PENDING' }) }))
  })

  it('returns existing operation when key + fingerprint match (safe resume)', async () => {
    mockOpFindUnique.mockResolvedValue({ id: 'op-1', requestFingerprint: 'fp-abc', status: 'UPSTREAM_SUCCEEDED', idempotencyKey: 'cpb_upstream_key1' })
    const r = await loadOrCreateUpstreamOperation(base)
    expect(r.existing).toBe(true)
    expect(r.conflict).toBe(false)
    expect(mockOpCreate).not.toHaveBeenCalled()
  })

  it('rejects replay with a different fingerprint (IDEMPOTENCY_CONFLICT semantics)', async () => {
    mockOpFindUnique.mockResolvedValue({ id: 'op-1', requestFingerprint: 'fp-DIFFERENT', status: 'COMPLETED', idempotencyKey: 'cpb_upstream_key1' })
    const r = await loadOrCreateUpstreamOperation(base)
    expect(r.existing).toBe(true)
    expect(r.conflict).toBe(true)
    expect(r.conflictReason).toContain('different request')
    expect(mockOpCreate).not.toHaveBeenCalled()
  })

  it('handles a P2002 create race by re-reading (another request won)', async () => {
    mockOpFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'op-race', requestFingerprint: 'fp-abc', status: 'PENDING', idempotencyKey: 'cpb_upstream_key1' })
    mockOpCreate.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }))
    const r = await loadOrCreateUpstreamOperation(base)
    expect(r.existing).toBe(true)
    expect(r.conflict).toBe(false)
  })
})

describe('upstream-operation-service — lease', () => {
  beforeEach(() => vi.clearAllMocks())

  it('acquires a durable SystemJobLock lease (DB-backed, not in-memory)', async () => {
    mockLockUpsert.mockResolvedValue({ id: 'lock-1' })
    const r = await acquireUpstreamOperationLease('op-1')
    expect(r.acquired).toBe(true)
    const call = mockLockUpsert.mock.calls[0][0]
    expect(call.create.jobName).toContain('cpb-upstream-op:op-1')
  })

  it('reports not-acquired when the lease upsert fails (concurrent writer)', async () => {
    mockLockUpsert.mockRejectedValue(new Error('lock failed'))
    const r = await acquireUpstreamOperationLease('op-1')
    expect(r.acquired).toBe(false)
  })

  it('isUpstreamOperationLeaseActive: true while the lease is fresh', async () => {
    mockLockFindUnique.mockResolvedValue({ lockedUntil: new Date(Date.now() + 60_000) })
    expect(await isUpstreamOperationLeaseActive('op-1')).toBe(true)
  })

  it('isUpstreamOperationLeaseActive: false once the lease has expired', async () => {
    mockLockFindUnique.mockResolvedValue({ lockedUntil: new Date(Date.now() - 5_000) })
    expect(await isUpstreamOperationLeaseActive('op-1')).toBe(false)
  })

  it('isUpstreamOperationLeaseActive: false when no lock row exists', async () => {
    mockLockFindUnique.mockResolvedValue(null)
    expect(await isUpstreamOperationLeaseActive('op-1')).toBe(false)
  })

  it('isUpstreamOperationLeaseActive: false on DB error (fail-closed, never assumes active)', async () => {
    mockLockFindUnique.mockRejectedValue(new Error('db down'))
    expect(await isUpstreamOperationLeaseActive('op-1')).toBe(false)
  })

  it('releaseUpstreamOperationLease deletes the lock best-effort', async () => {
    mockLockDelete.mockResolvedValue({})
    await releaseUpstreamOperationLease('op-1')
    expect(mockLockDelete).toHaveBeenCalledWith({ where: { jobName: 'cpb-upstream-op:op-1' } })
    // Never throws on a missing lock.
    mockLockDelete.mockRejectedValueOnce({ code: 'P2025' })
    await expect(releaseUpstreamOperationLease('op-1')).resolves.toBeUndefined()
  })
})

describe('upstream-operation-service — safe terminal marks', () => {
  beforeEach(() => vi.clearAllMocks())

  it('markUpstreamOperationFailed stores safe error only', async () => {
    mockOpUpdate.mockResolvedValue({})
    await markUpstreamOperationFailed('op-1', { code: 'INVALID_REQUEST', message: 'bad input' })
    const data = mockOpUpdate.mock.calls[0][0].data
    expect(data.status).toBe(UPSTREAM_OP_STATUS.FAILED)
    expect(data.lastErrorCode).toBe('INVALID_REQUEST')
    expect(data.lastErrorMessageSafe).toBe('bad input')
  })

  it('markUpstreamOperationAmbiguous stores AMBIGUOUS_UPSTREAM_RESULT + startedAt', async () => {
    mockOpUpdate.mockResolvedValue({})
    await markUpstreamOperationAmbiguous('op-1', { code: 'TIMEOUT', message: 'timed out after dispatch' })
    const data = mockOpUpdate.mock.calls[0][0].data
    expect(data.status).toBe(UPSTREAM_OP_STATUS.AMBIGUOUS_UPSTREAM_RESULT)
    expect(data.upstreamStartedAt).toBeInstanceOf(Date)
  })

  it('markUpstreamOperationAlreadyExists stores UPSTREAM_ALREADY_EXISTS + reference', async () => {
    mockOpUpdate.mockResolvedValue({})
    await markUpstreamOperationAlreadyExists('op-1', { reference: 'TZN-5GB-7D', message: 'already exists' })
    const data = mockOpUpdate.mock.calls[0][0].data
    expect(data.status).toBe(UPSTREAM_OP_STATUS.UPSTREAM_ALREADY_EXISTS)
    expect(data.upstreamReference).toBe('TZN-5GB-7D')
  })
})