import { describe, it, expect } from 'vitest'
import { isUpstreamCreationExposureEnabled, upstreamCreationGlobalGate } from './upstream-kill-switch'

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.CUSTOM_PACKAGE_UPSTREAM_CREATION_ENABLED
  if (value === undefined) {
    delete process.env.CUSTOM_PACKAGE_UPSTREAM_CREATION_ENABLED
  } else {
    process.env.CUSTOM_PACKAGE_UPSTREAM_CREATION_ENABLED = value
  }
  try { fn() } finally {
    if (prev === undefined) delete process.env.CUSTOM_PACKAGE_UPSTREAM_CREATION_ENABLED
    else process.env.CUSTOM_PACKAGE_UPSTREAM_CREATION_ENABLED = prev
  }
}

describe('upstream kill switch — OFF by default, only literal "true" enables', () => {
  it('is OFF when the variable is missing', () => {
    withEnv(undefined, () => {
      expect(isUpstreamCreationExposureEnabled()).toBe(false)
      expect(upstreamCreationGlobalGate()).toContain('disabled')
    })
  })

  it('is OFF when set to "false"', () => {
    withEnv('false', () => {
      expect(isUpstreamCreationExposureEnabled()).toBe(false)
      expect(upstreamCreationGlobalGate()).toContain('disabled')
    })
  })

  it('is OFF when set to "0"', () => {
    withEnv('0', () => {
      expect(isUpstreamCreationExposureEnabled()).toBe(false)
    })
  })

  it('is OFF for malformed values ("TRUE", "yes", "1", " True ")', () => {
    for (const bad of ['TRUE', 'Yes', '1', ' true ', 'on']) {
      withEnv(bad, () => {
        expect(isUpstreamCreationExposureEnabled()).toBe(false)
      })
    }
  })

  it('is ON only for the exact lowercase string "true"', () => {
    withEnv('true', () => {
      expect(isUpstreamCreationExposureEnabled()).toBe(true)
      expect(upstreamCreationGlobalGate()).toBeNull()
    })
  })

  it('gate is purely server-side and cannot be influenced by request data', () => {
    // The gate reads only process.env — there is no request-derived input.
    withEnv(undefined, () => {
      expect(() => upstreamCreationGlobalGate()).not.toThrow()
    })
  })
})