import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetServerSession } = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
}))

const { mockSyncProviderPackageToPublishedProducts, mockRevalidateCatalogRoutes, mockRecordCatalogPriceSyncAudit } = vi.hoisted(() => ({
  mockSyncProviderPackageToPublishedProducts: vi.fn(),
  mockRevalidateCatalogRoutes: vi.fn(),
  mockRecordCatalogPriceSyncAudit: vi.fn(),
}))

const { mockPublishProviderPackageToRetailCatalog } = vi.hoisted(() => ({
  mockPublishProviderPackageToRetailCatalog: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: vi.fn(),
    providerPackage: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
  },
}))

vi.mock('@/lib/auth/config', () => ({ authOptions: {} }))

vi.mock('next-auth', () => ({
  getServerSession: mockGetServerSession,
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/services/catalog-price-sync', () => ({
  syncProviderPackageToPublishedProducts: mockSyncProviderPackageToPublishedProducts,
  revalidateCatalogRoutes: mockRevalidateCatalogRoutes,
  recordCatalogPriceSyncAudit: mockRecordCatalogPriceSyncAudit,
}))

vi.mock('@/lib/services/catalog/publish-to-retail', () => ({
  publishProviderPackageToRetailCatalog: mockPublishProviderPackageToRetailCatalog,
}))

import { updateSinglePackage } from './package-edit'

const mockSession = { user: { id: 'user-1', role: 'INTERNAL_ADMIN' } }

const mockPackage = {
  id: 'pp-1',
  name: 'Test Package',
  dataGB: 7,
  validityDays: 30,
  costPrice: { toString: () => '5.00' },
  currency: 'USD',
  sellingPrice: { toString: () => '15.00' },
  sellingCurrency: 'USD',
  markupPercent: { toString: () => '20' },
  providerPlanId: 'plan-1',
  providerId: 'prov-1',
  publishStatus: 'PUBLISHED',
  configurationStatus: 'CONFIGURED',
  lastConfiguredAt: new Date(),
}

