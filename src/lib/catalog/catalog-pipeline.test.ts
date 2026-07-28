import { describe, it, expect } from 'vitest'
import { runCatalogPipeline } from './catalog-pipeline'
import { runCatalogAutomation } from './catalog-automation'
import type { PipelineResult } from './catalog-pipeline'

function makePackage(packageId: string, cost: number, hasPricing: boolean, isPublished: boolean = false) {
  return {
    packageId,
    packageName: `Package ${packageId}`,
    providerId: 'prov-1',
    providerName: 'TestProvider',
    providerCode: 'TEST',
    before: { cost, data: 5, validity: 30, country: 'KE', name: `Plan ${packageId}` },
    after: { cost, data: 5, validity: 30, country: 'KE', name: `Plan ${packageId}` },
    hasPricing,
    isPublished,
  }
}

function runAutomation(count: number, changedIds: string[] = []): ReturnType<typeof runCatalogAutomation> {
  const inputs = Array.from({ length: count }, (_, i) => {
    const id = `pkg-${i + 1}`
    const costChanged = changedIds.includes(id)
    return {
      packageId: id,
      packageName: `Package ${id}`,
      providerId: 'prov-1',
      providerName: 'TestProvider',
      providerCode: 'TEST',
      before: { cost: costChanged ? 80 : 100, data: 5, validity: 30, country: 'KE', name: `Plan ${id}` },
      after: { cost: costChanged ? 120 : 100, data: 5, validity: 30, country: 'KE', name: `Plan ${id}` },
      hasPricing: true,
      isPublished: false,
    }
  })
  return runCatalogAutomation(inputs)
}

