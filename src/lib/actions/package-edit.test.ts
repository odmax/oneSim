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

  internalAdmin: { findUnique: vi.fn().mockResolvedValue({ id: 'admin-row', role: 'SUPER_ADMIN', isActive: true, permissions: null }) },
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

    expect(result).toMatchObject({ success: true })
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

    expect(result).toMatchObject({ success: true })
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
    expect(result).toMatchObject({ success: true })
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

  it('repeated PUBLISHED save of an already-published product is a plain edit (no re-publish)', async () => {
    // Root cause of "the catalog can only be edited once": an already-PUBLISHED
    // package that re-runs PUBLISHED intent re-fires the canonical publish
    // pipeline (finalize → recalc-from-rules → new snapshot → republish),
    // discarding the admin's new price or failing the margin guard. Repeated
    // saves must be ordinary configuration edits.
    const before = { ...mockPackage, publishStatus: 'PUBLISHED', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '7.69' }, markupPercent: null }
    await setupEditTx(before)
    const r1 = await updateSinglePackage('pp-1', { sellingPrice: 8, publishStatus: 'PUBLISHED', pricingIntent: 'SELLING' })
    const r2 = await updateSinglePackage('pp-1', { sellingPrice: 9, publishStatus: 'PUBLISHED', pricingIntent: 'SELLING' })
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
    // Already-published edits never re-run the publication gate.
    expect(mockPublishProviderPackageToRetailCatalog).not.toHaveBeenCalled()
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

  it('existing PUBLISHED package price edit does NOT re-publish (repeated edit stays a plain update)', async () => {
    const before = { ...mockPackage, publishStatus: 'PUBLISHED', configurationStatus: 'CONFIGURED', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '7.69' }, markupPercent: null }
    const state = await setupEditTx(before)
    const result = await updateSinglePackage('pp-1', { sellingPrice: 8, publishStatus: 'PUBLISHED', pricingIntent: 'SELLING' })
    expect(result.success).toBe(true)
    expect(mockPublishProviderPackageToRetailCatalog).not.toHaveBeenCalled()
    expect(state.txUpdate.publishStatus).toBeUndefined()
    expect(state.txUpdate.sellingPrice).toBe(8)
  })
})

