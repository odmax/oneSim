import { describe, it, expect } from 'vitest'
import {
  parseRepairArgs,
  buildRepairWhere,
  classifyRepairPackage,
  aggregateReasons,
  emptyRepairReport,
  formatRepairHeader,
  formatRepairReport,
} from './repair-catalog-tooling'

function makePkg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pp-1',
    name: 'Test Nigeria 1GB 1Day',
    costPrice: 7,
    adminCostPrice: null,
    sellingPrice: 7.69,
    publishedAs: { id: 'retail-1' },
    provider: { code: 'CHOICE', status: 'TESTING', enabledCapabilities: ['PURCHASE'] },
    ...overrides,
  } as any
}

const READY_PKG = makePkg({
  costStatus: 'VALID', pricingStatus: 'READY', activePriceSnapshotId: 'snap-1',
  configurationStatus: 'CONFIGURED', publishStatus: 'PUBLISHED', effectiveCostPrice: 7,
})
const BROKEN_PKG = makePkg({
  costStatus: 'MISSING', pricingStatus: 'COST_UNAVAILABLE', activePriceSnapshotId: null,
  configurationStatus: 'CONFIGURED', publishStatus: 'PUBLISHED', effectiveCostPrice: null,
})

// Default classification options helper: recovery OFF unless explicitly enabled.
function classify(pkg: any, opts: { requireRetailLink?: boolean; recoverCostFromRetail?: boolean } = {}) {
  return classifyRepairPackage(pkg, { requireRetailLink: opts.requireRetailLink ?? false, recoverCostFromRetail: opts.recoverCostFromRetail ?? false })
}

function filters(overrides: Record<string, unknown> = {}) {
  return { provider: undefined, publishStatus: undefined, publishedOnly: false, packageId: undefined, requireRetailLink: false, all: false, recoverCostFromRetail: false, ...overrides }
}

describe('parseRepairArgs', () => {
  it('defaults to dry-run when no --apply', () => {
    const r = parseRepairArgs([])
    expect(r.error).toBeUndefined()
    expect(r.mode).toBe('dry-run')
  })

  it('--provider filters (exact, uppercased)', () => {
    const r = parseRepairArgs(['--dry-run', '--provider=choice'])
    expect(r.error).toBeUndefined()
    expect(r.filters.provider).toBe('CHOICE')
    expect(r.hasTargetingFilter).toBe(true)
  })

  it('--publish-status filters', () => {
    const r = parseRepairArgs(['--dry-run', '--publish-status=PUBLISHED'])
    expect(r.filters.publishStatus).toBe('PUBLISHED')
  })

  it('--published-only maps exactly to PUBLISHED', () => {
    const r = parseRepairArgs(['--dry-run', '--published-only'])
    expect(r.filters.publishedOnly).toBe(true)
    expect(r.filters.publishStatus).toBe('PUBLISHED')
  })

  it('--recover-cost-from-retail is parsed (flag only, not a filter)', () => {
    const r = parseRepairArgs(['--dry-run', '--provider=CHOICE', '--recover-cost-from-retail'])
    expect(r.error).toBeUndefined()
    expect(r.filters.recoverCostFromRetail).toBe(true)
  })

  it('--published-only conflicting with --publish-status fails loudly', () => {
    const r = parseRepairArgs(['--dry-run', '--published-only', '--publish-status=DRAFT'])
    expect(r.error).toBeTruthy()
    expect(r.error).toContain('conflicts')
  })

  it('invalid publish status fails safely', () => {
    const r = parseRepairArgs(['--dry-run', '--publish-status=BOGUS'])
    expect(r.error).toBeTruthy()
    expect(r.error).toContain('Invalid --publish-status')
  })

  it('invalid/empty provider fails safely', () => {
    expect(parseRepairArgs(['--dry-run', '--provider=']).error).toBeTruthy()
    expect(parseRepairArgs(['--dry-run', '--provider=   ']).error).toBeTruthy()
  })

  it('unfiltered dry-run is allowed', () => {
    expect(parseRepairArgs(['--dry-run']).error).toBeUndefined()
  })

  it('unfiltered --apply is refused without --all', () => {
    const r = parseRepairArgs(['--apply'])
    expect(r.error).toBeTruthy()
    expect(r.error).toContain('Refusing broad apply')
  })

  it('filtered --apply is allowed', () => {
    const r = parseRepairArgs(['--apply', '--provider=CHOICE', '--published-only'])
    expect(r.error).toBeUndefined()
    expect(r.mode).toBe('apply')
  })

  it('--all --apply explicitly permits broad repair', () => {
    const r = parseRepairArgs(['--apply', '--all'])
    expect(r.error).toBeUndefined()
    expect(r.filters.all).toBe(true)
    expect(r.mode).toBe('apply')
  })

  it('--dry-run + --apply together fails loudly', () => {
    const r = parseRepairArgs(['--dry-run', '--apply', '--provider=CHOICE'])
    expect(r.error).toBeTruthy()
  })
})