describe('runCatalogPipeline', () => {
  it('processes automation results into PipelineResult', () => {
    const automation = runAutomation(5)
    const result = runCatalogPipeline({ automation })

    expect(result.totalProcessed).toBe(5)
    expect(result.reviewItems).toHaveLength(5)
    expect(result.byState).toBeDefined()
    expect(result.currency).toBe('USD')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.processingLog.length).toBeGreaterThan(0)
  })

  it('classifies unchanged packages as SKIPPED', () => {
    const automation = runAutomation(3)
    const result = runCatalogPipeline({ automation })

    expect(result.byState.SKIPPED).toBe(3)
    for (const item of result.reviewItems) {
      expect(item.state).toBe('SKIPPED')
      expect(item.skipReason).toBe('No changes detected')
    }
  })

  it('classifies changed packages as READY_FOR_REVIEW', () => {
    const automation = runAutomation(3, ['pkg-2'])
    const result = runCatalogPipeline({ automation })

    // pkg-1 and pkg-3 unchanged → SKIPPED
    // pkg-2 cost changed → REVIEW_PRICING → READY_FOR_REVIEW
    expect(result.byState.SKIPPED).toBe(2)
    expect(result.byState.READY_FOR_REVIEW).toBe(1)
  })

  it('attaches simulation data when provided', () => {
    const automation = runAutomation(2)
    const simulations = new Map<string, { sellingPrice: number; marginPercent: number }>()
    simulations.set('pkg-1', { sellingPrice: 125, marginPercent: 20 })

    const result = runCatalogPipeline({ automation, simulations })

    const pkg1 = result.reviewItems.find(i => i.packageId === 'pkg-1')!
    expect(pkg1.simulatedSellingPrice).toBe(125)
    expect(pkg1.simulatedMargin).toBe(20)
  })

  it('attaches catalog prices when provided', () => {
    const automation = runAutomation(2)
    const catalogPrices = new Map<string, { sellingPrice: number; marginPercent: number; currentProvider: string }>()
    catalogPrices.set('pkg-1', { sellingPrice: 150, marginPercent: 33.33, currentProvider: 'TestProvider' })

    const result = runCatalogPipeline({ automation, catalogPrices })

    const pkg1 = result.reviewItems.find(i => i.packageId === 'pkg-1')!
    expect(pkg1.currentSellingPrice).toBe(150)
    expect(pkg1.currentMargin).toBe(33.33)
    expect(pkg1.currentProvider).toBe('TestProvider')
  })

  it('generates warnings for price drops', () => {
    const automation = runAutomation(2)
    const simulations = new Map<string, { sellingPrice: number; marginPercent: number }>()
    simulations.set('pkg-1', { sellingPrice: 80, marginPercent: 10 })

    const catalogPrices = new Map<string, { sellingPrice: number; marginPercent: number; currentProvider: string }>()
    catalogPrices.set('pkg-1', { sellingPrice: 100, marginPercent: 20, currentProvider: 'Test' })

    const result = runCatalogPipeline({ automation, simulations, catalogPrices })

    const pkg1 = result.reviewItems.find(i => i.packageId === 'pkg-1')!
    expect(pkg1.warnings.length).toBeGreaterThan(0)
    expect(pkg1.warnings[0]).toContain('below')
  })

  it('computes bySuggestedAction breakdown', () => {
    const inputs = [
      { packageId: 'p1', packageName: 'A', providerId: 'p', providerName: 'P', providerCode: 'X', before: null, after: { cost: 100, data: 5, validity: 30, country: 'KE' }, hasPricing: false, isPublished: false },
      { packageId: 'p2', packageName: 'B', providerId: 'p', providerName: 'P', providerCode: 'X', before: { cost: 100 }, after: { cost: 120, data: 5, validity: 30 }, hasPricing: false, isPublished: false },
      { packageId: 'p3', packageName: 'C', providerId: 'p', providerName: 'P', providerCode: 'X', before: { cost: 100, data: 5, validity: 30 }, after: { cost: 100, data: 5, validity: 30 }, hasPricing: true, isPublished: false },
    ]
    const automation = runCatalogAutomation(inputs)
    const result = runCatalogPipeline({ automation })

    expect(result.bySuggestedAction.CONFIGURE).toBe(1) // p1 = NEW → CONFIGURE
    expect(result.bySuggestedAction.REVIEW_PRICING).toBe(1) // p2 = cost changed → REVIEW_PRICING
    expect(result.bySuggestedAction.NO_ACTION).toBe(1) // p3 = unchanged
  })

  it('is idempotent', () => {
    const automation1 = runAutomation(5)
    const automation2 = runAutomation(5)

    const result1 = runCatalogPipeline({ automation: automation1 })
    const result2 = runCatalogPipeline({ automation: automation2 })

    expect(result1.totalProcessed).toBe(result2.totalProcessed)
    expect(result1.byState.SKIPPED).toBe(result2.byState.SKIPPED)
    expect(result1.reviewItems.length).toBe(result2.reviewItems.length)
  })

  it('handles empty input', () => {
    const automation = runCatalogAutomation([])
    const result = runCatalogPipeline({ automation })

    expect(result.totalProcessed).toBe(0)
    expect(result.reviewItems).toHaveLength(0)
  })

  it('computes revenue and profit impact', () => {
    const automation = runAutomation(3)
    const simulations = new Map<string, { sellingPrice: number; marginPercent: number }>()
    const catalogPrices = new Map<string, { sellingPrice: number; marginPercent: number; currentProvider: string }>()

    simulations.set('pkg-1', { sellingPrice: 150, marginPercent: 33 })
    catalogPrices.set('pkg-1', { sellingPrice: 100, marginPercent: 10, currentProvider: 'Test' })

    const result = runCatalogPipeline({ automation, simulations, catalogPrices })
    // Revenue impact: 150 - 100 = +50
    expect(result.estimatedRevenueImpact).toBe(50)
  })

  it('never writes to database', () => {
    const automation = runAutomation(3)
    const result = runCatalogPipeline({ automation })

    expect(result).toHaveProperty('totalProcessed')
    expect(result).toHaveProperty('reviewItems')
    expect(result).not.toHaveProperty('savedAt')
    expect(result).not.toHaveProperty('transaction')
  })

  it('handles large batch efficiently', () => {
    const automation = runAutomation(100, ['pkg-50', 'pkg-75'])
    const start = Date.now()
    const result = runCatalogPipeline({ automation })
    const elapsed = Date.now() - start

    expect(result.totalProcessed).toBe(100)
    expect(elapsed).toBeLessThan(500)
    // 98 unchanged → SKIPPED, 2 with cost changes → READY_FOR_REVIEW
    expect(result.byState.SKIPPED).toBe(98)
    expect(result.byState.READY_FOR_REVIEW).toBe(2)
  })
})
