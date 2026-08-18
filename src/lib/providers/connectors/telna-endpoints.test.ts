import { describe, it, expect } from 'vitest'
import {
  TELNA_ENDPOINTS,
  telnaEndpointAuthFamily,
  isTelnaEndpointProven,
  type TelnaEndpoint,
} from './telna-endpoints'

describe('TELNA endpoint map — Phase 1F reconciliation invariants', () => {
  it('every endpoint key has a concrete auth family (total metadata, compile-time-safe)', () => {
    const keys = Object.keys(TELNA_ENDPOINTS) as TelnaEndpoint[]
    for (const key of keys) {
      const family = telnaEndpointAuthFamily(key)
      expect(family, `endpoint ${key} must have an auth family`).toBeTruthy()
    }
  })

  it('no duplicate bare package/template/sim-registry paths remain', () => {
    const paths = Object.values(TELNA_ENDPOINTS)
    for (const p of ['/packages', '/package-templates', '/sim-registries']) {
      // Exact bare matches only (a documented prefix like /pcr/packages is fine).
      expect(paths.filter(x => x === p).length, `bare path ${p} must not exist`).toBe(0)
    }
  })

  it('exactly one canonical key per documented operation (no V2 aliases)', () => {
    const keys = Object.keys(TELNA_ENDPOINTS) as TelnaEndpoint[]
    for (const k of keys) {
      expect(k.endsWith('V2'), `duplicate V2 alias ${k} should not exist`).toBe(false)
    }
  })

  it('documented PCR/Inventory/RSP/Session families are correct', () => {
    expect(telnaEndpointAuthFamily('packages')).toBe('PCR') // /pcr/packages
    expect(telnaEndpointAuthFamily('package')).toBe('PCR') // /pcr/packages/{id}
    expect(telnaEndpointAuthFamily('packageTemplates')).toBe('PCR')
    expect(telnaEndpointAuthFamily('packageTemplate')).toBe('PCR')
    expect(telnaEndpointAuthFamily('simRegistries')).toBe('INVENTORY') // /inventory/sim-registries
    expect(telnaEndpointAuthFamily('simRegistry')).toBe('INVENTORY')
    expect(telnaEndpointAuthFamily('euiccProfile')).toBe('ESIM_RSP') // /euicc-profiles/{iccid}
    expect(telnaEndpointAuthFamily('openDataSessions')).toBe('SESSION') // /open-data-sessions
    expect(telnaEndpointAuthFamily('countries')).toBe('CORE')
  })

  it('every currently-declared endpoint is proven (no UNVERIFIED runtime-blocked endpoint)', () => {
    const keys = Object.keys(TELNA_ENDPOINTS) as TelnaEndpoint[]
    for (const key of keys) {
      expect(isTelnaEndpointProven(key), `endpoint ${key} must be proven`).toBe(true)
    }
  })

  it('future endpoints added to the map require an auth family (Record totality is enforced by the type layer)', () => {
    // The map is typed `Record<TelnaEndpoint, TelnaAuthFamily>`, so adding a key
    // to TELNA_ENDPOINTS without a family fails to compile. This test documents
    // the invariant and the canonical purchase path.
    expect(TELNA_ENDPOINTS.packages).toBe('/pcr/packages')
  })
})