describe('updateSinglePackage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetServerSession.mockResolvedValue(mockSession)
    mockSyncProviderPackageToPublishedProducts.mockResolvedValue(undefined)
    mockRevalidateCatalogRoutes.mockResolvedValue(undefined)
    mockRecordCatalogPriceSyncAudit.mockResolvedValue(undefined)
  })

  it('returns unauthorized for non-INTERNAL_ADMIN role', async () => {
    mockGetServerSession.mockResolvedValueOnce({ user: { id: 'user-1', role: 'USER' } })

    const result = await updateSinglePackage('pp-1', { sellingPrice: 19.99 })
    expect(result).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('returns unauthorized for no session', async () => {
    mockGetServerSession.mockResolvedValueOnce(null)

    const result = await updateSinglePackage('pp-1', { sellingPrice: 19.99 })
    expect(result).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('updates ProviderPackage and syncs Product Catalog on markup change', async () => {
    const { prisma } = await import('@/lib/prisma') as any

    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(mockPackage),
          update: vi.fn().mockResolvedValue({ ...mockPackage, markupPercent: { toString: () => '30' }, sellingPrice: { toString: () => '19.99' } }),
        },
      }
      return cb(tx)
    })

    const result = await updateSinglePackage('pp-1', { markupPercent: 30 })

    expect(result).toEqual({ success: true })
    expect(mockSyncProviderPackageToPublishedProducts).toHaveBeenCalled()
  })

  it('updates ProviderPackage and syncs Product Catalog on selling price change', async () => {
    const { prisma } = await import('@/lib/prisma') as any

    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(mockPackage),
          update: vi.fn().mockResolvedValue({ ...mockPackage, sellingPrice: { toString: () => '19.99' } }),
        },
      }
      return cb(tx)
    })

    const result = await updateSinglePackage('pp-1', { sellingPrice: 19.99 })

    expect(result).toEqual({ success: true })
    expect(mockSyncProviderPackageToPublishedProducts).toHaveBeenCalled()
  })

  it('calls recordCatalogPriceSyncAudit and revalidation after successful commit', async () => {
    const { prisma } = await import('@/lib/prisma') as any

    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(mockPackage),
          update: vi.fn().mockResolvedValue({ ...mockPackage, sellingPrice: { toString: () => '19.99' } }),
        },
      }
      return cb(tx)
    })

    await updateSinglePackage('pp-1', { sellingPrice: 19.99 })

    expect(mockRecordCatalogPriceSyncAudit).toHaveBeenCalled()
    expect(mockRevalidateCatalogRoutes).toHaveBeenCalled()
  })

  it('does not call audit or revalidation on transaction failure', async () => {
    const { prisma } = await import('@/lib/prisma') as any

    prisma.$transaction.mockRejectedValue(new Error('DB error'))

    const result = await updateSinglePackage('pp-1', { sellingPrice: 19.99 })

    expect(result).toEqual({ success: false, error: 'DB error' })
    expect(mockRecordCatalogPriceSyncAudit).not.toHaveBeenCalled()
    expect(mockRevalidateCatalogRoutes).not.toHaveBeenCalled()
  })

  it('does not call audit or revalidation when sync fails inside transaction', async () => {
    const { prisma } = await import('@/lib/prisma') as any

    mockSyncProviderPackageToPublishedProducts.mockRejectedValue(new Error('Sync error'))

    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(mockPackage),
          update: vi.fn().mockResolvedValue({ ...mockPackage }),
        },
      }
      try {
        await cb(tx)
      } catch {
        // transaction rolls back internally
      }
    })

    await updateSinglePackage('pp-1', { sellingPrice: 19.99 })

    expect(mockRecordCatalogPriceSyncAudit).not.toHaveBeenCalled()
    expect(mockRevalidateCatalogRoutes).not.toHaveBeenCalled()
  })

  it('returns error when package not found', async () => {
    const { prisma } = await import('@/lib/prisma') as any

    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(null),
          update: vi.fn(),
        },
      }
      return cb(tx)
    })

    const result = await updateSinglePackage('nonexistent', { sellingPrice: 19.99 })
    expect(result).toEqual({ success: false, error: 'Package not found' })
  })

  it('returns error when no fields to update', async () => {
    const { prisma } = await import('@/lib/prisma') as any

    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(mockPackage),
          update: vi.fn(),
        },
      }
      return cb(tx)
    })

    const result = await updateSinglePackage('pp-1', {})
    expect(result).toEqual({ success: false, error: 'No fields to update' })
  })

  it('returns structured success on completion', async () => {
    const { prisma } = await import('@/lib/prisma') as any

    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(mockPackage),
          update: vi.fn().mockResolvedValue({ ...mockPackage, sellingPrice: { toString: () => '19.99' } }),
        },
      }
      return cb(tx)
    })

    const result = await updateSinglePackage('pp-1', { sellingPrice: 19.99 })
    expect(result).toEqual({ success: true })
  })

  it('recalculates selling price from cost + markup when only markup is edited (bug: cost+markup with NULL selling)', async () => {
    const { prisma } = await import('@/lib/prisma') as any
    // Before: cost 5, markup 20, selling NULL (the reported inconsistent state).
    const beforeState = { ...mockPackage, publishStatus: 'DRAFT', costPrice: { toString: () => '5.00' }, sellingPrice: null, markupPercent: { toString: () => '20' } }
    let updateData: any = null
    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(beforeState),
          update: vi.fn().mockImplementation(async (arg: any) => { updateData = arg.data; return { ...beforeState, ...arg.data } }),
        },
      }
      return cb(tx)
    })

    const result = await updateSinglePackage('pp-1', { markupPercent: 30 })
    expect(result.success).toBe(true)
    // 5 * (1 + 30/100) = 6.50 — selling is never left null when determinable.
    expect(updateData.sellingPrice).toBe(6.5)
    expect(updateData.markupPercent).toBe(30)
  })

  it('recalculates markup from cost + selling when only selling is edited', async () => {
    const { prisma } = await import('@/lib/prisma') as any
    const beforeState = { ...mockPackage, publishStatus: 'DRAFT', costPrice: { toString: () => '7.00' }, sellingPrice: null, markupPercent: null }
    let updateData: any = null
    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(beforeState),
          update: vi.fn().mockImplementation(async (arg: any) => { updateData = arg.data; return { ...beforeState, ...arg.data } }),
        },
      }
      return cb(tx)
    })

    const result = await updateSinglePackage('pp-1', { sellingPrice: 8 })
    expect(result.success).toBe(true)
    expect(updateData.markupPercent).toBe(14.29) // ((8-7)/7)*100 → 14.29
    expect(updateData.sellingPrice).toBe(8)
  })

  it('recalculates the dependent value on a cost edit (markup-known branch)', async () => {
    const { prisma } = await import('@/lib/prisma') as any
    const beforeState = { ...mockPackage, publishStatus: 'DRAFT', costPrice: { toString: () => '7.00' }, sellingPrice: null, markupPercent: { toString: () => '9.89' } }
    let updateData: any = null
    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(beforeState),
          update: vi.fn().mockImplementation(async (arg: any) => { updateData = arg.data; return { ...beforeState, ...arg.data } }),
        },
      }
      return cb(tx)
    })

    const result = await updateSinglePackage('pp-1', { costPrice: 7 })
    expect(result.success).toBe(true)
    expect(updateData.sellingPrice).toBe(7.69) // 7 * 1.0989 = 7.6923 → 7.69
  })

  it('CONFIGURED cannot retain a deterministically missing selling price', async () => {
    const { prisma } = await import('@/lib/prisma') as any
    const beforeState = { ...mockPackage, publishStatus: 'DRAFT', costPrice: { toString: () => '7.00' }, sellingPrice: null, markupPercent: null }
    let updateData: any = null
    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(beforeState),
          update: vi.fn().mockImplementation(async (arg: any) => { updateData = arg.data; return { ...beforeState, ...arg.data } }),
        },
      }
      return cb(tx)
    })

    // Setting CONFIGURED with cost+markup (and NO selling) must compute selling.
    const result = await updateSinglePackage('pp-1', { configurationStatus: 'CONFIGURED', costPrice: 7, markupPercent: 9.89 })
    expect(result.success).toBe(true)
    expect(updateData.configurationStatus).toBe('CONFIGURED')
    expect(updateData.sellingPrice).toBe(7.69) // 7 * 1.0989 → 7.69 — never left null
    expect(updateData.markupPercent).toBe(9.89)
  })
})