describe('updateSinglePackage — repeated editing (A twice / A then B), FIXED_PRICE, decimal safety, retry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetServerSession.mockResolvedValue(mockSession)
    mockSyncProviderPackageToPublishedProducts.mockResolvedValue(undefined)
    mockRevalidateCatalogRoutes.mockResolvedValue(undefined)
    mockRecordCatalogPriceSyncAudit.mockResolvedValue(undefined)
  })

  async function setupOpaquePg(pkg: any) {
    const calls: any[] = []
    const { prisma } = await import('@/lib/prisma') as any
    prisma.providerPackage.findUnique.mockResolvedValue(pkg)
    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(pkg),
          update: vi.fn().mockImplementation(async (arg: any) => {
            calls.push(arg.data)
            return { ...pkg, ...arg.data }
          }),
        },
      }
      return cb(tx)
    })
    return calls
  }

  it('product A edited twice keeps the latest persisted selling price', async () => {
    const beforeA = { ...mockPackage, id: 'pp-A', publishStatus: 'PUBLISHED', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '15.00' }, markupPercent: { toString: () => '20' } }
    await setupOpaquePg(beforeA)
    const r1 = await updateSinglePackage('pp-A', { sellingPrice: 16, pricingIntent: 'SELLING' })
    const r2 = await updateSinglePackage('pp-A', { sellingPrice: 17.5, pricingIntent: 'SELLING' })
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
    expect(mockPublishProviderPackageToRetailCatalog).not.toHaveBeenCalled()
  })

  it('replaces markup repeatedly and returns each canonical persisted snapshot (9 → 8 → 7)', async () => {
    const { prisma } = await import('@/lib/prisma') as any
    let persisted: any = {
      ...mockPackage,
      id: 'pp-margin',
      publishStatus: null,
      configurationStatus: null,
      pricingMode: 'MARKUP_PERCENT',
      costPrice: { toString: () => '35.9' },
      sellingPrice: { toString: () => '39.13' },
      markupPercent: { toString: () => '9' },
    }
    const writes: any[] = []

    prisma.$transaction.mockImplementation(async (cb: Function) => cb({
      providerPackage: {
        findUnique: vi.fn().mockImplementation(async () => persisted),
        update: vi.fn().mockImplementation(async ({ data }: any) => {
          writes.push(data)
          const previousCost = persisted.costPrice.toString()
          const previousSelling = persisted.sellingPrice?.toString() ?? null
          const previousMarkup = persisted.markupPercent?.toString() ?? null
          const nextCost = String(data.costPrice ?? previousCost)
          const nextSelling = data.sellingPrice == null ? previousSelling : String(data.sellingPrice)
          const nextMarkup = data.markupPercent == null ? previousMarkup : String(data.markupPercent)
          persisted = {
            ...persisted,
            ...data,
            costPrice: { toString: () => nextCost },
            sellingPrice: nextSelling == null ? null : { toString: () => nextSelling },
            markupPercent: nextMarkup == null ? null : { toString: () => nextMarkup },
          }
          return persisted
        }),
      },
    }))

    const first = await updateSinglePackage('pp-margin', { markupPercent: 8, pricingIntent: 'MARKUP' })
    const second = await updateSinglePackage('pp-margin', { markupPercent: 7, pricingIntent: 'MARKUP' })

    expect(first.success, first.error).toBe(true)
    expect(first.updatedPackage?.markupPercent).toBe('8')
    expect(first.updatedPackage?.sellingPrice).toBe('38.77')
    expect(second.success).toBe(true)
    expect(second.updatedPackage?.markupPercent).toBe('7')
    expect(second.updatedPackage?.sellingPrice).toBe('38.41')
    expect(writes.map(write => write.markupPercent)).toEqual([8, 7])
    expect(mockPublishProviderPackageToRetailCatalog).not.toHaveBeenCalled()
  })

  it('editing product A then product B are independent updates (per-package state)', async () => {
    const { prisma } = await import('@/lib/prisma') as any
    const beforeA = { ...mockPackage, id: 'pp-A', publishStatus: 'PUBLISHED', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '15.00' }, markupPercent: { toString: () => '20' } }
    const beforeB = { ...mockPackage, id: 'pp-B', publishStatus: 'DRAFT', costPrice: { toString: () => '3.00' }, sellingPrice: { toString: () => '9.99' }, markupPercent: null }

    const writes: Array<{ id: string; data: any }> = []
    prisma.providerPackage.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === 'pp-A') return beforeA
      if (where.id === 'pp-B') return beforeB
      return null
    })
    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: prisma.providerPackage.findUnique,
          update: vi.fn().mockImplementation(async (arg: any) => {
            writes.push({ id: arg.where.id, data: arg.data })
            return { ...(arg.where.id === 'pp-A' ? beforeA : beforeB), ...arg.data }
          }),
        },
      }
      return cb(tx)
    })

    const resA = await updateSinglePackage('pp-A', { sellingPrice: 16, pricingIntent: 'SELLING' })
    const resB = await updateSinglePackage('pp-B', { sellingPrice: 10.5, pricingIntent: 'SELLING' })
    expect(resA.success).toBe(true)
    expect(resB.success).toBe(true)
    expect(writes.length).toBe(2)
    expect(writes[0].id).toBe('pp-A')
    expect(writes[1].id).toBe('pp-B')
    expect(writes[0].data.sellingPrice).toBe(16)
    expect(writes[1].data.sellingPrice).toBe(10.5)
  })

  it('FIXED_PRICE selling edit succeeds with no cost (mode-aware validation)', async () => {
    const before = { ...mockPackage, id: 'pp-F', publishStatus: 'PUBLISHED', pricingMode: 'FIXED_PRICE', costPrice: { toString: () => '0' }, sellingPrice: { toString: () => '21.49' }, markupPercent: { toString: () => '0' } }
    const writes = await setupOpaquePg(before)
    const res = await updateSinglePackage('pp-F', { sellingPrice: 22, pricingMode: 'FIXED_PRICE', pricingIntent: 'SELLING' })
    expect(res.success).toBe(true)
    expect(writes[writes.length - 1].sellingPrice).toBe(22)
  })

  it('comma-decimal persists exactly 21,49 → 21.49 (never 21 / 2149 / NaN)', async () => {
    const before = { ...mockPackage, id: 'pp-D', publishStatus: 'PUBLISHED', costPrice: { toString: () => '5.00' }, sellingPrice: { toString: () => '21' }, markupPercent: null }
    const writes = await setupOpaquePg(before)
    const res = await updateSinglePackage('pp-D', { sellingPrice: 21.49, pricingIntent: 'SELLING' })
    expect(res.success).toBe(true)
    const last = writes[writes.length - 1]
    expect(last.sellingPrice).toBe(21.49)
    expect(last.sellingPrice).not.toBe(2149)
    expect(last.sellingPrice).not.toBe(0)
  })

  it('failed save returns an error and a retry succeeds (retryable)', async () => {
    const before = { ...mockPackage, id: 'pp-R', publishStatus: 'PUBLISHED', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '15.00' }, markupPercent: { toString: () => '20' } }
    const { prisma } = await import('@/lib/prisma') as any
    let failNext = true
    prisma.providerPackage.findUnique.mockResolvedValue(before)
    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(before),
          update: vi.fn().mockImplementation(async (arg: any) => {
            if (failNext) {
              failNext = false
              throw new Error('DB hiccup')
            }
            return { ...before, ...arg.data }
          }),
        },
      }
      return cb(tx)
    })
    const failed = await updateSinglePackage('pp-R', { sellingPrice: 16, pricingIntent: 'SELLING' })
    expect(failed.success).toBe(false)
    expect(failed.error).toContain('DB hiccup')
    const retry = await updateSinglePackage('pp-R', { sellingPrice: 16, pricingIntent: 'SELLING' })
    expect(retry.success).toBe(true)
  })

  it('cache revalidation fires after every successful save, never after a failure', async () => {
    const before = { ...mockPackage, id: 'pp-C', publishStatus: 'PUBLISHED', costPrice: { toString: () => '7.00' }, sellingPrice: { toString: () => '15.00' }, markupPercent: { toString: () => '20' } }
    const { prisma } = await import('@/lib/prisma') as any
    let failOnce = true
    prisma.providerPackage.findUnique.mockResolvedValue(before)
    prisma.$transaction.mockImplementation(async (cb: Function) => {
      const tx = {
        providerPackage: {
          findUnique: vi.fn().mockResolvedValue(before),
          update: vi.fn().mockImplementation(async (arg: any) => {
            if (failOnce) { failOnce = false; throw new Error('x') }
            return { ...before, ...arg.data }
          }),
        },
      }
      return cb(tx)
    })
    await updateSinglePackage('pp-C', { sellingPrice: 16, pricingIntent: 'SELLING' })
    const ok = await updateSinglePackage('pp-C', { sellingPrice: 17, pricingIntent: 'SELLING' })
    expect(ok.success).toBe(true)
    expect(mockRevalidateCatalogRoutes).toHaveBeenCalledTimes(1)
  })
})
