import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn<() => Promise<any>>(),
  findFirst: vi.fn<() => Promise<any>>(),
  updateMany: vi.fn<() => Promise<any>>(),
  auditCreate: vi.fn<() => Promise<any>>(),
  transaction: vi.fn<() => Promise<any>>(),
  revalidate: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIM: { findFirst: mocks.findFirst },
    auditLog: { create: mocks.auditCreate },
    $transaction: mocks.transaction,
  },
}))
vi.mock('next-auth', () => ({ getServerSession: mocks.session }))
vi.mock('@/lib/auth/config', () => ({ authOptions: {} }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }))

import { confirmEsimInstalledAction } from './esim-confirm-installed'

const pendingEsim = { id: 'esim-1', customerConfirmedInstalledAt: null }
const alreadyConfirmed = { id: 'esim-1', customerConfirmedInstalledAt: new Date('2026-10-01T00:00:00Z') }

/** Run the interactive transaction with a tx client whose eSIM.write/updateMany links to the mocks. */
function runTransaction(fn: (tx: any) => Promise<any>): Promise<any> {
  return fn({
    eSIM: { updateMany: mocks.updateMany },
    auditLog: { create: mocks.auditCreate },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findFirst.mockReset()
  mocks.updateMany.mockReset()
  mocks.auditCreate.mockReset()
  mocks.transaction.mockReset()
  mocks.transaction.mockImplementation(runTransaction as any)
  mocks.session.mockResolvedValue({ user: { role: 'BUSINESS_USER', id: 'user-1', businessId: 'business-1' } })
  mocks.findFirst.mockResolvedValue(pendingEsim)
  mocks.updateMany.mockResolvedValue({ count: 1 })
  mocks.auditCreate.mockResolvedValue({ id: 'log-1' })
})

describe('confirmEsimInstalledAction — authorization', () => {
  it('rejects unauthenticated callers before touching the database', async () => {
    mocks.session.mockResolvedValue(null)
    const result = await confirmEsimInstalledAction('esim-1')
    expect(result).toEqual({ ok: false, error: 'Not authorized' })
    expect(mocks.findFirst).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('rejects a business user confirming another business’s eSIM', async () => {
    mocks.findFirst.mockResolvedValue(null)
    const result = await confirmEsimInstalledAction('esim-other')
    expect(result).toEqual({ ok: false, error: 'Forbidden' })
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'esim-other', purchase: { businessId: 'business-1' } } }),
    )
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.auditCreate).not.toHaveBeenCalled()
  })

  it('lets an INTERNAL_ADMIN confirm any eSIM', async () => {
    mocks.session.mockResolvedValue({ user: { role: 'INTERNAL_ADMIN', id: 'admin-1' } })
    const result = await confirmEsimInstalledAction('esim-1')
    expect(result).toEqual({ ok: true })
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'esim-1' } }))
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['missing businessId', { role: 'BUSINESS_USER', id: 'user-1' }],
    ['empty businessId', { role: 'BUSINESS_USER', id: 'user-1', businessId: '' }],
    ['whitespace businessId', { role: 'BUSINESS_USER', id: 'user-1', businessId: '   ' }],
  ])('rejects a BUSINESS_USER with %s before ANY database query', async (_label, user) => {
    mocks.session.mockResolvedValue({ user })
    const result = await confirmEsimInstalledAction('esim-1')
    // The runtime tenant guard fails closed with no businessId to scope by.
    expect(result).toEqual({ ok: false, error: 'Forbidden' })
    expect(mocks.findFirst).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.auditCreate).not.toHaveBeenCalled()
  })
})

