import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  eSIMFindMany: vi.fn(),
  providerFindMany: vi.fn(),
  queryRaw: vi.fn(),
  isApiExposed: vi.fn(async () => true),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    eSIMPackage: { findMany: mocks.eSIMFindMany },
    provider: { findMany: mocks.providerFindMany },
    $queryRawUnsafe: mocks.queryRaw,
  },
}))

vi.mock('@/lib/providers/capabilities/exposure', () => ({
  isCapabilityExposedToPortal: vi.fn(async () => true),
  isCapabilityExposedToApi: mocks.isApiExposed,
}))

import { queryPurchasablePackages } from './query-purchasable'
import { computeCatalogStats } from './catalog-stats'
import { buildPortalExposureForRetail, countOperationalReadyCustomBackings, isStalePriced } from './customer-visibility'
import { takeWindow, CATALOG_PAGE_SIZE } from './catalog-pagination'

function mkPP(overrides: Record<string, any> = {}): any {
  return {
    id: 'pp-1',
    providerId: 'prov-1',
    publishStatus: 'PUBLISHED',
    configurationStatus: 'CONFIGURED',
    pricingStatus: 'READY',
    costStatus: 'VALID',
    activePriceSnapshotId: 'snap-1',
    sellingPrice: { toString: () => '10.00' },
    costPrice: { toString: () => '3.00' },
    isAvailable: true,
    ...overrides,
  }
}

function mkProv(overrides: Record<string, any> = {}): any {
  return { id: 'prov-1', name: 'Choice', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'], code: 'CHOICE', ...overrides }
}

function mkRetail(id: string, opts: { pp?: any; prov?: any; priceUSD?: number; bindings?: any[]; providerPackageId?: string | null; providerId?: string | null } = {}): any {
  const pp = opts.pp || null
  const prov = opts.prov || null
  return {
    id,
    isActive: true,
    hiddenFromCatalog: false,
    archivedAt: null,
    source: 'CATALOG_PRODUCT',
    providerPackageId: opts.providerPackageId !== undefined ? opts.providerPackageId : (pp ? 'pp-' + id : null),
    providerId: opts.providerId !== undefined ? opts.providerId : (prov ? prov.id : null),
    dataGB: 1,
    validityDays: 30,
    priceUSD: { toString: () => String(opts.priceUSD ?? 10) },
    providerPackage: pp,
    provider: prov,
    providerBindings: opts.bindings || [],
  }
}

function mkBinding(pp: any, prov: any, isActive = true): any {
  return { id: 'bnd', isActive, providerPackage: { ...pp, provider: prov } }
}

function exposureRows(rows: Array<{ providerId: string; clientPortalEnabled: boolean }>) {
  mocks.queryRaw.mockResolvedValue(rows)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.eSIMFindMany.mockReset()
  mocks.providerFindMany.mockReset()
  mocks.queryRaw.mockReset()
  mocks.isApiExposed.mockReset()
  mocks.isApiExposed.mockResolvedValue(true)
  mocks.queryRaw.mockResolvedValue([])
})

