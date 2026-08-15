import { describe, it, expect } from 'vitest'
import { isPackagePublishEligible, getPublishIneligibilityReasons, PUBLISH_INELIGIBLE_MESSAGE } from './publish-eligibility'

describe('isPackagePublishEligible (publish eligibility gate)', () => {
  it('eligible: CONFIGURED', () => {
    expect(isPackagePublishEligible({ configurationStatus: 'CONFIGURED', publishStatus: 'DRAFT' })).toBe(true)
  })

  it('eligible: AUTO_CONFIGURED', () => {
    expect(isPackagePublishEligible({ configurationStatus: 'AUTO_CONFIGURED', publishStatus: 'DRAFT' })).toBe(true)
  })

  it('eligible: READY', () => {
    expect(isPackagePublishEligible({ configurationStatus: 'UNCONFIGURED', publishStatus: 'READY' })).toBe(true)
  })

  it('eligible: CONFIGURED + READY + PUBLISHED (source-state superset)', () => {
    expect(isPackagePublishEligible({ configurationStatus: 'CONFIGURED', publishStatus: 'PUBLISHED' })).toBe(true)
  })

  it('blocked: UNCONFIGURED + DRAFT', () => {
    expect(isPackagePublishEligible({ configurationStatus: 'UNCONFIGURED', publishStatus: 'DRAFT' })).toBe(false)
  })

  it('blocked: UNCONFIGURED alone', () => {
    expect(isPackagePublishEligible({ configurationStatus: 'UNCONFIGURED', publishStatus: null })).toBe(false)
  })

  it('blocked: HIDDEN even when CONFIGURED', () => {
    expect(isPackagePublishEligible({ configurationStatus: 'CONFIGURED', publishStatus: 'HIDDEN' })).toBe(false)
  })

  it('blocked: ARCHIVED even when CONFIGURED', () => {
    expect(isPackagePublishEligible({ configurationStatus: 'CONFIGURED', publishStatus: 'ARCHIVED' })).toBe(false)
  })

  it('blocked: DRAFT + UNCONFIGURED', () => {
    expect(isPackagePublishEligible({ configurationStatus: 'UNCONFIGURED', publishStatus: 'DRAFT' })).toBe(false)
  })

  it('blocked: unknown/future status', () => {
    expect(isPackagePublishEligible({ configurationStatus: 'SYNCING', publishStatus: 'DRAFT' })).toBe(false)
    expect(isPackagePublishEligible({ configurationStatus: null, publishStatus: null })).toBe(false)
  })

  it('provider-neutral: same result regardless of provider code', () => {
    // The helper has no provider input — prove no provider coupling exists.
    expect(isPackagePublishEligible({ configurationStatus: 'CONFIGURED' })).toBe(true)
    expect(isPackagePublishEligible({ configurationStatus: 'UNCONFIGURED' })).toBe(false)
  })
})

describe('getPublishIneligibilityReasons', () => {
  it('returns structured HIDDEN reason', () => {
    expect(getPublishIneligibilityReasons({ configurationStatus: 'CONFIGURED', publishStatus: 'HIDDEN' }))
      .toEqual(['publishStatus is HIDDEN (restore/unarchive before publishing)'])
  })

  it('returns structured ARCHIVED reason', () => {
    expect(getPublishIneligibilityReasons({ configurationStatus: 'CONFIGURED', publishStatus: 'ARCHIVED' }))
      .toEqual(['publishStatus is ARCHIVED (restore/unarchive before publishing)'])
  })

  it('returns structured UNCONFIGURED reason', () => {
    expect(getPublishIneligibilityReasons({ configurationStatus: 'UNCONFIGURED', publishStatus: 'DRAFT' }))
      .toEqual(['configurationStatus is UNCONFIGURED (never eligible to publish)'])
  })

  it('falls back to the standard message for other ineligible states', () => {
    expect(getPublishIneligibilityReasons({ configurationStatus: 'SYNCING', publishStatus: 'DRAFT' }))
      .toEqual([PUBLISH_INELIGIBLE_MESSAGE])
  })
})
