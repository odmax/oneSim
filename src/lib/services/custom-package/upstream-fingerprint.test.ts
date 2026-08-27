import { describe, it, expect } from 'vitest'
import { computeUpstreamFingerprint, canonicalizeUpstreamRequest, type FingerprintSource } from './upstream-fingerprint'

function base(overrides: Partial<FingerprintSource> = {}): FingerprintSource {
  return {
    providerId: 'prov-choice',
    sku: 'TZN-5GB-7D',
    bundleName: 'Tanzania 5GB',
    dataGB: 5,
    validityDays: 7,
    allowQtyp: 'GB',
    pool: 1,
    allowThrottle: false,
    allowTethering: false,
    ...overrides,
  }
}

describe('computeUpstreamFingerprint', () => {
  it('is stable for the same canonical request', () => {
    const a = computeUpstreamFingerprint(base())
    const b = computeUpstreamFingerprint(base())
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('differs when the SKU changes', () => {
    expect(computeUpstreamFingerprint(base({ sku: 'A' }))).not.toBe(computeUpstreamFingerprint(base({ sku: 'B' })))
  })

  it('differs when data allowance changes', () => {
    expect(computeUpstreamFingerprint(base({ dataGB: 5 }))).not.toBe(computeUpstreamFingerprint(base({ dataGB: 10 })))
  })

  it('differs when validity changes', () => {
    expect(computeUpstreamFingerprint(base({ validityDays: 7 }))).not.toBe(computeUpstreamFingerprint(base({ validityDays: 30 })))
  })

  it('ignores UI-only noise (whitespace in name), but not structural semantic differences', () => {
    const a = computeUpstreamFingerprint(base({ bundleName: ' Tanzania   5GB ' }))
    const b = computeUpstreamFingerprint(base({ bundleName: 'Tanzania 5GB' }))
    expect(a).toBe(b)
  })

  it('floating 5 vs 5.0 normalize the same', () => {
    expect(computeUpstreamFingerprint(base({ dataGB: 5, pool: 1 })))
      .toBe(computeUpstreamFingerprint(base({ dataGB: 5, pool: 1.0 })))
  })

  it('canonicalization sorts object keys', () => {
    const json = canonicalizeUpstreamRequest({ ...base(), additional: { z: 1, a: 2 } })
    expect(json.indexOf('"a"')).toBeLessThan(json.indexOf('"z"'))
  })

  it('excludes timestamps/sessions/admin names (not part of fingerprint input)', () => {
    // The fingerprint API has no timestamp/session fields at all — ensure the
    // canonical payload never contains them.
    const json = canonicalizeUpstreamRequest(base())
    expect(json.toLowerCase()).not.toContain('timestamp')
    expect(json.toLowerCase()).not.toContain('token')
    expect(json.toLowerCase()).not.toContain('password')
  })
})