import { describe, it, expect } from 'vitest'
import {
  TELNA_ENDPOINTS,
  telnaEndpointMethod,
  telnaEndpointAuthFamily,
  telnaEndpointMutation,
  telnaEndpointEntitlement,
  telnaEndpointOperationType,
  telnaEndpointOneSimExposure,
  telnaEndpointPath,
  isTelnaEndpointProven,
  buildTelnaEndpointUrl,
  type TelnaEndpoint,
} from './telna-endpoints'

const ENDPOINT_KEYS = Object.keys(TELNA_ENDPOINTS) as TelnaEndpoint[]

const KNOWN_MODULES = new Set(['CORE', 'INVENTORY', 'PCR', 'USAGE', 'ESIM_RSP', 'SESSION', 'SMS'])
const KNOWN_ENTITLEMENTS = new Set([
  'STANDARD',
  'ACCOUNT_GATED',
  'PAID_ADDON',
  'NOT_STANDARD',
  'DANGEROUS',
  'COMING_SOON',
])
const KNOWN_OPERATIONS = new Set(['READ', 'MUTATION'])
const KNOWN_EXPOSURES = new Set(['USED', 'IMPLEMENTED_NOT_EXPOSED', 'MAPPED_ONLY', 'DISABLED'])

describe('Telna endpoint registry — V2.1 vendor-contract totality', () => {
  it('every endpoint key has a concrete, complete metadata definition', () => {
    expect(ENDPOINT_KEYS.length).toBeGreaterThan(0)
    for (const key of ENDPOINT_KEYS) {
      const def = TELNA_ENDPOINTS[key]
      expect(def, `endpoint ${key} missing definition`).toBeTruthy()
      expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).toContain(def.method)
      expect(def.path).toMatch(/^\/v2\.1\//)
      expect(def.auth).toBeTruthy()
      expect(KNOWN_MODULES.has(def.module), `endpoint ${key} unknown module ${def.module}`).toBe(true)
      expect(KNOWN_ENTITLEMENTS.has(def.entitlement), `endpoint ${key} unknown entitlement ${def.entitlement}`).toBe(true)
      expect(KNOWN_OPERATIONS.has(telnaEndpointOperationType(key)), `endpoint ${key} must derive a valid operation type`).toBe(true)
      expect(KNOWN_EXPOSURES.has(telnaEndpointOneSimExposure(key)), `endpoint ${key} unknown exposure ${telnaEndpointOneSimExposure(key)}`).toBe(true)
      expect(telnaEndpointOperationType(key)).toBe(def.mutation ? 'MUTATION' : 'READ')
      expect(typeof def.mutation).toBe('boolean')
      expect(def.use).toBeTruthy()
    }
  })

  it('every key is unique', () => {
    expect(new Set(ENDPOINT_KEYS).size).toBe(ENDPOINT_KEYS.length)
  })

  it('no path starts outside /v2.1/ and none double the /v2.1 prefix', () => {
    for (const key of ENDPOINT_KEYS) {
      const p = TELNA_ENDPOINTS[key].path
      expect(p.startsWith('/v2.1/'), `path ${p} must start with /v2.1/`).toBe(true)
      expect(p.includes('/v2.1/v2.1'), `path ${p} must not double /v2.1`).toBe(false)
    }
  })

  it('no PPO/Flex paths and no TELNA_SEAMLESS paths exist in the registry', () => {
    const raw = JSON.stringify(TELNA_ENDPOINTS).toLowerCase()
    expect(raw.includes('ppo-api') || raw.includes('/ppo') || raw.includes('ppo.')).toBe(false)
    expect(raw.includes('seamless')).toBe(false)
    // No host/absolute URLs — paths are all relative (host lives on provider config).
    expect(raw.includes('http://') || raw.includes('https://')).toBe(false)
  })

  it('no unversioned bare paths remain', () => {
    const bare = ['/v2.1/packages', '/v2.1/package-templates', '/v2.1/sim-registries', '/v2.1/euicc-profiles', '/v2.1/open-data-sessions']
    const paths = ENDPOINT_KEYS.map(k => TELNA_ENDPOINTS[k].path)
    for (const p of bare) expect(paths.includes(p), `bare path ${p} must not exist`).toBe(false)
  })

  it('no duplicate semantic operation: same (path, method) maps to at most one key', () => {
    const seen = new Map<string, string>()
    for (const key of ENDPOINT_KEYS) {
      const d = TELNA_ENDPOINTS[key]
      const sig = `${d.method} ${d.path}`
      const existing = seen.get(sig)
      expect(existing, `duplicate semantic operation ${sig} (${existing} and ${key})`).toBeUndefined()
      seen.set(sig, key)
    }
  })

  it('auth family, method and mutation derive from the central registry', () => {
    for (const key of ENDPOINT_KEYS) {
      expect(telnaEndpointAuthFamily(key)).toBe(TELNA_ENDPOINTS[key].auth)
      expect(telnaEndpointMethod(key)).toBe(TELNA_ENDPOINTS[key].method)
      expect(telnaEndpointMutation(key)).toBe(TELNA_ENDPOINTS[key].mutation)
      expect(telnaEndpointPath(key)).toBe(TELNA_ENDPOINTS[key].path)
    }
  })

  it('every non-purchase mutation carries entitlement NOT plainly usable (never silently enabled)', () => {
    // Purchase (POST /packages) is the one policy-gated STANDARD mutation.
    const usableMutations = new Set(['packageCreate'])
    for (const key of ENDPOINT_KEYS) {
      if (TELNA_ENDPOINTS[key].mutation && !usableMutations.has(key)) {
        expect(TELNA_ENDPOINTS[key].entitlement, `non-purchase mutation ${key} must be gated`).not.toBe('STANDARD')
      }
    }
  })

  it('all STANDARD read endpoints are proven (auth !== UNVERIFIED)', () => {
    for (const key of ENDPOINT_KEYS) {
      const d = TELNA_ENDPOINTS[key]
      if (d.entitlement === 'STANDARD' && !d.mutation) {
        expect(isTelnaEndpointProven(key), `read endpoint ${key} must be proven`).toBe(true)
      }
    }
  })

  it('UNVERIFIED-auth endpoints are never proven (never called)', () => {
    for (const key of ENDPOINT_KEYS) {
      if (TELNA_ENDPOINTS[key].auth === 'UNVERIFIED') {
        expect(isTelnaEndpointProven(key)).toBe(false)
      }
    }
  })

  it('path placeholders resolve correctly and never leave a {param} unresolvable for known calls', () => {
    const sampler: Record<string, Record<string, string | number>> = {
      company: { company_id: 42 },
      companyUpdate: { company_id: 42 },
      inventory: { inventory_id: 7 },
      inventoryUpdate: { inventory_id: 7 },
      simRegistry: { iccid: '89441000000000000000' },
      simRegistryPurge: { iccid: '89441000000000000000' },
      packageTemplate: { package_template_id: 100 },
      packageTemplateUpdate: { package_template_id: 100 },
      package: { package_id: 200 },
      packageUpdate: { package_id: 200 },
      simPCRProfile: { iccid: '89441000000000000000' },
      simPCRProfileUpdate: { iccid: '89441000000000000000' },
      wallet: { wallet_id: 5 },
      walletUpdate: { wallet_id: 5 },
      trafficPolicy: { traffic_policy_id: 9 },
      euiccProfile: { iccid: '89441000000000000000' },
    }
    for (const [key, params] of Object.entries(sampler)) {
      const url = buildTelnaEndpointUrl('https://developer-api.telna.com', key as TelnaEndpoint, params)
      expect(url.startsWith('https://developer-api.telna.com/v2.1/')).toBe(true)
      expect(url.includes('{'), `url ${url} still has an unresolvable placeholder`).toBe(false)
    }
  })

  it('buildTelnaEndpointUrl never doubles the base path and tolerates trailing slashes', () => {
    expect(buildTelnaEndpointUrl('https://developer-api.telna.com', 'countries')).toBe('https://developer-api.telna.com/v2.1/core/countries')
    expect(buildTelnaEndpointUrl('https://developer-api.telna.com/', 'countries')).toBe('https://developer-api.telna.com/v2.1/core/countries')
    expect(buildTelnaEndpointUrl('https://developer-api.telna.com///', 'countries')).toBe('https://developer-api.telna.com/v2.1/core/countries')
  })

  it('documents expected canonical sentinel paths', () => {
    expect(TELNA_ENDPOINTS.packages.path).toBe('/v2.1/pcr/packages')
    expect(TELNA_ENDPOINTS.package.path).toBe('/v2.1/pcr/packages/{package_id}')
    expect(TELNA_ENDPOINTS.packageTemplates.path).toBe('/v2.1/pcr/package-templates')
    expect(TELNA_ENDPOINTS.packageTemplateCreate.path).toBe('/v2.1/pcr/package-templates')
    expect(TELNA_ENDPOINTS.simRegistries.path).toBe('/v2.1/inventory/sim-registries')
    expect(TELNA_ENDPOINTS.euiccProfile.path).toBe('/v2.1/esim-rsp/euicc-profiles/{iccid}')
    expect(TELNA_ENDPOINTS.openDataSessions.path).toBe('/v2.1/session-management/open-data-sessions')
    expect(TELNA_ENDPOINTS.countries.path).toBe('/v2.1/core/countries')
    expect(TELNA_ENDPOINTS.routePolicies.path).toBe('/v2.1/pcr/route-policies')
  })

  it('documents key HTTP methods from the registry (single source of truth)', () => {
    expect(telnaEndpointMethod('countries')).toBe('GET')
    expect(telnaEndpointMethod('companiesCreate')).toBe('POST')
    expect(telnaEndpointMethod('companyUpdate')).toBe('PUT')
    expect(telnaEndpointMethod('packageTemplateCreate')).toBe('POST')
    expect(telnaEndpointMethod('packageCreate')).toBe('POST')
    expect(telnaEndpointMethod('packageUpdate')).toBe('PUT')
    expect(telnaEndpointMethod('simPCRProfileUpdate')).toBe('PUT')
    expect(telnaEndpointMethod('walletUpdate')).toBe('PATCH')
    expect(telnaEndpointMethod('simRegistryPurge')).toBe('DELETE')
  })

  it('distinguishes template creation POST from package-instance creation POST', () => {
    const tpl = TELNA_ENDPOINTS.packageTemplateCreate
    const pkg = TELNA_ENDPOINTS.packageCreate
    expect(tpl.path).toBe('/v2.1/pcr/package-templates')
    expect(pkg.path).toBe('/v2.1/pcr/packages')
    expect(tpl.use.toLowerCase()).toContain('offering')
    expect(pkg.use.toLowerCase()).toContain('instance')
    expect(pkg.entitlement).toBe('STANDARD')
    expect(tpl.entitlement).toBe('ACCOUNT_GATED')
  })

  it('paid add-on and excluded endpoints are correctly classified (never STANDARD)', () => {
    expect(TELNA_ENDPOINTS.openDataSessions.entitlement).toBe('PAID_ADDON')
    expect(TELNA_ENDPOINTS.openDataSessions.exposure).toBe('DISABLED')
    expect(TELNA_ENDPOINTS.smsSend.entitlement).toBe('PAID_ADDON')
    expect(TELNA_ENDPOINTS.smsSend.exposure).toBe('DISABLED')
    expect(TELNA_ENDPOINTS.companiesCreate.entitlement).toBe('NOT_STANDARD')
    expect(TELNA_ENDPOINTS.companiesCreate.exposure).toBe('MAPPED_ONLY')
    expect(TELNA_ENDPOINTS.companyUpdate.entitlement).toBe('NOT_STANDARD')
    expect(TELNA_ENDPOINTS.inventoryCreate.entitlement).toBe('NOT_STANDARD')
    expect(TELNA_ENDPOINTS.inventoryUpdate.entitlement).toBe('NOT_STANDARD')
    expect(TELNA_ENDPOINTS.simRegistryPurge.entitlement).toBe('DANGEROUS')
    expect(TELNA_ENDPOINTS.simRegistryPurge.exposure).toBe('DISABLED')
    expect(TELNA_ENDPOINTS.packageUpdate.exposure).toBe('IMPLEMENTED_NOT_EXPOSED')
    expect(TELNA_ENDPOINTS.walletUpdate.exposure).toBe('IMPLEMENTED_NOT_EXPOSED')
  })
})