describe('REQUIRED PORTAL INVARIANT', () => {
  it('Admin Product Catalog Customer-Visible IDs === queryPurchasablePackages(portal) IDs', async () => {
    const readyPP = mkPP()
    const readyProv = mkProv()
    const stale = mkRetail('stale', { pp: mkPP(), prov: readyProv, priceUSD: 9.5 }) // parity gap 0.5 → excluded
    const exposed = mkRetail('exposed', { pp: mkPP(), prov: readyProv })
    const quarantined = mkRetail('quar', { pp: mkPP({ isAvailable: false }), prov: readyProv })
    const customNoBacking = mkRetail('custom-no', { providerPackageId: null, providerId: null, bindings: [mkBinding(mkPP({ id: 'b-unconf', configurationStatus: 'UNCONFIGURED' }), readyProv)] })
    const customVerified = mkRetail('custom-ok', { providerPackageId: null, providerId: null, bindings: [mkBinding(mkPP({ id: 'b-ok' }), readyProv)] })
    const list = [exposed, stale, quarantined, customNoBacking, customVerified]

    mocks.eSIMFindMany.mockResolvedValue(list)
    mocks.providerFindMany.mockResolvedValue([readyProv])
    exposureRows([{ providerId: 'prov-1', clientPortalEnabled: true }])
    mocks.isApiExposed.mockResolvedValue(true)

    const portal = await queryPurchasablePackages('portal')
    const portalIds = new Set(portal.map(p => p.id))

    const exposureMap = await buildPortalExposureForRetail(list.map(p => ({
      providerId: p.providerId,
      providerPackage: p.providerPackage?.providerId ? { providerId: p.providerPackage.providerId } : null,
    })))
    const stats = computeCatalogStats(list, exposureMap)

    // Operational Live = all ready rows (stale parity and quarantine only
    // affect visibility); Quarantined and custom-with-no-verified-backing are
    // not operational.
    expect(stats.operationalLiveIds.sort()).toEqual(['custom-ok', 'exposed', 'stale'])
    expect(new Set(stats.customerVisibleIds)).toEqual(portalIds)
    expect(stats.customerVisibleIds.sort()).toEqual([...portalIds].sort())
  })

  it('Buy eSIM receives ALL portal-visible IDs across pagination (no truncation)', async () => {
    const ready = Array.from({ length: 27 }, (_, i) => mkRetail('p' + String(i).padStart(2, '0'), { pp: mkPP({ id: 'pp-' + i, sellingPrice: { toString: () => String(1 + i) } }), prov: mkProv(), priceUSD: 1 + i }))
    mocks.eSIMFindMany.mockResolvedValue(ready)
    mocks.providerFindMany.mockResolvedValue([mkProv()])
    exposureRows([]) // default-enabled
    const portal = await queryPurchasablePackages('portal')
    expect(portal).toHaveLength(27)
    // page windows cover the whole set, deterministic order
    const sorted = takeWindow(portal, portal.length).map(p => p.id)
    expect(new Set(sorted).size).toBe(27)
    expect(takeWindow(portal, CATALOG_PAGE_SIZE).length).toBe(24)
    expect(takeWindow(portal, CATALOG_PAGE_SIZE * 2).length).toBe(27)
  })
})

describe('API surface follows clientApiEnabled independently of portal', () => {
  it('portal true / API false: API excludes what portal includes', async () => {
    const list = [mkRetail('a', { pp: mkPP(), prov: mkProv() })]
    mocks.eSIMFindMany.mockResolvedValue(list)
    mocks.providerFindMany.mockResolvedValue([mkProv()])
    exposureRows([{ providerId: 'prov-1', clientPortalEnabled: true }])
    mocks.isApiExposed.mockResolvedValue(false)
    expect((await queryPurchasablePackages('portal')).map(p => p.id)).toEqual(['a'])
    expect(await queryPurchasablePackages('api')).toEqual([])
  })

  it('portal false / API true: API includes what portal excludes', async () => {
    const list = [mkRetail('a', { pp: mkPP(), prov: mkProv() })]
    mocks.eSIMFindMany.mockResolvedValue(list)
    mocks.providerFindMany.mockResolvedValue([mkProv()])
    exposureRows([{ providerId: 'prov-1', clientPortalEnabled: false }])
    mocks.isApiExposed.mockResolvedValue(true)
    expect(await queryPurchasablePackages('portal')).toEqual([])
    expect((await queryPurchasablePackages('api')).map(p => p.id)).toEqual(['a'])
  })
})

describe('isAvailable folds into operational readiness', () => {
  it('isAvailable:false is excluded from operational AND customer-visible sets', async () => {
    const quarantined = mkRetail('quar', { pp: mkPP({ isAvailable: false }), prov: mkProv() })
    const ok = mkRetail('ok', { pp: mkPP(), prov: mkProv() })
    const list = [quarantined, ok]
    mocks.eSIMFindMany.mockResolvedValue(list)
    mocks.providerFindMany.mockResolvedValue([mkProv()])
    exposureRows([{ providerId: 'prov-1', clientPortalEnabled: true }])
    const exposureMap = await buildPortalExposureForRetail(list.map(p => ({ providerId: p.providerId, providerPackage: null })))
    const stats = computeCatalogStats(list, exposureMap)
    expect(stats.operationalLiveIds).toEqual(['ok'])
    expect(stats.customerVisibleIds).toEqual(['ok'])
    expect((await queryPurchasablePackages('portal')).map(p => p.id)).toEqual(['ok'])
  })

  it('missing availability (undefined) follows persisted semantics — not a block', async () => {
    const list = [mkRetail('ok', { pp: mkPP({ isAvailable: undefined }), prov: mkProv() })]
    mocks.eSIMFindMany.mockResolvedValue(list)
    mocks.providerFindMany.mockResolvedValue([mkProv()])
    exposureRows([])
    expect((await queryPurchasablePackages('portal')).map(p => p.id)).toEqual(['ok'])
  })
})