describe('buildRepairWhere', () => {
  it('always scopes to configured packages (canonical base)', () => {
    const where = buildRepairWhere(filters())
    expect(where.configurationStatus).toEqual({ in: ['CONFIGURED', 'AUTO_CONFIGURED'] })
  })

  it('applies provider filter before classification', () => {
    const where = buildRepairWhere(filters({ provider: 'CHOICE' }))
    expect(where.provider).toEqual({ code: { equals: 'CHOICE', mode: 'insensitive' } })
  })

  it('applies publish-status filter before classification', () => {
    const where = buildRepairWhere(filters({ publishStatus: 'PUBLISHED' }))
    expect(where.publishStatus).toBe('PUBLISHED')
  })

  it('applies package-id filter', () => {
    const where = buildRepairWhere(filters({ packageId: 'pp-9' }))
    expect(where.id).toBe('pp-9')
  })
})

describe('classifyRepairPackage', () => {
  it('ready package is not repairable', () => {
    const c = classify(READY_PKG)
    expect(c.ready).toBe(true)
    expect(c.repairable).toBe(false)
    expect(c.reasons).toEqual([])
  })

  it('broken configured package with cost+selling is repairable', () => {
    const c = classify(BROKEN_PKG)
    expect(c.ready).toBe(false)
    expect(c.repairable).toBe(true)
    expect(c.reasons).toContain('No active price snapshot')
  })

  it('--require-retail-link skips orphan rows (publishedAs null) — never repairable', () => {
    const orphan = makePkg({ publishedAs: null })
    const c = classify(orphan, { requireRetailLink: true })
    expect(c.missingRetailLink).toBe(true)
    expect(c.repairable).toBe(false)
  })

  it('without require-retail-link an orphan is repairable (not skipped)', () => {
    const orphan = makePkg({ publishedAs: null })
    const c = classify(orphan)
    expect(c.missingRetailLink).toBe(false)
    expect(c.repairable).toBe(true)
  })

  it('second run skips already-ready packages', () => {
    const c = classify(READY_PKG)
    expect(c.ready).toBe(true)
    expect(c.repairable).toBe(false)
  })

  it('has no provider-name branch — provider is just metadata', () => {
    const choice = classify(BROKEN_PKG)
    const airhub = classify(makePkg({ provider: { code: 'AIRHUB', status: 'ACTIVE', enabledCapabilities: ['PURCHASE'] } }))
    expect(choice.providerCode).toBe('CHOICE')
    expect(airhub.providerCode).toBe('AIRHUB')
    expect(airhub.repairable).toBe(choice.repairable) // identical logic, no branch
  })

  it('selling price is never modified by classification', () => {
    const pkg = BROKEN_PKG
    const before = pkg.sellingPrice
    classify(pkg)
    expect(pkg.sellingPrice).toBe(before)
  })
})

