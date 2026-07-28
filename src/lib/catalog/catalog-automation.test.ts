import { describe, it, expect } from 'vitest'
import {
  detectChanges,
  classifyPackage,
  runCatalogAutomation,
} from './catalog-automation'
import type { PackageChange, ChangeField } from './catalog-automation'

function makeFields(cost: number): Partial<Record<ChangeField, string | number | null>> {
  return { cost, data: 5, validity: 30, country: 'KE', name: 'Test Plan' }
}

describe('detectChanges', () => {
  it('detects new packages (null before)', () => {
    const change = detectChanges('p1', 'Plan A', 'prov-1', 'Prov', 'PROV', null, makeFields(100))
    expect(change.event).toBe('new')
    expect(change.changes).toHaveLength(0)
    expect(change.hasSignificantChanges).toBe(false)
  })

  it('detects unchanged packages', () => {
    const before = makeFields(100)
    const after = { ...before }
    const change = detectChanges('p1', 'Plan A', 'prov-1', 'Prov', 'PROV', before, after)
    expect(change.event).toBe('unchanged')
    expect(change.changes).toHaveLength(0)
  })

  it('detects cost change', () => {
    const change = detectChanges('p1', 'Plan A', 'prov-1', 'Prov', 'PROV', makeFields(100), makeFields(120))
    expect(change.event).toBe('updated')
    const costChange = change.changes.find(c => c.field === 'cost')!
    expect(costChange.before).toBe(100)
    expect(costChange.after).toBe(120)
    expect(costChange.significant).toBe(true)
  })

  it('marks cost/data/validity/country as significant', () => {
    const change = detectChanges('p1', 'Plan A', 'prov-1', 'Prov', 'PROV', makeFields(100), { ...makeFields(100), data: 10, validity: 14, country: 'TZ' })
    expect(change.hasSignificantChanges).toBe(true)
    const costChange = change.changes.find(c => c.field === 'data')
    expect(costChange?.significant).toBe(true)
  })

  it('does not mark name/sku as significant', () => {
    const change = detectChanges('p1', 'Plan A', 'prov-1', 'Prov', 'PROV', makeFields(100), { ...makeFields(100), name: 'Plan B' })
    // Name changed but is not significant
    const nameChange = change.changes.find(c => c.field === 'name')
    expect(nameChange?.significant).toBe(false)
  })

  it('detects removed packages', () => {
    const change = detectChanges('p1', 'Plan A', 'prov-1', 'Prov', 'PROV', makeFields(100), null as any)
    // Note: removed detection requires _removed flag in production
    // In the pure function, passing null → event is 'removed'
    // But our test passes makeFields(100) as after, not null
  })
})

describe('classifyPackage', () => {
  it('classifies new packages as NEW', () => {
    const change: PackageChange = {
      packageId: 'p1', packageName: 'New Plan', providerId: 'prov-1', providerName: 'Prov', providerCode: 'PROV',
      event: 'new', changes: [], hasSignificantChanges: false,
    }
    const result = classifyPackage(change, false, false, false)
    expect(result.classification).toBe('NEW')
    expect(result.suggestedAction).toBe('CONFIGURE')
    expect(result.needsReview).toBe(true)
  })

  it('classifies removed packages as NEEDS_ATTENTION', () => {
    const change: PackageChange = {
      packageId: 'p1', packageName: 'Old Plan', providerId: 'prov-1', providerName: 'Prov', providerCode: 'PROV',
      event: 'removed', changes: [], hasSignificantChanges: false,
    }
    const result = classifyPackage(change, false, false, false)
    expect(result.classification).toBe('NEEDS_ATTENTION')
    expect(result.suggestedAction).toBe('ARCHIVE')
  })

  it('classifies cost change without pricing as NEEDS_ATTENTION', () => {
    const change: PackageChange = {
      packageId: 'p1', packageName: 'Plan', providerId: 'prov-1', providerName: 'Prov', providerCode: 'PROV',
      event: 'updated',
      changes: [{ field: 'cost', before: 100, after: 120, significant: true }],
      hasSignificantChanges: true,
    }
    const result = classifyPackage(change, false, false, false)
    expect(result.classification).toBe('NEEDS_ATTENTION')
    expect(result.suggestedAction).toBe('REVIEW_PRICING')
  })

  it('classifies cost change with pricing as UPDATED', () => {
    const change: PackageChange = {
      packageId: 'p1', packageName: 'Plan', providerId: 'prov-1', providerName: 'Prov', providerCode: 'PROV',
      event: 'updated',
      changes: [{ field: 'cost', before: 100, after: 120, significant: true }],
      hasSignificantChanges: true,
    }
    const result = classifyPackage(change, true, false, false)
    expect(result.classification).toBe('UPDATED')
  })

  it('classifies unchanged as UNCHANGED', () => {
    const change: PackageChange = {
      packageId: 'p1', packageName: 'Plan', providerId: 'prov-1', providerName: 'Prov', providerCode: 'PROV',
      event: 'unchanged', changes: [], hasSignificantChanges: false,
    }
    const result = classifyPackage(change, false, false, false)
    expect(result.classification).toBe('UNCHANGED')
    expect(result.suggestedAction).toBe('NO_ACTION')
    expect(result.needsReview).toBe(false)
  })

  it('marks published packages with changes for review', () => {
    const change: PackageChange = {
      packageId: 'p1', packageName: 'Plan', providerId: 'prov-1', providerName: 'Prov', providerCode: 'PROV',
      event: 'updated',
      changes: [{ field: 'name', before: 'Old', after: 'New', significant: false }],
      hasSignificantChanges: false,
    }
    const result = classifyPackage(change, false, false, true)
    expect(result.classification).toBe('READY_FOR_REVIEW')
    expect(result.needsReview).toBe(true)
  })
})

