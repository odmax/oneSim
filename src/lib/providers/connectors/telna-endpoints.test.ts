import { describe, it, expect } from 'vitest'
import {
  TELNA_ENDPOINTS,
  telnaEndpointAuthFamily,
  isTelnaEndpointProven,
  type TelnaEndpoint,
} from './telna-endpoints'

describe('TELNA endpoint map — V2.1 vendor-contract invariants', () => {
  it('every endpoint key has a concrete auth family (total metadata, compile-time-safe)', () => {
    const keys = Object.keys(TELNA_ENDPOINTS) as TelnaEndpoint[]
    for (const key of keys) {
      const family = telnaEndpointAuthFamily(key)
      expect(family, `endpoint ${key} must have an auth family`).toBeTruthy()
    }
  })

  it('every endpoint path carries the /v2.1 module prefix and never doubles it', () => {
    const paths = Object.values(TELNA_ENDPOINTS)
    for (const p of paths) {
      expect(p.startsWith('/v2.1/'), `path ${p} must start with /v2.1/`).toBe(true)
      expect(p.includes('/v2.1/v2.1'), `path ${p} must not double the /v2.1 prefix`).toBe(false)
    }
  })

  it('no unversioned bare paths remain', () => {
    const paths = Object.values(TELNA_ENDPOINTS)
    for (const p of ['/v2.1/packages', '/v2.1/package-templates', '/v2.1/sim-registries', '/v2.1/euicc-profiles', '/v2.1/open-data-sessions']) {
      expect(paths.some(x => x === p), `unversioned/bare path ${p} must not exist`).toBe(false)
    }
  })

  it('exactly one canonical key per documented operation (no V2 aliases)', () => {
    const keys = Object.keys(TELNA_ENDPOINTS) as TelnaEndpoint[]
    for (const k of keys) {
      expect(k.endsWith('V2'), `duplicate V2 alias ${k} should not exist`).toBe(false)
    }
  })

  it('documented V2.1 module paths are exact', () => {
    expect(TELNA_ENDPOINTS.packages).toBe('/v2.1/pcr/packages')
    expect(TELNA_ENDPOINTS.package).toBe('/v2.1/pcr/packages/{package_id}')
    expect(TELNA_ENDPOINTS.packageTemplates).toBe('/v2.1/pcr/package-templates')
    expect(TELNA_ENDPOINTS.packageTemplate).toBe('/v2.1/pcr/package-templates/{package_template_id}')
    expect(TELNA_ENDPOINTS.simRegistries).toBe('/v2.1/inventory/sim-registries')
    expect(TELNA_ENDPOINTS.simRegistry).toBe('/v2.1/inventory/sim-registries/{iccid}')
    expect(TELNA_ENDPOINTS.euiccProfile).toBe('/v2.1/esim-rsp/euicc-profiles/{iccid}')
    expect(TELNA_ENDPOINTS.openDataSessions).toBe('/v2.1/session-management/open-data-sessions')
    expect(TELNA_ENDPOINTS.countries).toBe('/v2.1/core/countries')
  })

  it('documented families are correct', () => {
    expect(telnaEndpointAuthFamily('packages')).toBe('PCR')
    expect(telnaEndpointAuthFamily('package')).toBe('PCR')
    expect(telnaEndpointAuthFamily('packageTemplates')).toBe('PCR')
    expect(telnaEndpointAuthFamily('packageTemplate')).toBe('PCR')
    expect(telnaEndpointAuthFamily('simRegistries')).toBe('INVENTORY')
    expect(telnaEndpointAuthFamily('simRegistry')).toBe('INVENTORY')
    expect(telnaEndpointAuthFamily('euiccProfile')).toBe('ESIM_RSP')
    expect(telnaEndpointAuthFamily('openDataSessions')).toBe('SESSION')
    expect(telnaEndpointAuthFamily('countries')).toBe('CORE')
  })

  it('every currently-declared endpoint is proven', () => {
    const keys = Object.keys(TELNA_ENDPOINTS) as TelnaEndpoint[]
    for (const key of keys) {
      expect(isTelnaEndpointProven(key), `endpoint ${key} must be proven`).toBe(true)
    }
  })

  it('future endpoints added to the map require an auth family (Record totality)', () => {
    // The map is typed `Record<TelnaEndpoint, TelnaAuthFamily>`, so adding a key
    // to TELNA_ENDPOINTS without a family fails to compile.
    expect(TELNA_ENDPOINTS.packages).toBe('/v2.1/pcr/packages')
  })
})
