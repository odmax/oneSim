import { describe, it, expect } from 'vitest'
import {
  analyzeCatalogVisibility,
  aggregateReasons,
  formatCatalogVisibilityReport,
  type DiagnosticRetailCandidate,
  type DiagnosticExposureState,
  type DiagnosticProviderInfo,
} from './catalog-visibility-diagnostic'

function makeCandidate(overrides: Partial<DiagnosticRetailCandidate> = {}): DiagnosticRetailCandidate {
  return {
    id: 'retail-1',
    name: 'Test Nigeria 1GB 1Day',
    displayName: 'Test Nigeria 1GB 1Day',
    isActive: true,
    hiddenFromCatalog: false,
    archivedAt: null,
    source: 'CATALOG_PRODUCT',
    providerPackageId: 'pp-1',
    priceUSD: 7.69,
    providerPackage: {
      id: 'pp-1',
      providerId: 'prov-1',
      costStatus: 'VALID',
      pricingStatus: 'READY',
      publishStatus: 'PUBLISHED',
      configurationStatus: 'CONFIGURED',
      activePriceSnapshotId: 'snap-1',
      sellingPrice: 7.69,
      costPrice: 7,
    },
    provider: { id: 'prov-1', code: 'CHOICE', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'] },
    ...overrides,
  }
}

function exposure(portal: boolean, api: boolean): DiagnosticExposureState {
  return { portalPurchase: portal, apiPurchase: api }
}

function providerInfo(overrides: Partial<DiagnosticProviderInfo> = {}): DiagnosticProviderInfo {
  return { id: 'prov-1', code: 'CHOICE', status: 'ACTIVE', adapterStrategy: 'CHOICE', enabledCapabilities: ['PURCHASE'], ...overrides }
}

describe('catalog-visibility-diagnostic (pure aggregation)', () => {
  it('aggregates purchase readiness reasons with exact counts', () => {
    const candidates = [
      makeCandidate(),
      makeCandidate({ id: 'retail-2', providerPackage: { ...makeCandidate().providerPackage!, activePriceSnapshotId: null } }),
      makeCandidate({ id: 'retail-3', providerPackage: { ...makeCandidate().providerPackage!, activePriceSnapshotId: null } }),
    ]
    const report = analyzeCatalogVisibility({
      candidates,
      exposureByProvider: { 'prov-1': exposure(true, true) },
      providerInfo: { 'prov-1': providerInfo() },
    })
    expect(report.purchaseReady).toBe(1)
    expect(report.purchaseNotReady).toBe(2)
    const snap = report.purchaseReasons.find(r => r.reason === 'No active price snapshot')
    expect(snap?.count).toBe(2)
  })

  it('keeps portal and API exposure separate', () => {
    const candidates = [
      makeCandidate({ id: 'retail-1' }),
      makeCandidate({ id: 'retail-2' }),
    ]
    const report = analyzeCatalogVisibility({
      candidates,
      exposureByProvider: { 'prov-1': exposure(true, false) }, // portal ON, API OFF
      providerInfo: { 'prov-1': providerInfo() },
    })
    expect(report.portalExposureAllowed).toBe(2)
    expect(report.apiExposureAllowed).toBe(0)
    expect(report.apiExposureDenied).toBe(2)
    expect(report.portalFinal).toBe(2)
    expect(report.apiFinal).toBe(0)
  })

  it('CHOICE pipeline identifies exactly where rows drop', () => {
    const candidates = [
      makeCandidate(), // ready + exposed
      makeCandidate({ id: 'retail-2', providerPackage: { ...makeCandidate().providerPackage!, activePriceSnapshotId: null } }), // not ready
      makeCandidate({ id: 'retail-3' }), // ready but portal+api exposure OFF
    ]
    const report = analyzeCatalogVisibility({
      candidates,
      exposureByProvider: { 'prov-1': exposure(false, false) },
      providerInfo: { 'prov-1': providerInfo() },
    })
    expect(report.choice.initial).toBe(3)
    expect(report.choice.purchaseReady).toBe(2)
    expect(report.choice.purchaseNotReady).toBe(1)
    expect(report.choice.portalExposed).toBe(0)
    expect(report.choice.portalFinal).toBe(0)
    expect(report.choice.reasons.find(r => r.reason === 'No active price snapshot')?.count).toBe(1)
  })

  it('does not mutate input candidates', () => {
    const original = makeCandidate()
    const snapshot = JSON.stringify(original)
    analyzeCatalogVisibility({
      candidates: [original],
      exposureByProvider: { 'prov-1': exposure(true, true) },
      providerInfo: { 'prov-1': providerInfo() },
    })
    expect(JSON.stringify(original)).toBe(snapshot)
  })

  it('does not include secrets/tokens in the formatted report', () => {
    const candidates = [makeCandidate()]
    const report = analyzeCatalogVisibility({
      candidates,
      exposureByProvider: { 'prov-1': exposure(true, true) },
      providerInfo: { 'prov-1': providerInfo() },
    })
    const text = formatCatalogVisibilityReport(report)
    expect(text).toContain('CATALOG VISIBILITY DIAGNOSTIC')
    expect(text).toContain('READ ONLY')
    expect(text).toContain('NO DATABASE WRITE')
    expect(text).toContain('NO PROVIDER CALL')
    expect(text).toContain('NO PUBLISH')
    expect(text).toContain('NO SYNC')
    expect(text).not.toMatch(/token|apiToken|password|secret/i)
  })

  it('reports provider summaries with safe fields only (no credentials)', () => {
    const candidates = [makeCandidate()]
    const report = analyzeCatalogVisibility({
      candidates,
      exposureByProvider: { 'prov-1': exposure(true, true) },
      providerInfo: { 'prov-1': providerInfo() },
    })
    const prov = report.providers[0]
    expect(prov.code).toBe('CHOICE')
    expect(prov.status).toBe('ACTIVE')
    expect(prov.adapterStrategy).toBe('CHOICE')
    expect(prov.enabledCapabilities).toEqual(['PURCHASE'])
    expect(Object.keys(prov)).not.toContain('apiToken')
    expect(JSON.stringify(prov)).not.toMatch(/token|password|secret/i)
  })

  it('aggregateReasons sorts by count descending', () => {
    const reasons = aggregateReasons([['A', 'B'], ['A'], ['B'], ['B'], ['C']])
    expect(reasons[0]).toEqual({ reason: 'B', count: 3 })
    expect(reasons[1]).toEqual({ reason: 'A', count: 2 })
    expect(reasons[2]).toEqual({ reason: 'C', count: 1 })
  })
})