describe('classifyRepairPackage — historical retail-cost recovery (provider-neutral)', () => {
  // The staging shape: costPrice=0, adminCostPrice null, linked retail costPriceUSD>0, sellingPrice>0.
  const STAGING_ROW = makePkg({
    costPrice: 0,
    adminCostPrice: null,
    effectiveCostPrice: null,
    costStatus: 'MISSING',
    pricingStatus: 'COST_UNAVAILABLE',
    activePriceSnapshotId: null,
    configurationStatus: 'CONFIGURED',
    publishStatus: 'PUBLISHED',
    publishedAs: { id: 'retail-1', costPriceUSD: 10.99 },
  })

  it('costPrice=0 + admin null + retail cost>0: without flag => NOT REPAIRABLE', () => {
    const c = classify(STAGING_ROW)
    expect(c.costSource).toBe('MISSING')
    expect(c.repairable).toBe(false)
    expect(c.recoverableRetailCost).toBe(false)
  })

  it('costPrice=0 + admin null + retail cost>0: with flag => RECOVERABLE_RETAIL_COST', () => {
    const c = classify(STAGING_ROW, { recoverCostFromRetail: true })
    expect(c.costSource).toBe('RETAIL_RECOVERY')
    expect(c.recoverableRetailCost).toBe(true)
    expect(c.retailCost).toBe(10.99)
    expect(c.repairable).toBe(false) // distinct from normal provider/admin path
  })

  it('adminCostPrice>0 always wins (even with recovery flag)', () => {
    const c = classify(makePkg({ costPrice: 0, adminCostPrice: 8, publishedAs: { id: 'retail-1', costPriceUSD: 10.99 } }), { recoverCostFromRetail: true })
    expect(c.costSource).toBe('ADMIN')
    expect(c.repairable).toBe(true)
    expect(c.recoverableRetailCost).toBe(false)
  })

  it('ProviderPackage.costPrice>0 wins over retail cost', () => {
    const c = classify(makePkg({ costPrice: 7, publishedAs: { id: 'retail-1', costPriceUSD: 10.99 } }), { recoverCostFromRetail: true })
    expect(c.costSource).toBe('PROVIDER')
    expect(c.repairable).toBe(true)
    expect(c.recoverableRetailCost).toBe(false)
  })

  it('retail cost null/zero/negative => MISSING_COST_SOURCE', () => {
    for (const retailCost of [0, null, -5]) {
      const c = classify(makePkg({ costPrice: 0, adminCostPrice: null, publishedAs: { id: 'retail-1', costPriceUSD: retailCost } }), { recoverCostFromRetail: true })
      expect(c.costSource).toBe('MISSING')
      expect(c.missingCostSource).toBe(true)
      expect(c.recoverableRetailCost).toBe(false)
    }
  })

  it('no retail link + recovery flag => MISSING_COST_SOURCE (not recoverable retail)', () => {
    const c = classify(makePkg({ costPrice: 0, adminCostPrice: null, publishedAs: null }), { recoverCostFromRetail: true })
    expect(c.costSource).toBe('MISSING')
    expect(c.missingCostSource).toBe(true)
    expect(c.recoverableRetailCost).toBe(false)
  })

  it('provider-neutral: identical recovery across CHOICE/AIRHUB/CUSTOM/USMATRIX', () => {
    for (const code of ['CHOICE', 'AIRHUB', 'CUSTOM', 'USMATRIX']) {
      const c = classify(makePkg({ costPrice: 0, adminCostPrice: null, provider: { code, status: 'ACTIVE', enabledCapabilities: ['PURCHASE'] }, publishedAs: { id: 'retail-1', costPriceUSD: 10.99 } }), { recoverCostFromRetail: true })
      expect(c.costSource).toBe('RETAIL_RECOVERY')
      expect(c.recoverableRetailCost).toBe(true)
      expect(c.missingCostSource).toBe(false)
    }
  })

  it('sellingPrice remains unchanged by classification', () => {
    const pkg = { ...STAGING_ROW, sellingPrice: 12 }
    const before = pkg.sellingPrice
    classify(pkg, { recoverCostFromRetail: true })
    expect(pkg.sellingPrice).toBe(before)
  })
})

describe('report formatting (safe output)', () => {
  it('header shows active filters', () => {
    const lines = formatRepairHeader('dry-run', filters({ provider: 'CHOICE', publishStatus: 'PUBLISHED', publishedOnly: true, requireRetailLink: true, recoverCostFromRetail: true }))
    expect(lines.join('\n')).toContain('MODE: DRY-RUN')
    expect(lines.join('\n')).toContain('PROVIDER_FILTER: CHOICE')
    expect(lines.join('\n')).toContain('PUBLISH_STATUS_FILTER: PUBLISHED')
    expect(lines.join('\n')).toContain('REQUIRE_RETAIL_LINK: true')
    expect(lines.join('\n')).toContain('RECOVER_COST_FROM_RETAIL: true')
  })

  it('report lists matched/ready/repairable/recoverable/missing/not/skipped-retail', () => {
    const report = emptyRepairReport()
    report.matched = 39
    report.ready = 0
    report.repairable = 0
    report.recoverableRetailCost = 38
    report.missingCostSource = 1
    report.notRepairable = 0
    report.skippedMissingRetailLink = 0
    const text = formatRepairReport(report).join('\n')
    expect(text).toContain('Matched: 39')
    expect(text).toContain('Already ready: 0')
    expect(text).toContain('Repairable: 0')
    expect(text).toContain('Recoverable retail cost: 38')
    expect(text).toContain('Missing cost source: 1')
    expect(text).toContain('Not repairable: 0')
    expect(text).toContain('Skipped missing retail link: 0')
  })

  it('secrets/tokens never appear in report output', () => {
    const lines = [...formatRepairHeader('dry-run', filters({ provider: 'CHOICE', publishStatus: 'PUBLISHED', publishedOnly: true, requireRetailLink: true, recoverCostFromRetail: true })), ...formatRepairReport(emptyRepairReport())]
    expect(lines.join('\n')).not.toMatch(/token|apiToken|password|secret|Bearer/i)
  })
})

describe('aggregateReasons', () => {
  it('sorts by count descending', () => {
    const r = aggregateReasons([['A', 'B'], ['A'], ['B'], ['B'], ['C']])
    expect(r[0]).toEqual({ reason: 'B', count: 3 })
    expect(r[1]).toEqual({ reason: 'A', count: 2 })
    expect(r[2]).toEqual({ reason: 'C', count: 1 })
  })
})
