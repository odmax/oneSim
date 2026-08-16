import { describe, it, expect } from 'vitest'
import { getSafeProviderResponseForDisplay, maskIdentifier } from './provider-response-display'

describe('getSafeProviderResponseForDisplay (admin whitelist + masking)', () => {
  it('renders safe evidence keys and masks provider identifiers', () => {
    const safe = getSafeProviderResponseForDisplay({
      source: 'esims/location-event-logs',
      networkAttached: true,
      networkType: '4G LTE',
      servingNetwork: '65501',
      countryNetwork: 'South Africa-Vodacom',
      observedAt: '2026-08-16T09:08:42Z',
      reason: 'diameter-success-attach',
      providerEsimId: 'esim-uuid-1234567890abcdef',
      packageEsimId: 'assoc-uuid-abcdef123456',
    })
    expect(safe).toMatchObject({
      source: 'esims/location-event-logs',
      networkAttached: true,
      networkType: '4G LTE',
      servingNetwork: '65501',
      countryNetwork: 'South Africa-Vodacom',
      observedAt: '2026-08-16T09:08:42Z',
      reason: 'diameter-success-attach',
    })
    // Provider identifiers are MASKED, never rendered in full.
    expect(safe.providerEsimId).toBe('esim••••cdef')
    expect(safe.packageEsimId).toBe('asso••••3456')
    expect(safe.providerEsimId).not.toContain('1234567890abcdef')
  })

  it('BLOCKS secret-shaped keys at the top level', () => {
    const safe = getSafeProviderResponseForDisplay({
      token: 'jwt-secret',
      password: 'p4ss',
      authorization: 'Bearer x',
      activationCode: 'LPA:1$smdp$code',
      qrcodeString: 'LPA:1$smdp$code',
      qrCode: 'LPA:1$smdp$code',
      lpaValue: 'LPA:1$smdp$code',
      PIN: '1234',
      PUK: '567890',
      ADM: '9999',
      iccid: '8944501234567890123',
      imsi: '655010000000001',
      eid: '8904305000000000001',
      providerEsimId: 'esim-uuid-1',
    })
    expect(safe).toEqual({ providerEsimId: 'esim••••id-1' })
    expect(JSON.stringify(safe)).not.toContain('jwt-secret')
    expect(JSON.stringify(safe)).not.toContain('LPA:')
    expect(JSON.stringify(safe)).not.toContain('p4ss')
    expect(JSON.stringify(safe)).not.toContain('8944501234567890123')
  })

  it('recursively drops secret-shaped keys inside allowed nested values', () => {
    const safe = getSafeProviderResponseForDisplay({
      evidence: { networkAttached: true, activationCode: 'SECRET', token: 't' },
      profileLogStates: ['ENABLED', 'INSTALLED'],
      nested: { shouldBeDropped: true },
    })
    expect(safe.evidence).toEqual({ networkAttached: true })
    expect(safe.profileLogStates).toEqual(['ENABLED', 'INSTALLED'])
    expect(safe).not.toHaveProperty('nested')
    expect(JSON.stringify(safe)).not.toContain('SECRET')
  })

  it('returns {} for null / non-object input', () => {
    expect(getSafeProviderResponseForDisplay(null)).toEqual({})
    expect(getSafeProviderResponseForDisplay(undefined)).toEqual({})
    expect(getSafeProviderResponseForDisplay('raw')).toEqual({})
    expect(getSafeProviderResponseForDisplay([1, 2])).toEqual({})
  })

  it('returns {} when only non-whitelisted keys exist', () => {
    expect(getSafeProviderResponseForDisplay({ someFutureKey: 'x', another: 1 })).toEqual({})
  })
})

describe('maskIdentifier', () => {
  it('masks short and long identifiers', () => {
    expect(maskIdentifier('assoc-uuid-abcdef123456')).toBe('asso••••3456')
    expect(maskIdentifier('short')).toBe('••••')
    expect(maskIdentifier(null)).toBe('')
    expect(maskIdentifier(undefined)).toBe('')
    expect(maskIdentifier('')).toBe('')
  })
})
