import { describe, expect, it } from 'vitest'
import { buildApplyRuleScopeWhere } from './apply-rule-scope'

describe('buildApplyRuleScopeWhere', () => {
  it('implements configured + draft rather than silently treating it as all', () => {
    expect(buildApplyRuleScopeWhere('configured_draft', { includeArchived: true, includeHidden: true })).toEqual({
      OR: [
        { configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] } },
        { publishStatus: 'DRAFT' },
      ],
    })
  })

  it('combines current search with scope instead of replacing either predicate', () => {
    const where = buildApplyRuleScopeWhere('configured_draft', {
      searchQuery: 'Singapore', includeArchived: false, includeHidden: false,
    })
    expect(where.AND).toEqual([
      { OR: [
        { configurationStatus: { in: ['CONFIGURED', 'AUTO_CONFIGURED'] } },
        { publishStatus: 'DRAFT' },
      ] },
      { OR: [
        { name: { contains: 'Singapore', mode: 'insensitive' } },
        { providerPlanId: { contains: 'Singapore', mode: 'insensitive' } },
        { providerPlanCode: { contains: 'Singapore', mode: 'insensitive' } },
      ] },
    ])
    expect(where.publishStatus).toEqual({ notIn: ['ARCHIVED', 'HIDDEN'] })
  })

  it('does not overwrite an explicit publish-status filter with exclusions', () => {
    expect(buildApplyRuleScopeWhere('search', {
      publishStatus: 'READY', includeArchived: false, includeHidden: false,
    }).publishStatus).toBe('READY')
  })

  it('fails closed for selected scope with no selected IDs', () => {
    expect(buildApplyRuleScopeWhere('selected', {}).id).toEqual({ in: [] })
  })

  it('does not require an existing selling price unless explicitly requested', () => {
    const where = buildApplyRuleScopeWhere('draft', { hasCostPrice: true })
    expect(where.costPrice).toEqual({ gt: 0 })
    expect(where.sellingPrice).toBeUndefined()
  })
})

 describe('catalog search scope membership', () => {
  it('limits execution to the complete filtered catalog IDs and fails closed when empty', () => {
    expect(buildApplyRuleScopeWhere('search', {}, ['a', 'b']).id).toEqual({ in: ['a', 'b'] })
    expect(buildApplyRuleScopeWhere('search', {}, []).id).toEqual({ in: [] })
  })
})