describe('custom-product readiness uses verified operational backings', () => {
  it('countOperationalReadyCustomBackings requires full readiness incl isAvailable', () => {
    const readyBinding = mkBinding(mkPP({ id: 'r' }), mkProv())
    const quarantinedBinding = mkBinding(mkPP({ id: 'q', isAvailable: false }), mkProv())
    const unpricedBinding = mkBinding(mkPP({ id: 'u', pricingStatus: 'COST_UNAVAILABLE' }), mkProv())
    const providerPaused = mkBinding(mkPP({ id: 'd' }), mkProv({ status: 'INACTIVE' }))
    expect(countOperationalReadyCustomBackings([readyBinding])).toBe(1)
    expect(countOperationalReadyCustomBackings([quarantinedBinding, readyBinding])).toBe(1)
    expect(countOperationalReadyCustomBackings([unpricedBinding, providerPaused])).toBe(0)
    expect(countOperationalReadyCustomBackings([])).toBe(0)
  })

  it('custom product with no verified-ready binding is excluded', async () => {
    const list = [mkRetail('c-no', { providerPackageId: null, providerId: null, bindings: [mkBinding(mkPP({ id: 'b', pricingStatus: 'COST_UNAVAILABLE' }), mkProv())] })]
    mocks.eSIMFindMany.mockResolvedValue(list)
    mocks.providerFindMany.mockResolvedValue([mkProv()])
    exposureRows([])
    expect(await queryPurchasablePackages('portal')).toEqual([])
    const exposureMap = await buildPortalExposureForRetail([])
    const stats = computeCatalogStats(list, exposureMap)
    expect(stats.customerVisibleIds).toEqual([])
  })

  it('custom product with at least one verified-ready binding is included', async () => {
    const list = [mkRetail('c-ok', { providerPackageId: null, providerId: null, bindings: [mkBinding(mkPP({ id: 'b1' }), mkProv())] })]
    mocks.eSIMFindMany.mockResolvedValue(list)
    mocks.providerFindMany.mockResolvedValue([mkProv()])
    exposureRows([])
    expect((await queryPurchasablePackages('portal')).map(p => p.id)).toEqual(['c-ok'])
  })

  it('unavailable binding plus ready binding remains purchasable through the ready one', async () => {
    const list = [mkRetail('c-both', {
      providerPackageId: null,
      providerId: null,
      bindings: [
        mkBinding(mkPP({ id: 'b-bad', isAvailable: false }), mkProv()),
        mkBinding(mkPP({ id: 'b-good' }), mkProv()),
      ],
    })]
    mocks.eSIMFindMany.mockResolvedValue(list)
    mocks.providerFindMany.mockResolvedValue([mkProv()])
    exposureRows([])
    expect((await queryPurchasablePackages('portal')).map(p => p.id)).toEqual(['c-both'])
  })
})

describe('exposure default and parity boundary', () => {
  it('missing ProviderCapabilityExposure row retains default-enabled behavior', async () => {
    const list = [mkRetail('a', { pp: mkPP(), prov: mkProv() })]
    mocks.eSIMFindMany.mockResolvedValue(list)
    mocks.providerFindMany.mockResolvedValue([mkProv()])
    exposureRows([])
    expect((await queryPurchasablePackages('portal')).map(p => p.id)).toEqual(['a'])
    expect((await queryPurchasablePackages('api')).map(p => p.id)).toEqual(['a'])
  })

  it('parity boundary: 0.004 passes, 0.005 fails', async () => {
    const pass = mkRetail('p', { pp: mkPP(), prov: mkProv(), priceUSD: 10.004 })
    const fail = mkRetail('f', { pp: mkPP({ id: 'pp-f' }), prov: mkProv(), priceUSD: 10.005 })
    expect(isStalePriced(pass, pass.providerPackage)).toBe(false)
    expect(isStalePriced(fail, fail.providerPackage)).toBe(true)
    mocks.eSIMFindMany.mockResolvedValue([pass, fail])
    mocks.providerFindMany.mockResolvedValue([mkProv()])
    exposureRows([])
    expect((await queryPurchasablePackages('portal')).map(p => p.id)).toEqual(['p'])
  })
})

describe('inventory is not a universal visibility gate', () => {
  it('no stock field is consumed; supportsPools/pool flags do not gate visibility', async () => {
    const list = [
      mkRetail('a', { pp: { ...mkPP(), stockOperational: false, inventoryRequired: true }, prov: mkProv({ supportsPools: false, supportsTemplates: false }) }),
    ]
    mocks.eSIMFindMany.mockResolvedValue(list)
    mocks.providerFindMany.mockResolvedValue([mkProv()])
    exposureRows([])
    // readiness ignores any stock/inventory-shaped field
    expect((await queryPurchasablePackages('portal')).map(p => p.id)).toEqual(['a'])
  })
})