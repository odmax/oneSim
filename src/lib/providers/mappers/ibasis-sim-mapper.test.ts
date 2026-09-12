import { describe, it, expect } from 'vitest'
import {
  normalizeSimStatus,
  mapIbasisSim,
  maskActivationCode,
  maskIccid,
  activationCodeFingerprint,
  computeSimComparableKey,
} from './ibasis-sim-mapper'

describe('normalizeSimStatus', () => {
  it('maps inventory statuses to app-level statuses', () => {
    expect(normalizeSimStatus('Inventory')).toBe('NOT_SENT')
    expect(normalizeSimStatus('inventory')).toBe('NOT_SENT')
    expect(normalizeSimStatus('Activation pending')).toBe('PENDING')
    expect(normalizeSimStatus('pending')).toBe('PENDING')
    expect(normalizeSimStatus('Active')).toBe('ACTIVE')
    expect(normalizeSimStatus('Suspended')).toBe('SUSPENDED')
    expect(normalizeSimStatus('Deactivated')).toBe('EXPIRED')
    expect(normalizeSimStatus('inactive')).toBe('INACTIVE')
    expect(normalizeSimStatus('Retired')).toBe('RETIRED')
    expect(normalizeSimStatus('cancelled')).toBe('RETIRED')
    expect(normalizeSimStatus('Expired')).toBe('EXPIRED')
  })

  it('aligns deactivated with the subscription lifecycle terminal meaning (never INACTIVE)', () => {
    // `deactivated` on the iBASIS inventory SIM is the SAME lifecycle concept
    // as `deactivated` on the subscription object — a permanently ended
    // subscription (distinct from the reversible `suspended`). Both iBASIS
    // mappers must therefore normalize it to the canonical terminal EXPIRED,
    // never to the non-canonical INACTIVE lifecycle value.
    expect(normalizeSimStatus('deactivated')).toBe('EXPIRED')
    expect(normalizeSimStatus('Deactivated')).toBe('EXPIRED')
    expect(normalizeSimStatus('DEACTIVATED')).toBe('EXPIRED')
    expect(normalizeSimStatus('deactivated')).not.toBe('INACTIVE')
    expect(normalizeSimStatus('deactivated')).not.toBe('PENDING_ACTIVATION')
  })

  it('keeps the distinct inventory-only inactive token on the INACTIVE label', () => {
    // `inactive` stays an inventory-level availability label — never a
    // canonical lifecycle terminal from an ambiguous inventory token.
    expect(normalizeSimStatus('inactive')).toBe('INACTIVE')
    expect(normalizeSimStatus('Inactive')).toBe('INACTIVE')
  })

  it('is case-insensitive and trims whitespace', () => {
    expect(normalizeSimStatus('  ACTIVE  ')).toBe('ACTIVE')
  })

  it('returns UNKNOWN for unrecognized or missing statuses', () => {
    expect(normalizeSimStatus('mystery-status')).toBe('UNKNOWN')
    expect(normalizeSimStatus(null)).toBe('UNKNOWN')
    expect(normalizeSimStatus(undefined)).toBe('UNKNOWN')
    expect(normalizeSimStatus('')).toBe('UNKNOWN')
  })
})

describe('mapIbasisSim', () => {
  it('maps a full SIM payload', () => {
    const mapped = mapIbasisSim({
      iccid: '89975111967191511974',
      type: 'esim',
      carrier: 'AT&T',
      status: 'Inventory',
      activation_code: 'FKE: 0$CUST-111-V4-FAKE-ATL2.GDSB.NET$555',
    })
    expect(mapped.iccid).toBe('89975111967191511974')
    expect(mapped.simType).toBe('esim')
    expect(mapped.carrier).toBe('AT&T')
    expect(mapped.providerStatus).toBe('Inventory')
    expect(mapped.normalizedStatus).toBe('NOT_SENT')
    expect(mapped.activationCode).toContain('GDSB.NET')
    expect(mapped.rawData.iccid).toBe('89975111967191511974')
  })

  it('handles missing optional fields', () => {
    const mapped = mapIbasisSim({ iccid: '89000000000000000000', type: 'esim' })
    expect(mapped.carrier).toBeNull()
    expect(mapped.activationCode).toBeNull()
    expect(mapped.providerStatus).toBe('UNKNOWN')
    expect(mapped.normalizedStatus).toBe('UNKNOWN')
    expect(mapped.simType).toBe('esim')
  })

  it('handles a completely empty SIM', () => {
    const mapped = mapIbasisSim({})
    expect(mapped.iccid).toBe('')
    expect(mapped.simType).toBe('unknown')
  })
})

describe('masking helpers', () => {
  it('masks activation codes', () => {
    const masked = maskActivationCode('FKE: 0$CUST-111-V4-FAKE-ATL2.GDSB.NET$555')
    expect(masked).not.toContain('GDSB.NET')
    expect(masked).toContain('••••')
  })

  it('returns empty for missing activation codes', () => {
    expect(maskActivationCode(null)).toBe('')
    expect(maskActivationCode('')).toBe('')
  })

  it('masks short codes entirely', () => {
    expect(maskActivationCode('abc123')).toBe('••••')
  })

  it('masks ICCIDs', () => {
    const masked = maskIccid('89975111967191511974')
    expect(masked).not.toContain('89975111967191511974')
    expect(masked).toContain('••••')
    expect(maskIccid(null)).toBe('')
  })

  it('produces stable fingerprints and never includes the raw code', () => {
    const code = 'FKE: 0$CUST-111-V4-FAKE-ATL2.GDSB.NET$555'
    const fp1 = activationCodeFingerprint(code)
    const fp2 = activationCodeFingerprint(code)
    expect(fp1).toBe(fp2)
    expect(fp1).not.toContain('GDSB.NET')
    expect(activationCodeFingerprint(null)).toBe('')
  })
})

describe('computeSimComparableKey', () => {
  it('builds a stable comparable key', () => {
    expect(computeSimComparableKey('89975111967191511974')).toBe('sim:iccid:89975111967191511974')
  })
})
