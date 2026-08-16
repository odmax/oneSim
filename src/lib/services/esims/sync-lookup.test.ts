import { describe, it, expect } from 'vitest'
import { resolveStatusLookup, resolveUsageLookup, capabilitySupported, toEsimProviderIdentity } from './sync-lookup'
import type { IProviderConnector, ConnectorCapabilities } from '@/lib/providers/connectors/connector-interface'

function makeConnector(overrides: Partial<IProviderConnector> = {}): IProviderConnector {
  return {
    providerId: 'p-1',
    name: 'Test',
    capabilities: { statusLookup: true, usageLookup: true } as ConnectorCapabilities,
    ...overrides,
  } as any
}

function makeEsim(overrides: any = {}) {
  return {
    iccid: '89012345678901234567',
    imsi: null,
    imsiVersion: null,
    providerActivationId: null,
    providerSubscriptionId: null,
    providerSubscriberId: null,
    status: 'PENDING_ACTIVATION',
    ...overrides,
  }
}

describe('resolveStatusLookup (canonical)', () => {
  it('uses connector.resolveStatusLookup when implemented (CHOICE structured object)', () => {
    const connector = makeConnector({
      resolveStatusLookup: (esim: any) => ({ iccid: esim.iccid, currentStatus: esim.status }),
    })
    const r = resolveStatusLookup(connector, makeEsim())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.identifier).toEqual({ iccid: '89012345678901234567', currentStatus: 'PENDING_ACTIVATION' })
    }
  })

  it('falls back safely to providerSubscriptionId → activationId → subscriberId → iccid', () => {
    const r1 = resolveStatusLookup(makeConnector(), makeEsim({ providerSubscriptionId: 'sub-1', iccid: 'X' }))
    expect(r1.ok && (r1 as any).identifier).toBe('sub-1')
    const r2 = resolveStatusLookup(makeConnector(), makeEsim({ providerActivationId: 'act-1', iccid: 'X' }))
    expect(r2.ok && (r2 as any).identifier).toBe('act-1')
    const r3 = resolveStatusLookup(makeConnector(), makeEsim({ providerSubscriberId: 'c-1', iccid: 'X' }))
    expect(r3.ok && (r3 as any).identifier).toBe('c-1')
    const r4 = resolveStatusLookup(makeConnector(), makeEsim({ iccid: '89012345678901234567' }))
    expect(r4.ok && (r4 as any).identifier).toBe('89012345678901234567')
  })

  it('returns IDENTIFIER_MISSING (never sends a local id) when nothing safe exists', () => {
    const r = resolveStatusLookup(makeConnector(), makeEsim({ iccid: null, providerSubscriptionId: null, providerActivationId: null, providerSubscriberId: null }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.skipReason).toBe('IDENTIFIER_MISSING')
  })

  it('never selects a local esim.id or providerPlanId', () => {
    const connector = makeConnector()
    const r = resolveStatusLookup(connector, makeEsim({ providerSubscriptionId: null, providerActivationId: null, providerSubscriberId: null, iccid: null }))
    expect(r.ok).toBe(false)
    // If only a local id existed in the bundle, it would be absent → IDENTIFIER_MISSING.
    expect((toEsimProviderIdentity as any)(makeEsim({}) as any)).not.toHaveProperty('esimId')
  })

  it('Provider A resolver never leaks to Provider B (different connectors resolve differently)', () => {
    // Same eSIM-shaped data, different connector resolvers.
    const connectorA = makeConnector({ resolveStatusLookup: (esim: any) => `choice:${esim.iccid}` })
    const connectorB = makeConnector({ resolveStatusLookup: (esim: any) => esim.providerSubscriptionId })
    const esim = makeEsim({ providerSubscriptionId: 'airhub-order-1' })
    const a = resolveStatusLookup(connectorA, esim)
    const b = resolveStatusLookup(connectorB, esim)
    expect(a.ok && (a as any).identifier).toBe('choice:89012345678901234567')
    expect(b.ok && (b as any).identifier).toBe('airhub-order-1')
  })
})

describe('resolveUsageLookup (canonical)', () => {
  it('uses connector.resolveUsageLookup when implemented (TELNA_FLEX ICCID, future custom metadata)', () => {
    const connector = makeConnector({ resolveUsageLookup: (esim: any) => esim.iccid })
    const r = resolveUsageLookup(connector, makeEsim())
    expect(r.ok && (r as any).identifier).toBe('89012345678901234567')
  })

  it('falls back safely when resolveUsageLookup absent', () => {
    const r = resolveUsageLookup(makeConnector(), makeEsim({ providerSubscriptionId: 'sub-1' }))
    expect(r.ok && (r as any).identifier).toBe('sub-1')
    const r2 = resolveUsageLookup(makeConnector(), makeEsim())
    expect(r2.ok && (r2 as any).identifier).toBe('89012345678901234567')
  })

  it('returns IDENTIFIER_MISSING when nothing safe exists', () => {
    const r = resolveUsageLookup(makeConnector(), makeEsim({ iccid: null, providerSubscriptionId: null, providerActivationId: null, providerSubscriberId: null }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.skipReason).toBe('IDENTIFIER_MISSING')
  })

  it('usage identifier may differ from status identifier (separate resolvers)', () => {
    const connector = makeConnector({
      resolveStatusLookup: (esim: any) => `status:${esim.providerSubscriptionId}`,
      resolveUsageLookup: (esim: any) => `usage:${esim.iccid}`,
    })
    const esim = makeEsim({ providerSubscriptionId: 'sub-1' })
    const s = resolveStatusLookup(connector, esim)
    const u = resolveUsageLookup(connector, esim)
    expect(s.ok && (s as any).identifier).toBe('status:sub-1')
    expect(u.ok && (u as any).identifier).toBe('usage:89012345678901234567')
  })

  it('never selects a local esim.id as a usage identifier', () => {
    const r = resolveUsageLookup(makeConnector(), makeEsim({ iccid: null, providerSubscriptionId: null, providerActivationId: null, providerSubscriberId: null }))
    expect(r.ok).toBe(false)
  })
})

describe('capabilitySupported (provider-neutral gate)', () => {
  it('true only when connector declares the capability', () => {
    const c = makeConnector({ capabilities: { statusLookup: true, usageLookup: false } as ConnectorCapabilities })
    expect(capabilitySupported(c, 'statusLookup')).toBe(true)
    expect(capabilitySupported(c, 'usageLookup')).toBe(false)
  })

  it('false when capabilities absent (default all-false)', () => {
    const c = makeConnector({ capabilities: undefined as any })
    expect(capabilitySupported(c, 'statusLookup')).toBe(false)
    expect(capabilitySupported(c, 'usageLookup')).toBe(false)
  })
})

describe('toEsimProviderIdentity', () => {
  it('exposes only provider-owned identifiers (no local esim.id)', () => {
    const bundle = toEsimProviderIdentity(makeEsim({ id: 'local-1', providerPlanId: 'plan-1' }))
    expect(bundle).toHaveProperty('iccid')
    expect(bundle).not.toHaveProperty('id')
    expect(bundle).not.toHaveProperty('providerPlanId')
  })
})
