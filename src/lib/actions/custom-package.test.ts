import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetServerSession } = vi.hoisted(() => ({ mockGetServerSession: vi.fn() }))
const { mockRevalidateCatalogRoutes } = vi.hoisted(() => ({ mockRevalidateCatalogRoutes: vi.fn() }))
const { mockCheckPermission } = vi.hoisted(() => ({ mockCheckPermission: vi.fn() }))

vi.mock('@/lib/auth/config', () => ({ authOptions: {} }))
vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`) } }))
vi.mock('@/lib/services/catalog-price-sync', () => ({ revalidateCatalogRoutes: mockRevalidateCatalogRoutes }))
vi.mock('@/lib/auth/permissions', () => ({
  checkPermission: mockCheckPermission,
  Permissions: { MANAGE_PRODUCTS: 'MANAGE_PRODUCTS' },
}))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    providerPackage: { findMany: vi.fn() },
    eSIMPackage: { create: vi.fn() },
    eSIMPackageProviderBinding: { create: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}))

import { prisma } from '@/lib/prisma'
import { createCustomPackage } from './custom-package'

const mockPrisma = vi.mocked(prisma)

function form(values: Record<string, string | string[]>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(values)) {
    if (Array.isArray(v)) for (const item of v) fd.append(k, item)
    else fd.append(k, v)
  }
  return fd
}

function cf(options: {
  name?: string; dataGB?: string; validityDays?: string; sellingPrice?: string; currency?: string;
  providerPackageIds: string[]; providerIds?: string[]; priorities?: string[]; enabledFlags?: string[];
}) {
  const fd = new FormData()
  fd.set('name', options.name || 'Africa 10GB 30d')
  fd.set('dataGB', options.dataGB || '10')
  fd.set('validityDays', options.validityDays || '30')
  fd.set('sellingPrice', options.sellingPrice || '29.99')
  fd.set('currency', options.currency || 'USD')
  fd.set('compatibilityPolicy', 'AT_LEAST')
  for (const id of options.providerPackageIds) fd.append('providerPackageIds', id)
  for (const id of options.providerIds || []) fd.append('providerIds', id)
  for (const p of options.priorities || []) fd.append('priorities', p)
  for (const e of options.enabledFlags || []) fd.append('enabledFlags', e)
  return fd
}

function adminSession() {
  return { user: { role: 'INTERNAL_ADMIN', id: 'admin-1' } }
}

function backingRow(id: string, overrides: any = {}) {
  return {
    id,
    providerId: 'p-1',
    name: 'Backing ' + id,
    dataGB: 12,
    validityDays: 60,
    country: 'ZAF',
    region: null,
    configurationStatus: 'CONFIGURED',
    publishStatus: 'PUBLISHED',
    sellingPrice: 5,
    costPrice: 2,
    currency: 'USD',
    provider: { id: 'p-1', name: 'Prov', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'] },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetServerSession.mockResolvedValue(adminSession() as any)
  mockCheckPermission.mockResolvedValue({ allowed: true, role: 'INTERNAL_ADMIN' })
  mockRevalidateCatalogRoutes.mockResolvedValue(undefined)
  mockPrisma.eSIMPackage.create.mockResolvedValue({ id: 'esim-custom-1' } as any)
  mockPrisma.auditLog.create.mockResolvedValue({ id: 'a' } as any)
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn({
    eSIMPackage: { create: mockPrisma.eSIMPackage.create },
    eSIMPackageProviderBinding: { create: vi.fn().mockResolvedValue({ id: 'b' }) },
  }))
})

describe('createCustomPackage (server action)', () => {
  it('creates exactly one retail custom eSIMPackage + bindings, never calls any provider create', async () => {
    mockPrisma.providerPackage.findMany.mockResolvedValue([backingRow('pp-1'), backingRow('pp-2')] as any)

    // Success path redirects (mock throws). Assert it redirected to provider-catalog
    // and the local records were created exactly once.
    await expect(createCustomPackage(cf({
      name: 'Africa 10GB 30d',
      dataGB: '10',
      validityDays: '30',
      sellingPrice: '29.99',
      providerPackageIds: ['pp-2', 'pp-1'], // admin priority order preserved
      providerIds: ['p-1', 'p-1'],
      priorities: ['1', '2'],
    }))).rejects.toThrow('REDIRECT:/admin/packages')

    // Exactly one retail package created.
    expect(mockPrisma.eSIMPackage.create).toHaveBeenCalledTimes(1)
    expect(mockPrisma.eSIMPackage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ name: 'Africa 10GB 30d', dataGB: 10, validityDays: 30, priceUSD: 29.99, source: 'CATALOG_PRODUCT', providerPackageId: null }),
    }))
    // $transaction is used for ATOMIC package + binding creation.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    // Priority order preserved (pp-2 first).
    const txFn = mockPrisma.$transaction.mock.calls[0][0] as (tx: any) => Promise<void>
    const txCreate = vi.fn().mockResolvedValue({ id: 'b' })
    await txFn({ eSIMPackage: { create: vi.fn().mockResolvedValue({ id: 'esim-custom-1' }) }, eSIMPackageProviderBinding: { create: txCreate } })
    expect(txCreate).toHaveBeenCalledTimes(2)
    expect(txCreate.mock.calls[0][0].data.priority).toBe(1)
    expect(txCreate.mock.calls[0][0].data.providerPackageId).toBe('pp-2')
    // Audit entries recorded.
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'CUSTOM_PACKAGE_CREATED' }) }))
  })

  it('rejects when no enabled backing ProviderPackage is selected (before any provider call)', async () => {
    const r = await createCustomPackage(cf({ providerPackageIds: [] }))
    expect(r).toEqual({ success: false, error: 'At least one enabled backing ProviderPackage is required' })
    expect(mockPrisma.eSIMPackage.create).not.toHaveBeenCalled()
    expect(mockPrisma.providerPackage.findMany).not.toHaveBeenCalled()
  })

  it('rejects invalid selling price server-side', async () => {
    const r = await createCustomPackage(cf({ sellingPrice: '0', providerPackageIds: ['pp-1'], providerIds: ['p-1'], priorities: ['1'] }))
    expect(r).toEqual({ success: false, error: 'Selling price must be > 0' })
    expect(mockPrisma.eSIMPackage.create).not.toHaveBeenCalled()
  })

  it('rejects incompatible/unpurchasable backings — nothing local created', async () => {
    mockPrisma.providerPackage.findMany.mockResolvedValue([
      backingRow('pp-small', { dataGB: 5, validityDays: 30 }), // incompatible (5GB < 10GB)
      backingRow('pp-unconfigured', { configurationStatus: 'UNCONFIGURED' }),
    ] as any)
    const r = await createCustomPackage(cf({
      providerPackageIds: ['pp-small', 'pp-unconfigured'],
      providerIds: ['p-1', 'p-1'],
      priorities: ['1', '2'],
    }))
    expect(r).toEqual({ success: false, error: 'None of the selected ProviderPackages can fulfill this custom package (compatibility/purchase-readiness failed)' })
    expect(mockPrisma.eSIMPackage.create).not.toHaveBeenCalled()
  })

  it('enforces admin permission (no provider create on failure)', async () => {
    mockGetServerSession.mockResolvedValue({ user: { role: 'BUSINESS_USER', id: 'b' } } as any)
    mockCheckPermission.mockResolvedValue({ allowed: false })
    const fd = cf({ providerPackageIds: ['pp-1'], providerIds: ['p-1'], priorities: ['1'] })
    // redirect throws; assert no local create occurred.
    await expect(createCustomPackage(fd)).rejects.toThrow('REDIRECT')
    expect(mockPrisma.eSIMPackage.create).not.toHaveBeenCalled()
  })

  it('re-reads selected ProviderPackages server-side (does not trust browser-provided ids)', async () => {
    mockPrisma.providerPackage.findMany.mockImplementation(async ({ where }: any) => {
      // Only return the backing ids that actually exist; ignore unknown ones.
      const valid = ['pp-1']
      return (where.id.in as string[]).filter(id => valid.includes(id)).map(id => backingRow(id)) as any
    })
    await expect(createCustomPackage(cf({
      providerPackageIds: ['pp-1', 'pp-NONEXISTENT'],
      providerIds: ['p-1', 'p-2'],
      priorities: ['1', '2'],
    }))).rejects.toThrow('REDIRECT:/admin/packages')
    // Only the server-verified backing was bound (priority 1).
    const txFn = mockPrisma.$transaction.mock.calls[0][0] as (tx: any) => Promise<void>
    const txCreate = vi.fn().mockResolvedValue({ id: 'b' })
    await txFn({ eSIMPackage: { create: vi.fn().mockResolvedValue({ id: 'esim-custom-1' }) }, eSIMPackageProviderBinding: { create: txCreate } })
    expect(txCreate).toHaveBeenCalledTimes(1)
    expect(txCreate.mock.calls[0][0].data.providerPackageId).toBe('pp-1')
  })

  it('CPB-UI-6: rejects duplicate priorities', async () => {
    const r = await createCustomPackage(cf({
      providerPackageIds: ['pp-1', 'pp-2'],
      providerIds: ['p-1', 'p-1'],
      priorities: ['1', '1'],
    }))
    expect(r).toEqual({ success: false, error: 'Priorities must be unique' })
    expect(mockPrisma.eSIMPackage.create).not.toHaveBeenCalled()
  })

  it('CPB-UI-7: rejects when priority 1 is missing', async () => {
    const r = await createCustomPackage(cf({
      providerPackageIds: ['pp-1', 'pp-2'],
      providerIds: ['p-1', 'p-1'],
      priorities: ['2', '3'],
    }))
    expect(r).toEqual({ success: false, error: 'Priority 1 (primary provider) is required' })
    expect(mockPrisma.eSIMPackage.create).not.toHaveBeenCalled()
  })

  it('CPB-UI-5: rejects duplicate ProviderPackage', async () => {
    const r = await createCustomPackage(cf({
      providerPackageIds: ['pp-1', 'pp-1'],
      providerIds: ['p-1', 'p-1'],
      priorities: ['1', '2'],
    }))
    expect(r).toEqual({ success: false, error: 'The same ProviderPackage cannot be selected twice' })
    expect(mockPrisma.eSIMPackage.create).not.toHaveBeenCalled()
  })

  it('CPB-UI-20: unauthorized admin cannot create custom package', async () => {
    mockCheckPermission.mockResolvedValue({ allowed: false })
    const fd = cf({ providerPackageIds: ['pp-1'], providerIds: ['p-1'], priorities: ['1'] })
    await expect(createCustomPackage(fd)).rejects.toThrow('REDIRECT')
    expect(mockPrisma.eSIMPackage.create).not.toHaveBeenCalled()
    expect(mockPrisma.providerPackage.findMany).not.toHaveBeenCalled()
  })

  it('CPB-UI-13: partial binding failure rolls back the entire creation (atomic transaction)', async () => {
    mockPrisma.providerPackage.findMany.mockResolvedValue([backingRow('pp-1'), backingRow('pp-2')] as any)
    // Simulate a binding failure: the binding create throws inside the transaction
    // (e.g. DB unique constraint on the 2nd binding). The canonical service catches
    // it and returns a clean failure (no half-created package, no redirect).
    mockPrisma.$transaction.mockImplementationOnce(async (fn: any) => {
      await fn({
        eSIMPackage: { create: vi.fn().mockResolvedValue({ id: 'esim-custom-1' }) },
        eSIMPackageProviderBinding: {
          create: vi.fn()
            .mockResolvedValueOnce({ id: 'b1' }) // 1st binding ok
            .mockRejectedValueOnce(new Error('UNIQUE constraint failed')), // 2nd binding fails
        },
      })
      throw new Error('Transaction aborted (binding failed)')
    })

    const r = await createCustomPackage(cf({
      providerPackageIds: ['pp-1', 'pp-2'],
      providerIds: ['p-1', 'p-2'],
      priorities: ['1', '2'],
    }))
    expect(r.success).toBe(false)

    // The transaction did not commit: no audit "CUSTOM_PACKAGE_CREATED" recorded
    // for a completed creation, and the action never reached the success redirect.
    const createdAudits = mockPrisma.auditLog.create.mock.calls.filter(c => c[0]?.data?.action === 'CUSTOM_PACKAGE_CREATED')
    expect(createdAudits).toHaveLength(0)
  })

  it('CPB-UI-12: compatible multi-provider package is created atomically with bindings in one transaction', async () => {
    mockPrisma.providerPackage.findMany.mockResolvedValue([backingRow('pp-1'), backingRow('pp-2')] as any)
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn({
      eSIMPackage: { create: mockPrisma.eSIMPackage.create },
      eSIMPackageProviderBinding: { create: vi.fn().mockResolvedValue({ id: 'b' }) },
    }))

    await expect(createCustomPackage(cf({
      providerPackageIds: ['pp-1', 'pp-2'],
      providerIds: ['p-1', 'p-2'],
      priorities: ['1', '2'],
    }))).rejects.toThrow('REDIRECT:/admin/packages')

    // Package + bindings created in ONE $transaction (atomic).
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(mockPrisma.eSIMPackage.create).toHaveBeenCalledTimes(1)
    // providerRawData records allowFailover + backing count.
    const createData = mockPrisma.eSIMPackage.create.mock.calls[0][0].data
    expect(createData.providerPackageId).toBeNull()
    expect(createData.providerRawData.customPackage.backingCount).toBe(2)
  })
})
