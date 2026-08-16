import { describe, it, expect, vi, beforeEach } from 'vitest'
import { connectorValueToImplementation } from './capability-state'

const { mockProviderFindUnique, mockBuildConnector, mockExposePortal, mockExposeApi } = vi.hoisted(() => ({
  mockProviderFindUnique: vi.fn(),
  mockBuildConnector: vi.fn(),
  mockExposePortal: vi.fn(async () => true),
  mockExposeApi: vi.fn(async () => true),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: { provider: { findUnique: mockProviderFindUnique } },
}))

vi.mock('@/lib/providers/connectors/connector-factory', () => ({
  buildConnectorFromProvider: mockBuildConnector,
}))

vi.mock('@/lib/providers/capabilities/exposure', () => ({
  isCapabilityExposedToPortal: mockExposePortal,
  isCapabilityExposedToApi: mockExposeApi,
}))

vi.mock('@/lib/providers/capabilities/defaults', () => ({
  DEFAULT_PROVIDER_CAPABILITIES: {
    USMATRIX: ['AUTH', 'CATALOG_SYNC', 'INVENTORY', 'ESIM', 'PURCHASE', 'SUSPEND', 'RESUME'],
    CHOICE: ['AUTH', 'CATALOG_SYNC', 'PURCHASE', 'STATUS', 'USAGE', 'SUSPEND', 'RESUME', 'BALANCE'],
    AIRHUB: ['AUTH', 'CATALOG_SYNC', 'PURCHASE', 'STATUS', 'BALANCE'],
  },
}))

import { getProviderCapabilityState } from './capability-state'

function usmConnector() {
  return {
    constructor: { name: 'UsMatrixConnector' },
    capabilities: {
      installationLookup: true,
      installationDataAtPurchase: true,
      installationLookupHistorical: true,
      statusLookup: false,
      usageLookup: false,
      topUp: false,
      suspend: true,
      resume: true,
      balance: false,
      inventory: true,
      webhooks: false,
    },
  }
}