describe('runCatalogAutomation', () => {
  it('runs full pipeline and returns AutomationResult', () => {
    const result = runCatalogAutomation([
      { packageId: 'p1', packageName: 'New Plan', providerId: 'prov-1', providerName: 'ProvA', providerCode: 'A', before: null, after: makeFields(100), hasPricing: false, isPublished: false },
      { packageId: 'p2', packageName: 'Unchanged', providerId: 'prov-2', providerName: 'ProvB', providerCode: 'B', before: makeFields(100), after: { ...makeFields(100) }, hasPricing: true, isPublished: true },
      { packageId: 'p3', packageName: 'Cost Up', providerId: 'prov-1', providerName: 'ProvA', providerCode: 'A', before: makeFields(50), after: makeFields(75), hasPricing: false, isPublished: false },
    ])

    expect(result.report).toBeDefined()
    expect(result.packages).toHaveLength(3)
    expect(result.reviewQueue).toBeDefined()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)

    // p1 should be NEW → in review queue
    const p1 = result.packages.find(p => p.packageId === 'p1')!
    expect(p1.classification).toBe('NEW')
    expect(p1.needsReview).toBe(true)

    // p2 should be UNCHANGED → not in review queue
    const p2 = result.packages.find(p => p.packageId === 'p2')!
    expect(p2.classification).toBe('UNCHANGED')
    expect(p2.needsReview).toBe(false)

    // p3 has cost change without pricing → NEEDS_ATTENTION
    const p3 = result.packages.find(p => p.packageId === 'p3')!
    expect(p3.classification).toBe('NEEDS_ATTENTION')
  })

  it('builds review queue with only needsReview packages', () => {
    const result = runCatalogAutomation([
      { packageId: 'p1', packageName: 'New', providerId: 'prov-1', providerName: 'P', providerCode: 'X', before: null, after: makeFields(100), hasPricing: false, isPublished: false },
      { packageId: 'p2', packageName: 'Unchanged', providerId: 'prov-1', providerName: 'P', providerCode: 'X', before: makeFields(100), after: { ...makeFields(100) }, hasPricing: true, isPublished: true },
    ])

    expect(result.reviewQueue).toHaveLength(1)
    expect(result.reviewQueue[0].packageId).toBe('p1')
  })

  it('generates accurate classification summary', () => {
    const result = runCatalogAutomation([
      { packageId: 'p1', packageName: 'A', providerId: 'prov-1', providerName: 'P', providerCode: 'X', before: null, after: makeFields(100), hasPricing: false, isPublished: false },
      { packageId: 'p2', packageName: 'B', providerId: 'prov-1', providerName: 'P', providerCode: 'X', before: null, after: makeFields(100), hasPricing: false, isPublished: false },
    ])

    expect(result.report.classificationSummary.newPackages).toBe(2)
    expect(result.report.classificationSummary.unchanged).toBe(0)
  })

  it('never writes to database', () => {
    const result = runCatalogAutomation([
      { packageId: 'p1', packageName: 'Plan', providerId: 'prov-1', providerName: 'P', providerCode: 'X', before: null, after: makeFields(100), hasPricing: false, isPublished: false },
    ])

    expect(result).toHaveProperty('report')
    expect(result).toHaveProperty('packages')
    expect(result).toHaveProperty('reviewQueue')
    expect(result).not.toHaveProperty('transaction')
    expect(result).not.toHaveProperty('saved')
  })
})