describe('updateSinglePackage — explicit PUBLISHED intent (canonical publish contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetServerSession.mockResolvedValue(mockSession)
    mockSyncProviderPackageToPublishedProducts.mockResolvedValue(undefined)
    mockRevalidateCatalogRoutes.mockResolvedValue(undefined)
    mockRecordCatalogPriceSyncAudit.mockResolvedValue(undefined)
  })

  async function setupEditTx(before: any): Promise<{ txUpdate: any }> {
    const state: { txUpdate: any } = { txUpdate: null }
    const { prisma } = await import('@/lib/prisma') as any
    // Outer read for the eligibility gate + inner transaction read for pricing.
    prisma.providerPackage.findUnique.mockResolvedValue(before)
    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(before),
          update: vi.fn().mockImplementation(async (arg: any) => { state.txUpdate = arg.data; return { ...before, ...arg.data } }),
        },
      }
      return cb(tx)
    })
    return state
  }

  it('persists edits THEN routes through canonical publication (not a drop)', async () => {
    const before = { ...mockPackage, publishStatus: 'DRAFT', costPrice: { toString: () => '7.00' }, sellingPrice: null, markupPercent: null }
    const state = await setupEditTx(before)
    mockPublishProviderPackageToRetailCatalog.mockResolvedValue({ success: true, providerPackageId: 'pp-1', created: true, updated: false, publishStatusSet: true, ready: true, readinessReasons: [] })

    const result = await updateSinglePackage('pp-1', { configurationStatus: 'CONFIGURED', costPrice: 7, markupPercent: 9.89, sellingPrice: 7.69, publishStatus: 'PUBLISHED' })

    expect(result.success).toBe(true)
    // Edits persisted BEFORE the publish call.
    expect(state.txUpdate).not.toBeNull()
    expect(state.txUpdate.configurationStatus).toBe('CONFIGURED')
    expect(state.txUpdate.sellingPrice).toBe(7.69)
    // No direct publishStatus=PUBLISHED write — the canonical gate owns it.
    expect(state.txUpdate.publishStatus).toBeUndefined()
    // Canonical publication invoked.
    expect(mockPublishProviderPackageToRetailCatalog).toHaveBeenCalledWith('pp-1', expect.objectContaining({ reason: 'MANUAL_EDIT' }))
  })

  it('PUBLISHED intent blocked by readiness → NOT PUBLISHED + exact reasons returned', async () => {
    // Cost must be non-zero so the pricing resolver stays valid; readiness is
    // whatever the canonical gate reports.
    const before = { ...mockPackage, publishStatus: 'DRAFT', costPrice: { toString: () => '7.00' }, sellingPrice: null, markupPercent: null }
    await setupEditTx(before)
    mockPublishProviderPackageToRetailCatalog.mockResolvedValue({
      success: false, providerPackageId: 'pp-1', created: false, updated: false, publishStatusSet: false, ready: false,
      readinessReasons: ['Cost status is MISSING', 'Pricing status is COST_UNAVAILABLE', 'No active price snapshot'],
      failedStage: 'FINALIZATION_FAILED', error: 'Finalization failed',
    })

    const result = await updateSinglePackage('pp-1', { configurationStatus: 'CONFIGURED', sellingPrice: 5, publishStatus: 'PUBLISHED' })
    expect(result.success).toBe(false)
    expect(result.readinessReasons).toEqual(['Cost status is MISSING', 'Pricing status is COST_UNAVAILABLE', 'No active price snapshot'])
  })

  it('DRAFT edit does not publish', async () => {
    const before = { ...mockPackage, publishStatus: 'DRAFT', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '7.69' }, markupPercent: null }
    await setupEditTx(before)
    const result = await updateSinglePackage('pp-1', { publishStatus: 'DRAFT', configurationStatus: 'CONFIGURED', sellingPrice: 7.69 })
    expect(result.success).toBe(true)
    expect(mockPublishProviderPackageToRetailCatalog).not.toHaveBeenCalled()
  })

  it('READY edit does not publish unless explicitly PUBLISHED', async () => {
    const before = { ...mockPackage, publishStatus: 'DRAFT', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '7.69' }, markupPercent: null }
    const state = await setupEditTx(before)
    const result = await updateSinglePackage('pp-1', { publishStatus: 'READY', configurationStatus: 'CONFIGURED', sellingPrice: 7.69 })
    expect(result.success).toBe(true)
    expect(mockPublishProviderPackageToRetailCatalog).not.toHaveBeenCalled()
    expect(state.txUpdate.publishStatus).toBe('READY')
  })

  it('repeated PUBLISHED save is idempotent (retail handled by canonical service, no duplicate logic here)', async () => {
    const before = { ...mockPackage, publishStatus: 'PUBLISHED', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '7.69' }, markupPercent: null }
    await setupEditTx(before)
    mockPublishProviderPackageToRetailCatalog.mockResolvedValue({ success: true, providerPackageId: 'pp-1', created: false, updated: true, publishStatusSet: true, ready: true, readinessReasons: [] })
    const r1 = await updateSinglePackage('pp-1', { sellingPrice: 7.69, publishStatus: 'PUBLISHED' })
    const r2 = await updateSinglePackage('pp-1', { sellingPrice: 7.69, publishStatus: 'PUBLISHED' })
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
    // Each PUBLISHED intent invokes the canonical gate exactly once.
    expect(mockPublishProviderPackageToRetailCatalog).toHaveBeenCalledTimes(2)
  })

  it('CONFIGURED + PUBLISHED intent → publication attempted', async () => {
    const before = { ...mockPackage, publishStatus: 'DRAFT', configurationStatus: 'CONFIGURED', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '7.69' }, markupPercent: null }
    await setupEditTx(before)
    mockPublishProviderPackageToRetailCatalog.mockResolvedValue({ success: true, providerPackageId: 'pp-1', created: true, updated: false, publishStatusSet: true, ready: true, readinessReasons: [] })
    const result = await updateSinglePackage('pp-1', { sellingPrice: 7.69, publishStatus: 'PUBLISHED' })
    expect(result.success).toBe(true)
    expect(mockPublishProviderPackageToRetailCatalog).toHaveBeenCalledTimes(1)
  })

  it('AUTO_CONFIGURED + PUBLISHED intent → publication attempted', async () => {
    const before = { ...mockPackage, publishStatus: 'DRAFT', configurationStatus: 'AUTO_CONFIGURED', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '7.69' }, markupPercent: null }
    await setupEditTx(before)
    mockPublishProviderPackageToRetailCatalog.mockResolvedValue({ success: true, providerPackageId: 'pp-1', created: true, updated: false, publishStatusSet: true, ready: true, readinessReasons: [] })
    const result = await updateSinglePackage('pp-1', { sellingPrice: 7.69, publishStatus: 'PUBLISHED' })
    expect(result.success).toBe(true)
    expect(mockPublishProviderPackageToRetailCatalog).toHaveBeenCalledTimes(1)
  })

  it('READY + PUBLISHED intent → publication attempted', async () => {
    const before = { ...mockPackage, publishStatus: 'READY', configurationStatus: 'CONFIGURED', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '7.69' }, markupPercent: null }
    await setupEditTx(before)
    mockPublishProviderPackageToRetailCatalog.mockResolvedValue({ success: true, providerPackageId: 'pp-1', created: false, updated: true, publishStatusSet: true, ready: true, readinessReasons: [] })
    const result = await updateSinglePackage('pp-1', { sellingPrice: 7.69, publishStatus: 'PUBLISHED' })
    expect(result.success).toBe(true)
    expect(mockPublishProviderPackageToRetailCatalog).toHaveBeenCalledTimes(1)
  })

  it('UNCONFIGURED + PUBLISHED intent → blocked, canonical publish service NOT called', async () => {
    const before = { ...mockPackage, publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '7.69' }, markupPercent: null }
    await setupEditTx(before)
    const result = await updateSinglePackage('pp-1', { sellingPrice: 7.69, publishStatus: 'PUBLISHED' })
    expect(result.success).toBe(false)
    expect(result.eligibilityReasons).toBeDefined()
    expect(result.eligibilityReasons).toContain('configurationStatus is UNCONFIGURED (never eligible to publish)')
    expect(mockPublishProviderPackageToRetailCatalog).not.toHaveBeenCalled()
  })

  it('DRAFT + UNCONFIGURED + PUBLISHED intent → blocked', async () => {
    const before = { ...mockPackage, publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '7.69' }, markupPercent: null }
    await setupEditTx(before)
    const result = await updateSinglePackage('pp-1', { sellingPrice: 7.69, publishStatus: 'PUBLISHED' })
    expect(result.success).toBe(false)
    expect(result.eligibilityReasons).toBeDefined()
    expect(mockPublishProviderPackageToRetailCatalog).not.toHaveBeenCalled()
  })

  it('DRAFT + CONFIGURED + PUBLISHED intent → allowed to attempt publish', async () => {
    const before = { ...mockPackage, publishStatus: 'DRAFT', configurationStatus: 'CONFIGURED', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '7.69' }, markupPercent: null }
    await setupEditTx(before)
    mockPublishProviderPackageToRetailCatalog.mockResolvedValue({ success: true, providerPackageId: 'pp-1', created: true, updated: false, publishStatusSet: true, ready: true, readinessReasons: [] })
    const result = await updateSinglePackage('pp-1', { sellingPrice: 7.69, publishStatus: 'PUBLISHED' })
    expect(result.success).toBe(true)
    expect(mockPublishProviderPackageToRetailCatalog).toHaveBeenCalledTimes(1)
  })

  it('HIDDEN + PUBLISHED intent → blocked (restore/unarchive first)', async () => {
    const before = { ...mockPackage, publishStatus: 'HIDDEN', configurationStatus: 'CONFIGURED', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '7.69' }, markupPercent: null }
    await setupEditTx(before)
    const result = await updateSinglePackage('pp-1', { sellingPrice: 7.69, publishStatus: 'PUBLISHED' })
    expect(result.success).toBe(false)
    expect(result.eligibilityReasons).toContain('publishStatus is HIDDEN (restore/unarchive before publishing)')
    expect(mockPublishProviderPackageToRetailCatalog).not.toHaveBeenCalled()
  })

  it('ARCHIVED + PUBLISHED intent → blocked (restore/unarchive first)', async () => {
    const before = { ...mockPackage, publishStatus: 'ARCHIVED', configurationStatus: 'CONFIGURED', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '7.69' }, markupPercent: null }
    await setupEditTx(before)
    const result = await updateSinglePackage('pp-1', { sellingPrice: 7.69, publishStatus: 'PUBLISHED' })
    expect(result.success).toBe(false)
    expect(result.eligibilityReasons).toContain('publishStatus is ARCHIVED (restore/unarchive before publishing)')
    expect(mockPublishProviderPackageToRetailCatalog).not.toHaveBeenCalled()
  })

  it('eligible (CONFIGURED) but readiness fails → NOT published + exact readiness blockers returned', async () => {
    const before = { ...mockPackage, publishStatus: 'DRAFT', configurationStatus: 'CONFIGURED', costPrice: { toString: () => '7.00' }, sellingPrice: null, markupPercent: null }
    await setupEditTx(before)
    mockPublishProviderPackageToRetailCatalog.mockResolvedValue({
      success: false, providerPackageId: 'pp-1', created: false, updated: false, publishStatusSet: false, ready: false,
      readinessReasons: ['Cost status is MISSING', 'No active price snapshot'], failedStage: 'RETAIL_READINESS_FAILED', error: 'Cost status is MISSING',
    })
    const result = await updateSinglePackage('pp-1', { configurationStatus: 'CONFIGURED', sellingPrice: 7.69, publishStatus: 'PUBLISHED' })
    expect(result.success).toBe(false)
    expect(result.readinessReasons).toEqual(['Cost status is MISSING', 'No active price snapshot'])
    // Never persisted as PUBLISHED, never written to retail.
    expect(mockPublishProviderPackageToRetailCatalog.mock.calls[0][1].reason).toBe('MANUAL_EDIT')
  })

  it('provider-neutral eligibility: CHOICE and AIRHUB behave identically', async () => {
    const before = { ...mockPackage, publishStatus: 'DRAFT', configurationStatus: 'CONFIGURED', providerId: 'prov-choice', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '7.69' }, markupPercent: null }
    await setupEditTx(before)
    mockPublishProviderPackageToRetailCatalog.mockResolvedValue({ success: true, providerPackageId: 'pp-1', created: true, updated: false, publishStatusSet: true, ready: true, readinessReasons: [] })
    const r1 = await updateSinglePackage('pp-1', { sellingPrice: 7.69, publishStatus: 'PUBLISHED' })
    expect(r1.success).toBe(true)

    const before2 = { ...mockPackage, publishStatus: 'DRAFT', configurationStatus: 'CONFIGURED', providerId: 'prov-airhub', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '7.69' }, markupPercent: null }
    await setupEditTx(before2)
    const r2 = await updateSinglePackage('pp-1', { sellingPrice: 7.69, publishStatus: 'PUBLISHED' })
    expect(r2.success).toBe(true)
    expect(mockPublishProviderPackageToRetailCatalog).toHaveBeenCalledTimes(2)
  })

  it('existing PUBLISHED package price edit behavior is unaffected (no re-persist of status)', async () => {
    const before = { ...mockPackage, publishStatus: 'PUBLISHED', configurationStatus: 'CONFIGURED', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '7.69' }, markupPercent: null }
    const state = await setupEditTx(before)
    mockPublishProviderPackageToRetailCatalog.mockResolvedValue({ success: true, providerPackageId: 'pp-1', created: false, updated: true, publishStatusSet: true, ready: true, readinessReasons: [] })
    const result = await updateSinglePackage('pp-1', { sellingPrice: 7.69, publishStatus: 'PUBLISHED' })
    expect(result.success).toBe(true)
    expect(mockPublishProviderPackageToRetailCatalog).toHaveBeenCalledTimes(1)
    expect(state.txUpdate.publishStatus).toBeUndefined()
    expect(state.txUpdate.sellingPrice).toBe(7.69)
  })
})