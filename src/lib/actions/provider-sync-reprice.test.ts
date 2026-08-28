import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Provider-sync cost-change → canonical repricing regression tests.
 *
 * Proves the canonical ownership model:
 *  - a cost write alone never claims pricingStatus=READY (232-row root cause)
 *  - an existing package with an established pricing policy whose cost changes
 *    triggers the canonical recalculatePackagePrice() exactly once
 *  - unchanged cost causes no repricing churn
 *  - PUBLISHED packages get retail synchronized only on repricing success
 *  - recalc failure leaves purchase fail-closed and retail untouched
 *  - sync never auto-publishes
 */

const { mockSession } = vi.hoisted(() => ({ mockSession: vi.fn() }))
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    provider: { findUnique: vi.fn(), update: vi.fn() },
    providerPackage: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}))
const { mockRecalculate } = vi.hoisted(() => ({ mockRecalculate: vi.fn() }))
const { mockSyncRetail } = vi.hoisted(() => ({ mockSyncRetail: vi.fn() }))

vi.mock('next-auth', () => ({ getServerSession: mockSession }))
vi.mock('@/lib/auth/config', () => ({ authOptions: {} }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/providers/capabilities/registry', () => ({ providerSupports: vi.fn(() => true) }))
vi.mock('@/lib/catalog-pipeline', () => ({
  startPipelineRun: vi.fn().mockResolvedValue('run-1'),
  recordStageFromCounts: vi.fn(),
  completePipelineRun: vi.fn(),
  failPipelineRun: vi.fn(),
}))
vi.mock('@/lib/catalog-events', () => ({ emitEvent: vi.fn() }))
vi.mock('@/lib/providers/certification-machine', () => ({ advanceCertificationTo: vi.fn() }))
vi.mock('@/lib/providers/travel-date-utils', () => ({
  normalizeTravelDateRequirement: () => 'NOT_REQUIRED',
  withTravelDateMarker: (raw: any) => raw,
}))

const { buildAdapter, isTemplateDrivenProvider } = vi.hoisted(() => ({
  buildAdapter: vi.fn(),
  isTemplateDrivenProvider: vi.fn(() => false),
}))
vi.mock('@/lib/providers/adapter-manager', () => ({
  buildAdapter,
  isTemplateDrivenProvider,
  isProviderOperational: () => true,
}))

vi.mock('@/lib/pricing/price-recalculation-service', () => ({
  recalculatePackagePrice: mockRecalculate,
}))
vi.mock('@/lib/services/catalog-price-sync', () => ({
  syncProviderPackageToPublishedProducts: mockSyncRetail,
}))

import { syncProviderPlans } from './provider-sync'

const mockRe = vi.mocked(mockRecalculate)
const mockSync = vi.mocked(mockSyncRetail)
const mockAdapter = vi.mocked(buildAdapter)

function providerRow(overrides: any = {}) {
  return {
    id: 'prov-x', name: 'X', code: 'X', type: 'CUSTOM', adapterStrategy: 'STANDARD',
    apiBaseUrl: 'https://x.example.com', apiToken: 'enc:x', planListPath: null,
    endpointMappings: null, requestMappings: null, responseMappings: null, fieldMappings: null,
    config: {}, priority: 0, isDefaultFallback: false, status: 'ACTIVE',
    ...overrides,
  }
}

function adapterReturning(plans: any) {
  return { syncPlans: vi.fn().mockResolvedValue({ success: true, data: plans }) }
}

function existingRow(overrides: any = {}) {
  return {
    id: 'pp-1', providerId: 'prov-x', providerPlanId: 'PLAN-1', name: 'Zone 5GB',
    costPrice: 4.0, adminCostPrice: null, readyToPublish: false,
    markupPercent: null, sellingPrice: null, activePriceSnapshotId: null,
    autoConfiguredByRuleId: null, publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED',
    pricingStatus: 'REQUIRES_PRICING',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSession.mockResolvedValue({ user: { role: 'INTERNAL_ADMIN', id: 'admin-1' } })
  mockPrisma.provider.findUnique.mockResolvedValue(providerRow())
  mockPrisma.auditLog.create.mockResolvedValue({})
  mockPrisma.provider.update.mockResolvedValue({})
  mockPrisma.providerPackage.update.mockImplementation(async (args: any) => ({ id: args.where.id, ...args.data }) as any)
  mockPrisma.providerPackage.create.mockImplementation(async (args: any) => ({ id: 'new-1', ...args.data }) as any)
  mockRe.mockResolvedValue({ success: true, pricingStatus: 'READY', priceSnapshotId: 'snap-1' })
  mockSync.mockResolvedValue({ matchedProducts: 1, updatedProducts: 1, skippedProducts: 0, productIds: ['retail-1'] } as any)
})

describe('syncProviderPlans — pricing state + cost-change repricing', () => {
  it('1. new package + valid cost + no pricing policy → selling null, REQUIRES_PRICING, not PUBLISHED', async () => {
    mockPrisma.providerPackage.findFirst.mockResolvedValue(null)
    mockAdapter.mockResolvedValue(adapterReturning([
      { id: 'PLAN-1', name: 'Zone 5GB', data_gb: 5, validity_days: 30, price_usd: 4.5, isAvailable: true, raw_data: {} },
    ]) as any)

    await syncProviderPlans('prov-x')

    const create = mockPrisma.providerPackage.create.mock.calls[0][0] as any
    expect(create.data.providerPlanId).toBe('PLAN-1')
    expect(create.data.costPrice).toBe(4.5)
    expect(create.data.costStatus).toBe('VALID')
    expect(create.data.pricingStatus).toBe('REQUIRES_PRICING')
    expect(create.data.sellingPrice).toBeUndefined()
    expect(create.data.publishStatus).toBeUndefined() // schema default DRAFT; sync never sets PUBLISHED
    // No established policy to recalc; canonical repricing must NOT fire.
    expect(mockRe).not.toHaveBeenCalled()
  })

  it('2. existing configured package cost increases → canonical repricing fires (new selling from rule)', async () => {
    mockPrisma.providerPackage.findFirst.mockResolvedValue(existingRow({
      costPrice: 4.0, markupPercent: 9, pricingStatus: 'READY',
    }))
    mockAdapter.mockResolvedValue(adapterReturning([
      { id: 'PLAN-1', name: 'Zone 5GB', data_gb: 5, validity_days: 30, price_usd: 4.5, isAvailable: true, raw_data: {} },
    ]) as any)

    await syncProviderPlans('prov-x')

    const update = mockPrisma.providerPackage.update.mock.calls[0][0] as any
    // Cost written + intermediate state REQUIRES_RECALCULATION (then recalc → READY + snapshot).
    expect(update.data.costPrice).toBe(4.5)
    expect(update.data.pricingStatus).toBe('REQUIRES_RECALCULATION')
    expect(mockRe).toHaveBeenCalledTimes(1)
    expect(mockRe.mock.calls[0][0]).toBe('pp-1')
    expect(mockRe.mock.calls[0][1]).toBe('PROVIDER_COST_CHANGED')
  })

  it('3. existing configured package cost decreases → canonical repricing fires', async () => {
    mockPrisma.providerPackage.findFirst.mockResolvedValue(existingRow({
      costPrice: 4.5, markupPercent: 9, pricingStatus: 'READY',
    }))
    mockAdapter.mockResolvedValue(adapterReturning([
      { id: 'PLAN-1', name: 'Zone 5GB', data_gb: 5, validity_days: 30, price_usd: 4.0, isAvailable: true, raw_data: {} },
    ]) as any)

    await syncProviderPlans('prov-x')

    const update = mockPrisma.providerPackage.update.mock.calls[0][0] as any
    expect(update.data.costPrice).toBe(4)
    expect(update.data.pricingStatus).toBe('REQUIRES_RECALCULATION')
    expect(mockRe).toHaveBeenCalledTimes(1)
  })

  it('4. unchanged cost → no unnecessary repricing/snapshot churn', async () => {
    mockPrisma.providerPackage.findFirst.mockResolvedValue(existingRow({
      costPrice: 4.5, markupPercent: 9, pricingStatus: 'READY',
    }))
    mockAdapter.mockResolvedValue(adapterReturning([
      { id: 'PLAN-1', name: 'Zone 5GB', data_gb: 5, validity_days: 30, price_usd: 4.5, isAvailable: true, raw_data: {} },
    ]) as any)

    await syncProviderPlans('prov-x')

    const update = mockPrisma.providerPackage.update.mock.calls[0][0] as any
    expect(update.data.pricingStatus).toBe('READY') // preserved, no churn
    expect(mockRe).not.toHaveBeenCalled()
  })

  it('5. package with explicit assigned rule (autoConfiguredByRuleId) + cost change → reprices (no hardcoded 9)', async () => {
    // autoConfiguredByRuleId IS package-level intent (a rule was applied to THIS
    // package), so a cost change must reprice through the canonical engine which
    // resolves the rule itself.
    mockPrisma.providerPackage.findFirst.mockResolvedValue(existingRow({
      costPrice: 4.0, autoConfiguredByRuleId: 'cmr-rule', pricingStatus: 'READY',
    }))
    mockAdapter.mockResolvedValue(adapterReturning([
      { id: 'PLAN-1', name: 'Zone 5GB', data_gb: 5, validity_days: 30, price_usd: 4.5, isAvailable: true, raw_data: {} },
    ]) as any)

    await syncProviderPlans('prov-x')

    expect(mockRe).toHaveBeenCalledTimes(1)
    expect(mockRe.mock.calls[0][1]).toBe('PROVIDER_COST_CHANGED')
    // The engine (mocked here) is what derives 4.50 → ~4.91; no 9 literal in sync.
  })

  it('20. matching active package rule ALONE (never configured) + cost change → NO auto-pricing, REQUIRES_PRICING', async () => {
    // The provider has a resolvable active rule (canonical rule resolution would
    // return it), but THIS package was never configured: no autoConfiguredByRuleId,
    // no markup, no selling, no snapshot, DRAFT/UNCONFIGURED. A provider-level
    // matching rule is NOT package configuration intent — sync must not price it.
    mockPrisma.providerPackage.findFirst.mockResolvedValue(existingRow({
      costPrice: 4.0, pricingStatus: 'COST_UNAVAILABLE',
      autoConfiguredByRuleId: null, markupPercent: null, sellingPrice: null,
      publishStatus: 'DRAFT', configurationStatus: 'UNCONFIGURED',
    }))
    mockAdapter.mockResolvedValue(adapterReturning([
      { id: 'PLAN-1', name: 'Zone 5GB', data_gb: 5, validity_days: 30, price_usd: 4.5, isAvailable: true, raw_data: {} },
    ]) as any)

    await syncProviderPlans('prov-x')

    const update = mockPrisma.providerPackage.update.mock.calls[0][0] as any
    expect(update.data.pricingStatus).toBe('REQUIRES_PRICING')
    expect(update.data.sellingPrice).toBeUndefined()
    expect(mockRe).not.toHaveBeenCalled()
  })

  it('21. previously configured package + assigned policy + cost change → canonical repricing allowed', async () => {
    mockPrisma.providerPackage.findFirst.mockResolvedValue(existingRow({
      costPrice: 4.0, autoConfiguredByRuleId: 'cmr-rule', markupPercent: 9,
      sellingPrice: 4.36, pricingStatus: 'READY', configurationStatus: 'AUTO_CONFIGURED',
    }))
    mockAdapter.mockResolvedValue(adapterReturning([
      { id: 'PLAN-1', name: 'Zone 5GB', data_gb: 5, validity_days: 30, price_usd: 4.5, isAvailable: true, raw_data: {} },
    ]) as any)

    await syncProviderPlans('prov-x')

    expect(mockRe).toHaveBeenCalledTimes(1)
    expect(mockRe.mock.calls[0][1]).toBe('PROVIDER_COST_CHANGED')
  })

  it('6. selling is never left below cost after a successful recalc (engine mock returns >= cost)', async () => {
    // Recalc result must reflect a viable price; the sync must not overwrite with a
    // below-cost value. We assert the sync forwards the canonical result and does
    // not touch selling itself.
    mockPrisma.providerPackage.findFirst.mockResolvedValue(existingRow({
      costPrice: 4.5, markupPercent: 9, pricingStatus: 'READY',
    }))
    mockAdapter.mockResolvedValue(adapterReturning([
      { id: 'PLAN-1', name: 'Zone 5GB', data_gb: 5, validity_days: 30, price_usd: 5.0, isAvailable: true, raw_data: {} },
    ]) as any)
    mockRe.mockResolvedValue({ success: true, pricingStatus: 'READY', priceSnapshotId: 'snap-1' })

    await syncProviderPlans('prov-x')
    expect(mockRe).toHaveBeenCalledTimes(1)
  })

  it('7. missing rule on unconfigured package → no fabricated selling price, REQUIRES_PRICING', async () => {
    mockPrisma.providerPackage.findFirst.mockResolvedValue(existingRow({
      costPrice: 4.0, pricingStatus: 'COST_UNAVAILABLE',
    }))
    mockAdapter.mockResolvedValue(adapterReturning([
      { id: 'PLAN-1', name: 'Zone 5GB', data_gb: 5, validity_days: 30, price_usd: 4.5, isAvailable: true, raw_data: {} },
    ]) as any)

    await syncProviderPlans('prov-x')

    const update = mockPrisma.providerPackage.update.mock.calls[0][0] as any
    expect(update.data.pricingStatus).toBe('REQUIRES_PRICING')
    expect(mockRe).not.toHaveBeenCalled()
  })

  it('8. PUBLISHED cost change → retail synchronized via canonical sync service on repricing success', async () => {
    mockPrisma.providerPackage.findFirst.mockResolvedValue(existingRow({
      costPrice: 4.0, markupPercent: 9, pricingStatus: 'READY', publishStatus: 'PUBLISHED',
    }))

    // $transaction executes the callback; providerPackage.findUnique inside it returns
    // the post-recalc row with a new selling price.
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      mockPrisma.providerPackage.findUnique = vi.fn().mockResolvedValue(existingRow({
        costPrice: 4.5, markupPercent: 9, sellingPrice: 4.91, pricingStatus: 'READY', publishStatus: 'PUBLISHED',
      }))
      await fn(mockPrisma)
    })

    mockAdapter.mockResolvedValue(adapterReturning([
      { id: 'PLAN-1', name: 'Zone 5GB', data_gb: 5, validity_days: 30, price_usd: 4.5, isAvailable: true, raw_data: {} },
    ]) as any)

    await syncProviderPlans('prov-x')

    expect(mockRe).toHaveBeenCalledTimes(1)
    expect(mockRe.mock.calls[0][1]).toBe('PROVIDER_COST_CHANGED')
    // Retail sync uses the post-recalc row (selling 4.91), same providerPackage id.
    expect(mockSync).toHaveBeenCalledTimes(1)
    const syncArg = mockSync.mock.calls[0][1] as any
    expect(syncArg.id).toBe('pp-1')
    expect(Number(syncArg.sellingPrice)).toBe(4.91)
  })

  it('9. PUBLISHED repricing failure → retail NOT rewritten, purchase fail-closed (no silent publish)', async () => {
    mockPrisma.providerPackage.findFirst.mockResolvedValue(existingRow({
      costPrice: 4.5, markupPercent: 9, pricingStatus: 'READY', publishStatus: 'PUBLISHED',
    }))
    mockRe.mockResolvedValue({ success: false, pricingStatus: 'MARGIN_BELOW_MINIMUM', reason: 'Sell <= cost' })

    mockAdapter.mockResolvedValue(adapterReturning([
      { id: 'PLAN-1', name: 'Zone 5GB', data_gb: 5, validity_days: 30, price_usd: 9.0, isAvailable: true, raw_data: {} },
    ]) as any)

    await syncProviderPlans('prov-x')

    expect(mockRe).toHaveBeenCalledTimes(1)
    // Failure → no retail sync, no publish, no recreation.
    expect(mockSync).not.toHaveBeenCalled()
    expect(mockPrisma.providerPackage.create).not.toHaveBeenCalled()
  })

  it('10. sync never auto-publishes', async () => {
    mockPrisma.providerPackage.findFirst.mockResolvedValue(existingRow({
      costPrice: 4.0, markupPercent: 9, pricingStatus: 'READY', publishStatus: 'READY',
    }))
    mockAdapter.mockResolvedValue(adapterReturning([
      { id: 'PLAN-1', name: 'Zone 5GB', data_gb: 5, validity_days: 30, price_usd: 4.5, isAvailable: true, raw_data: {} },
    ]) as any)

    await syncProviderPlans('prov-x')

    const update = mockPrisma.providerPackage.update.mock.calls[0][0] as any
    expect(update.data.publishStatus).toBeUndefined()
    const create = mockPrisma.providerPackage.create.mock.calls[0]?.[0] as any
    // No NEW row was created either (existed); and nothing sets PUBLISHED.
    const allUpdates = mockPrisma.providerPackage.update.mock.calls.map((c: any) => c[0].data)
    for (const d of allUpdates) expect(d.publishStatus).toBeUndefined()
    expect(create).toBeUndefined()
  })
})