describe('confirmEsimInstalledAction — atomicity and provider-field isolation', () => {
  it('writes the timestamp and the CUSTOMER_CONFIRMED_INSTALLED audit row in ONE transaction', async () => {
    const result = await confirmEsimInstalledAction('esim-1')
    expect(result).toEqual({ ok: true })
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.updateMany).toHaveBeenCalledTimes(1)
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1)
    // The timestamp update is conditional on the column still being null.
    const [{ where, data }] = mocks.updateMany.mock.calls[0]
    expect(where).toEqual({ id: 'esim-1', customerConfirmedInstalledAt: null })
    expect(Object.keys(data)).toEqual(['customerConfirmedInstalledAt'])
    expect(data.customerConfirmedInstalledAt).toBeInstanceOf(Date)
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        action: 'CUSTOMER_CONFIRMED_INSTALLED',
        entity: 'ESIM',
        entityId: 'esim-1',
        details: 'Customer confirmed eSIM installed',
      },
    })
  })

  it('unit-level write isolation: writes only the confirmation column and keeps provider evidence intact on a stateful mock read-back', async () => {
    // This is a UNIT test of the action's write payload and audit actor using a
    // stateful Prisma mock as a stand-in for the database row. It does NOT
    // exercise a real database read; real read-back persistence is only proven
    // by a database integration test against a local DB (none is used here, and
    // staging/production are never accessed).
    const original = {
      ...pendingEsim,
      status: 'PENDING_ACTIVATION',
      installationStatus: 'READY',
      providerStatus: 'ACTIVE',
      activationCode: 'LPA:1$smdp$mid',
    }
    const persisted: any = { ...original }
    mocks.findFirst.mockResolvedValueOnce(original)
    // The mock "commits" the conditional update into the stand-in row, mirroring
    // what a real DB transaction would persist for the confirmation column only.
    mocks.updateMany.mockImplementation(async ({ data }: any) => {
      persisted.customerConfirmedInstalledAt = data.customerConfirmedInstalledAt
      return { count: 1 }
    })

    await confirmEsimInstalledAction('esim-1')

    // The write carried ONLY the confirmation column (provider fields not in data).
    const [{ data }] = mocks.updateMany.mock.calls[0]
    expect(Object.keys(data)).toEqual(['customerConfirmedInstalledAt'])

    // A subsequent read of the stand-in row returns the recorded timestamp and the
    // ORIGINAL provider evidence unchanged — the action wrote nothing else.
    expect(persisted.customerConfirmedInstalledAt).toBe(data.customerConfirmedInstalledAt)
    expect(persisted.status).toBe('PENDING_ACTIVATION')
    expect(persisted.installationStatus).toBe('READY')
    expect(persisted.providerStatus).toBe('ACTIVE')
    expect(persisted.activationCode).toBe('LPA:1$smdp$mid')
    // The audit actor is recorded alongside the timestamp.
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user-1', entityId: 'esim-1', action: 'CUSTOMER_CONFIRMED_INSTALLED' }),
    })
  })

  it('is idempotent: an existing confirmation is an immediate no-op (no transaction, no audit)', async () => {
    mocks.findFirst.mockResolvedValue(alreadyConfirmed)
    const result = await confirmEsimInstalledAction('esim-1')
    expect(result).toEqual({ ok: true, alreadyConfirmed: true })
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.auditCreate).not.toHaveBeenCalled()
  })
})

describe('confirmEsimInstalledAction — concurrent requests (unit-level branch coverage)', () => {
  it('exactly one of two racing requests claims the row and creates the audit entry', async () => {
    // UNIT test of the winning/losing BRANCHES of the conditional updateMany
    // (count=1 → winner writes the audit row; count=0 → loser reports the
    // idempotent no-op). It uses mocked updateMany results and does NOT prove
    // real PostgreSQL concurrency — that requires a local database integration
    // test, which is out of scope here (staging/production are never accessed).
    // Both requests pass the read (column still null), then race for the claim.
    mocks.findFirst.mockResolvedValue(pendingEsim)
    mocks.updateMany
      .mockResolvedValueOnce({ count: 1 }) // request A wins the conditional claim
      .mockResolvedValueOnce({ count: 0 }) // request B loses (already claimed)

    const [a, b] = await Promise.all([
      confirmEsimInstalledAction('esim-1'),
      confirmEsimInstalledAction('esim-1'),
    ])

    expect(a).toEqual({ ok: true })
    expect(b).toEqual({ ok: true, alreadyConfirmed: true })
    // Exactly one timestamp claim and one audit row for the whole race.
    expect(mocks.updateMany).toHaveBeenCalledTimes(2)
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1)
  })
})