describe('getProviderCapabilityState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProviderFindUnique.mockResolvedValue({ id: 'usm-1', code: 'USMATRIX', enabledCapabilities: [] })
    mockBuildConnector.mockResolvedValue(usmConnector())
    mockExposePortal.mockResolvedValue(true)
    mockExposeApi.mockResolvedValue(true)
  })

  it('reports US-Matrix PURCHASE/SUSPEND/RESUME/INSTALL as SUPPORTED + enabled (from connector + defaults)', async () => {
    const r = await getProviderCapabilityState('usm-1')
    expect(r).not.toBeNull()
    expect(r!.connectorClass).toBe('UsMatrixConnector')
    const by = r!.byKey
    expect(by.PURCHASE.implementationState).toBe('SUPPORTED')
    expect(by.PURCHASE.enabled).toBe(true)
    expect(by.SUSPEND.implementationState).toBe('SUPPORTED')
    expect(by.SUSPEND.enabled).toBe(true)
    expect(by.RESUME.enabled).toBe(true)
    expect(by.INSTALLATION_DATA_AT_PURCHASE.implementationState).toBe('SUPPORTED')
    expect(by.INSTALLATION_LOOKUP_HISTORICAL.implementationState).toBe('SUPPORTED')
  })

  it('reports US-Matrix STATUS/USAGE/TOP_UP/BALANCE as NOT_SUPPORTED and NOT enabled', async () => {
    const r = await getProviderCapabilityState('usm-1')
    const by = r!.byKey
    expect(by.STATUS.implementationState).toBe('NOT_SUPPORTED')
    expect(by.STATUS.enabled).toBe(false)
    expect(by.USAGE.implementationState).toBe('NOT_SUPPORTED')
    expect(by.USAGE.enabled).toBe(false)
    expect(by.TOP_UP.implementationState).toBe('NOT_SUPPORTED')
    expect(by.BALANCE.implementationState).toBe('NOT_SUPPORTED')
  })

  it('a provider-enabled capability the connector does not implement is NEVER enabled', async () => {
    // Provider enables USAGE but connector says NOT_SUPPORTED.
    mockProviderFindUnique.mockResolvedValue({ id: 'usm-1', code: 'USMATRIX', enabledCapabilities: ['USAGE', 'PURCHASE'] })
    const r = await getProviderCapabilityState('usm-1')
    expect(r!.byKey.USAGE.implementationState).toBe('NOT_SUPPORTED')
    expect(r!.byKey.USAGE.enabled).toBe(false)
    // PURCHASE is supported + enabled.
    expect(r!.byKey.PURCHASE.enabled).toBe(true)
  })

  it('respects provider exposure separately (enabled but portal-disabled)', async () => {
    mockExposePortal.mockResolvedValue(false)
    mockExposeApi.mockResolvedValue(true)
    const r = await getProviderCapabilityState('usm-1')
    const p = r!.byKey.PURCHASE
    expect(p.implementationState).toBe('SUPPORTED')
    expect(p.enabled).toBe(true)
    expect(p.portalExposed).toBe(false)
    expect(p.apiExposed).toBe(true)
  })

  it('returns null when provider not found', async () => {
    mockProviderFindUnique.mockResolvedValue(null)
    expect(await getProviderCapabilityState('missing')).toBeNull()
  })

  it('is provider-neutral (no code branches) — future provider works identically', async () => {
    // Unknown provider code with no defaults: enable PURCHASE explicitly.
    mockProviderFindUnique.mockResolvedValue({ id: 'future-1', code: 'FUTURE', enabledCapabilities: ['PURCHASE'] })
    mockBuildConnector.mockResolvedValue({
      constructor: { name: 'FutureConnector' },
      capabilities: { ...usmConnector().capabilities, statusLookup: true },
    })
    const r = await getProviderCapabilityState('future-1')
    expect(r!.connectorClass).toBe('FutureConnector')
    expect(r!.byKey.STATUS.implementationState).toBe('SUPPORTED')
    expect(r!.byKey.PURCHASE.enabled).toBe(true)
  })

  it('makes ZERO provider HTTP calls (side-effect-free discovery)', async () => {
    // Global fetch is not used by getProviderCapabilityState — connector
    // construction + reading capabilities is pure w.r.t. the network.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('must not fetch') })
    mockProviderFindUnique.mockResolvedValue({ id: 'usm-1', code: 'USMATRIX', enabledCapabilities: [] })
    mockBuildConnector.mockResolvedValue(usmConnector())
    const r = await getProviderCapabilityState('usm-1')
    expect(r).not.toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('does not persist anything (no provider update / write mocks touched)', async () => {
    const callsBefore = (mockProviderFindUnique as any).mock.calls.length
    await getProviderCapabilityState('usm-1')
    // Only the read is expected; no update call exists on the mock to begin with.
    expect((mockProviderFindUnique as any).mock.calls.length).toBe(callsBefore + 1)
  })

  it('incomplete provider (connector construction throws) → conservative UNKNOWN, no crash, no credential leak', async () => {
    mockProviderFindUnique.mockResolvedValue({ id: 'bad-1', code: 'CHOICE', enabledCapabilities: [] })
    mockBuildConnector.mockRejectedValue(new Error('Provider config incomplete'))
    const r = await getProviderCapabilityState('bad-1')
    expect(r).not.toBeNull()
    // Connector failed → capability state falls back to defaults; implementation
    // state for unimplemented keys is NOT inferred as supported.
    expect(r!.connectorClass).toBeNull()
    for (const s of r!.states) {
      expect(s.implementationState).not.toBe('SUPPORTED')
      expect(s.enabled).toBe(false)
      // Never surfaces the underlying error or any credential.
      expect(JSON.stringify(s)).not.toContain('Provider config incomplete')
    }
  })

  it('enabled vs implemented: provider-disabled SUPPORTED capability is Supported/Disabled', async () => {
    mockProviderFindUnique.mockResolvedValue({ id: 'usm-1', code: 'USMATRIX', enabledCapabilities: [] })
    // USMATRIX defaults include SUSPEND/RESUME/PURCHASE but NOT USAGE.
    const r = await getProviderCapabilityState('usm-1')
    expect(r!.byKey.PURCHASE.implementationState).toBe('SUPPORTED')
    expect(r!.byKey.PURCHASE.enabled).toBe(true)
    expect(r!.byKey.USAGE.implementationState).toBe('NOT_SUPPORTED')
    expect(r!.byKey.USAGE.enabled).toBe(false)
  })

  it('exposure does NOT alter implementation or enabled truth', async () => {
    mockExposePortal.mockResolvedValue(false)
    mockExposeApi.mockResolvedValue(false)
    const r = await getProviderCapabilityState('usm-1')
    expect(r!.byKey.PURCHASE.implementationState).toBe('SUPPORTED')
    expect(r!.byKey.PURCHASE.enabled).toBe(true)
    expect(r!.byKey.PURCHASE.portalExposed).toBe(false)
    expect(r!.byKey.PURCHASE.apiExposed).toBe(false)
  })
})

describe('capability resolver — template/incomplete provider safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProviderFindUnique.mockResolvedValue({ id: 'tmpl-1', code: 'CUSTOM', enabledCapabilities: [] })
    mockExposePortal.mockResolvedValue(true)
    mockExposeApi.mockResolvedValue(true)
  })

  it('template/custom provider with a connector resolves what is statically known without network calls', async () => {
    mockBuildConnector.mockResolvedValue({
      constructor: { name: 'RestCatalogConnector' },
      capabilities: { ...usmConnector().capabilities },
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('no fetch') })
    const r = await getProviderCapabilityState('tmpl-1')
    expect(r).not.toBeNull()
    expect(r!.connectorClass).toBe('RestCatalogConnector')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('template/custom provider with NO connector → conservative state, no crash', async () => {
    mockBuildConnector.mockResolvedValue(null)
    const r = await getProviderCapabilityState('tmpl-1')
    expect(r).not.toBeNull()
    expect(r!.connectorClass).toBeNull()
    for (const s of r!.states) {
      expect(s.enabled).toBe(false)
      expect(s.implementationState).not.toBe('SUPPORTED')
    }
  })
})

describe('connectorValueToImplementation', () => {
  it('maps tri-state values', () => {
    expect(connectorValueToImplementation(true)).toBe('SUPPORTED')
    expect(connectorValueToImplementation(false)).toBe('NOT_SUPPORTED')
    expect(connectorValueToImplementation('UNKNOWN')).toBe('UNKNOWN')
    expect(connectorValueToImplementation(undefined)).toBe('NOT_IMPLEMENTED')
  })
})
