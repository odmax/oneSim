import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn<() => Promise<any>>(),
  admin: vi.fn<() => Promise<any>>(),
  ppFind: vi.fn<() => Promise<any>>(),
  ppUpdate: vi.fn<() => Promise<any>>(),
  updateMany: vi.fn<() => Promise<any>>(),
  orderFind: vi.fn<() => Promise<any>>(),
  orderUpdate: vi.fn<() => Promise<any>>(),
  eSIMFind: vi.fn<() => Promise<any>>(),
  revalidate: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    internalAdmin: { findUnique: mocks.admin },
    providerPackage: { findUnique: mocks.ppFind, update: mocks.ppUpdate, updateMany: mocks.updateMany },
    order: { findUnique: mocks.orderFind, update: mocks.orderUpdate },
    eSIM: { findUnique: mocks.eSIMFind },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}))
vi.mock('next-auth', () => ({ getServerSession: mocks.session }))
vi.mock('@/lib/auth/config', () => ({ authOptions: {} }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }))

import { markReadyToPublish } from './imported-plans'
import { retryFailedOrder } from './order-actions'
import { telnaGetAnalytics } from './telna-usage-analytics'

const adminSession = () => ({ user: { id: 'admin-1', role: 'INTERNAL_ADMIN', email: 'a@x.com' } })

function row(role: string, permissions: string[] | null) {
  return { id: 'a1', role, isActive: true, permissions }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.mockResolvedValue(adminSession())
  mocks.ppFind.mockResolvedValue({ id: 'pkg-1', name: 'Pkg', publishedAs: { costPriceUSD: '5', priceUSD: '10' } })
  mocks.updateMany.mockResolvedValue({ count: 1 })
  mocks.orderFind.mockResolvedValue(null)
  mocks.orderUpdate.mockResolvedValue({ id: 'o1' })
  mocks.eSIMFind.mockResolvedValue({ id: 'e1', usageRecords: [] })
})

describe('admin server actions â€” a user LACKING the permission is denied before any DB write', () => {
  it('markReadyToPublish denies a MANAGE-PROVIDERS action before providerPackage.updateMany', async () => {
    mocks.admin.mockResolvedValue(row('ADMIN', ['VIEW_PROVIDERS'])) // view only
    const r: any = await markReadyToPublish('pkg-1')
    expect(r).toMatchObject({ success: false, error: 'Unauthorized' })
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it('retryFailedOrder denies a MANAGE-ORDERS action before order.update', async () => {
    mocks.admin.mockResolvedValue(row('ADMIN', ['VIEW_ORDERS']))
    await expect(retryFailedOrder('order-1')).rejects.toThrow('Unauthorized')
    expect(mocks.orderUpdate).not.toHaveBeenCalled()
  })

  it('telnaGetAnalytics denies a VIEW-ANALYTICS read before the eSIM query', async () => {
    mocks.admin.mockResolvedValue(row('ADMIN', ['VIEW_ESIMS'])) // not analytics
    await expect(telnaGetAnalytics('esim-1')).rejects.toThrow('Unauthorized')
    expect(mocks.eSIMFind).not.toHaveBeenCalled()
  })

  it('a deactivated admin row denies access', async () => {
    mocks.admin.mockResolvedValue({ id: 'a1', role: 'SUPER_ADMIN', isActive: false, permissions: null })
    const r: any = await markReadyToPublish('pkg-1')
    expect(r).toMatchObject({ success: false, error: 'Unauthorized' })
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })
})

describe('admin server actions â€” a granted user proceeds', () => {
  it('markReadyToPublish proceeds when the MANAGE_PROVIDERS permission is present', async () => {
    mocks.admin.mockResolvedValue(row('ADMIN', ['MANAGE_PROVIDERS']))
    await markReadyToPublish('pkg-1')
    expect(mocks.ppUpdate).toHaveBeenCalled()
  })
})

describe('admin server actions â€” SUPER_ADMIN bypass', () => {
  it('markReadyToPublish proceeds for SUPER_ADMIN even with a legacy null permission list', async () => {
    mocks.admin.mockResolvedValue(row('SUPER_ADMIN', null))
    await markReadyToPublish('pkg-1')
    expect(mocks.ppUpdate).toHaveBeenCalled()
  })

  it('retryFailedOrder proceeds for SUPER_ADMIN (DB role not the session claim)', async () => {
    mocks.admin.mockResolvedValue(row('SUPER_ADMIN', null))
    await expect(retryFailedOrder('order-1')).not.rejects.toThrow('Unauthorized')
  })
})
