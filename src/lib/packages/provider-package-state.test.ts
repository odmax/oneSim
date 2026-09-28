import { describe, it, expect } from 'vitest'
import { classifyProviderPackageState, PROVIDER_PACKAGE_STATE_LABELS } from './provider-package-state'

const base = {
  isAvailable: true,
  purchaseReady: false,
  configurationStatus: 'CONFIGURED',
  publishStatus: 'DRAFT',
  pricingStatus: 'READY',
  activePriceSnapshotId: 'snap-1',
  sellingPrice: { toString: () => '9.99' },
  costPrice: { toString: () => '3.00' },
}

describe('classifyProviderPackageState — admin Provider Catalog states', () => {
  it('quarantine wins over everything (isAvailable=false)', () => {
    const s = classifyProviderPackageState({ ...base, isAvailable: false, purchaseReady: true })
    expect(s).toBe('UNAVAILABLE_QUARANTINED')
  })

  it('operational-ready record is READY', () => {
    expect(classifyProviderPackageState({ ...base, purchaseReady: true })).toBe('READY')
  })

  it('unconfigured plan is NEEDS_CONFIGURATION', () => {
    expect(classifyProviderPackageState({ ...base, configurationStatus: 'UNCONFIGURED' })).toBe('NEEDS_CONFIGURATION')
    expect(classifyProviderPackageState({ ...base, configurationStatus: 'PARTIAL' })).toBe('NEEDS_CONFIGURATION')
    expect(classifyProviderPackageState({ ...base, configurationStatus: null })).toBe('NEEDS_CONFIGURATION')
  })

  it('configured but unpriced is NEEDS_PRICING', () => {
    expect(classifyProviderPackageState({ ...base, pricingStatus: 'COST_UNAVAILABLE' })).toBe('NEEDS_PRICING')
    expect(classifyProviderPackageState({ ...base, sellingPrice: { toString: () => '0' } })).toBe('NEEDS_PRICING')
    expect(classifyProviderPackageState({ ...base, costPrice: { toString: () => '0' } })).toBe('NEEDS_PRICING')
    expect(classifyProviderPackageState({ ...base, activePriceSnapshotId: null })).toBe('NEEDS_PRICING')
  })

  it('configured, priced, non-published plan is DRAFT_UNPUBLISHED', () => {
    expect(classifyProviderPackageState({ ...base, publishStatus: 'READY' })).toBe('DRAFT_UNPUBLISHED')
    expect(classifyProviderPackageState({ ...base, publishStatus: 'ARCHIVED' })).toBe('DRAFT_UNPUBLISHED')
  })

  it('edge fallback BLOCKED_OTHER for otherwise unexplained state', () => {
    expect(classifyProviderPackageState({ ...base, publishStatus: 'PUBLISHED' })).toBe('BLOCKED_OTHER')
  })

  it('missing availability follows persisted semantics (undefined is not quarantine)', () => {
    expect(classifyProviderPackageState({ ...base, isAvailable: undefined })).toBe('DRAFT_UNPUBLISHED')
    expect(classifyProviderPackageState({ ...base, isAvailable: undefined, purchaseReady: true })).toBe('READY')
  })

  it('labels cover all states', () => {
    const states = ['UNAVAILABLE_QUARANTINED', 'READY', 'NEEDS_CONFIGURATION', 'NEEDS_PRICING', 'DRAFT_UNPUBLISHED', 'BLOCKED_OTHER'] as const
    for (const s of states) expect(PROVIDER_PACKAGE_STATE_LABELS[s]).toBeTruthy()
  })
})