import { describe, it, expect, vi, beforeEach } from 'vitest'
import { connectorValueToImplementation, resolveRegistryImplementation } from './capability-state'

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
    USMATRIX: ['AUTH', 'CATALOG_SYNC', 'INVENTORY', 'ESIM', 'PURCHASE', 'STATUS', 'USAGE', 'SUSPEND', 'RESUME'],
    CHOICE: ['AUTH', 'CATALOG_SYNC', 'PURCHASE', 'STATUS', 'USAGE', 'SUSPEND', 'RESUME', 'BALANCE'],
    AIRHUB: ['AUTH', 'CATALOG_SYNC', 'PURCHASE', 'STATUS', 'BALANCE'],
    // Telna-like defaults intentionally EXCLUDE CUSTOM_PACKAGE_CREATION.
    TELNA: ['AUTH', 'CATALOG_SYNC', 'PURCHASE', 'USAGE', 'STATUS', 'BALANCE', 'INVENTORY'],
  },
}))

import { getProviderCapabilityState, getCustomPackageCreationReadiness } from './capability-state'

function usmConnector() {
  return {
    constructor: { name: 'UsMatrixConnector' },
    capabilities: {
      installationLookup: true,
      installationDataAtPurchase: true,
      installationLookupHistorical: true,
      statusLookup: true,
      usageLookup: true,
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
    mockProviderFindUnique.mockResolvedValue({ id: 'usm-1', code: 'USMATRIX', enabledCapabilities: null })
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

  it('reports US-Matrix STATUS/USAGE as SUPPORTED + enabled; TOP_UP/BALANCE NOT_SUPPORTED', async () => {
    const r = await getProviderCapabilityState('usm-1')
    const by = r!.byKey
    expect(by.STATUS.implementationState).toBe('SUPPORTED')
    expect(by.STATUS.enabled).toBe(true)
    expect(by.USAGE.implementationState).toBe('SUPPORTED')
    expect(by.USAGE.enabled).toBe(true)
    expect(by.TOP_UP.implementationState).toBe('NOT_SUPPORTED')
    expect(by.BALANCE.implementationState).toBe('NOT_SUPPORTED')
  })

  it('a provider-enabled capability the connector does not implement is NEVER enabled', async () => {
    // Provider enables TOP_UP but the US-Matrix connector declares topUp:false.
    mockProviderFindUnique.mockResolvedValue({ id: 'usm-1', code: 'USMATRIX', enabledCapabilities: ['TOP_UP', 'PURCHASE'] })
    const r = await getProviderCapabilityState('usm-1')
    expect(r!.byKey.TOP_UP.implementationState).toBe('NOT_SUPPORTED')
    expect(r!.byKey.TOP_UP.enabled).toBe(false)
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
    mockProviderFindUnique.mockResolvedValue({ id: 'usm-1', code: 'USMATRIX', enabledCapabilities: null })
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
    mockProviderFindUnique.mockResolvedValue({ id: 'bad-1', code: 'CHOICE', enabledCapabilities: null })
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

  it('enabled vs implemented: a capability absent from defaults stays disabled', async () => {
    mockProviderFindUnique.mockResolvedValue({ id: 'usm-1', code: 'USMATRIX', enabledCapabilities: null })
    // USMATRIX defaults include STATUS/USAGE/PURCHASE/SUSPEND/RESUME but NOT TOP_UP/BALANCE.
    const r = await getProviderCapabilityState('usm-1')
    expect(r!.byKey.PURCHASE.implementationState).toBe('SUPPORTED')
    expect(r!.byKey.PURCHASE.enabled).toBe(true)
    expect(r!.byKey.STATUS.enabled).toBe(true)
    expect(r!.byKey.USAGE.enabled).toBe(true)
    expect(r!.byKey.TOP_UP.implementationState).toBe('NOT_SUPPORTED')
    expect(r!.byKey.TOP_UP.enabled).toBe(false)
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

  it('an EXPLICIT empty enabledCapabilities disables a default capability (no fallback re-enable)', async () => {
    // [] is present → explicit configuration → must NOT re-expand to USMATRIX
    // defaults (which include PURCHASE). This is what lets a toggle reliably
    // disable a default capability.
    mockProviderFindUnique.mockResolvedValue({ id: 'usm-1', code: 'USMATRIX', enabledCapabilities: [] })
    mockBuildConnector.mockResolvedValue(usmConnector())
    const r = await getProviderCapabilityState('usm-1')
    expect(r!.byKey.PURCHASE.implementationState).toBe('SUPPORTED')
    expect(r!.byKey.PURCHASE.enabled).toBe(false)
    expect(r!.byKey.STATUS.enabled).toBe(false)
    expect(r!.byKey.USAGE.enabled).toBe(false)
  })
})

describe('capability resolver — template/incomplete provider safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProviderFindUnique.mockResolvedValue({ id: 'tmpl-1', code: 'CUSTOM', enabledCapabilities: null })
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

describe('PURCHASE support vs account enablement (target model)', () => {
  const PURCHASE_ENTRY = { key: 'PURCHASE', connectorKey: 'installationDataAtPurchase' as const }

  beforeEach(() => {
    vi.clearAllMocks()
    mockExposePortal.mockResolvedValue(true)
    mockExposeApi.mockResolvedValue(true)
  })

  function telnaPurchaseConnector(overrides: Record<string, any> = {}) {
    return {
      constructor: { name: 'TelnaConnector' },
      capabilities: {
        // Mirrors the real Telna legacy declaration (see telna-connector.ts):
        // wired purchase path + install-data-at-purchase unknown.
        purchase: true,
        installationLookup: true,
        installationDataAtPurchase: 'UNKNOWN' as const,
        installationLookupHistorical: true,
        statusLookup: true,
        usageLookup: true,
        topUp: false,
        suspend: false,
        resume: false,
        balance: true,
        inventory: true,
        webhooks: false,
        ...overrides,
      },
    }
  }

  it('resolveRegistryImplementation: explicit purchase declaration wins over legacy key', () => {
    expect(resolveRegistryImplementation(PURCHASE_ENTRY, { purchase: true, installationDataAtPurchase: false } as any)).toBe('SUPPORTED')
    expect(resolveRegistryImplementation(PURCHASE_ENTRY, { purchase: false, installationDataAtPurchase: true } as any)).toBe('NOT_SUPPORTED')
    expect(resolveRegistryImplementation(PURCHASE_ENTRY, { purchase: 'UNKNOWN', installationDataAtPurchase: true } as any)).toBe('UNKNOWN')
    // Legacy fallback when the connector does not declare `purchase`.
    expect(resolveRegistryImplementation(PURCHASE_ENTRY, { installationDataAtPurchase: true } as any)).toBe('SUPPORTED')
    expect(resolveRegistryImplementation(PURCHASE_ENTRY, { } as any)).toBe('NOT_IMPLEMENTED')
    // Non-PURCHASE entries resolve from their own connector key.
    expect(resolveRegistryImplementation({ key: 'TOP_UP', connectorKey: 'topUp' }, { topUp: true } as any)).toBe('SUPPORTED')
  })

  it('supported + enabled (TELNA defaults include PURCHASE) → Supported + Enabled', async () => {
    mockProviderFindUnique.mockResolvedValue({ id: 'telna-1', code: 'TELNA', enabledCapabilities: null })
    mockBuildConnector.mockResolvedValue(telnaPurchaseConnector())
    const r = await getProviderCapabilityState('telna-1')
    expect(r!.byKey.PURCHASE.implementationState).toBe('SUPPORTED')
    expect(r!.byKey.PURCHASE.enabled).toBe(true)
  })

  it('supported but disabled for this account → implementation stays SUPPORTED, enabled NO (never collapsed to Unknown)', async () => {
    mockProviderFindUnique.mockResolvedValue({ id: 'telna-1', code: 'TELNA', enabledCapabilities: [] })
    mockBuildConnector.mockResolvedValue(telnaPurchaseConnector())
    const r = await getProviderCapabilityState('telna-1')
    expect(r!.byKey.PURCHASE.implementationState).toBe('SUPPORTED')
    expect(r!.byKey.PURCHASE.enabled).toBe(false)
  })

  it('unknown support stays UNKNOWN and is never enabled — regardless of the account flag', async () => {
    mockProviderFindUnique.mockResolvedValue({ id: 'telna-1', code: 'TELNA', enabledCapabilities: ['PURCHASE'] })
    mockBuildConnector.mockResolvedValue(telnaPurchaseConnector({ purchase: 'UNKNOWN' }))
    const r = await getProviderCapabilityState('telna-1')
    expect(r!.byKey.PURCHASE.implementationState).toBe('UNKNOWN')
    expect(r!.byKey.PURCHASE.enabled).toBe(false)
  })

  it('not supported → NOT_SUPPORTED even when the provider enables PURCHASE', async () => {
    mockProviderFindUnique.mockResolvedValue({ id: 'x-1', code: 'TELNA_FLEX', enabledCapabilities: ['PURCHASE'] })
    mockBuildConnector.mockResolvedValue(telnaPurchaseConnector({ purchase: false }))
    const r = await getProviderCapabilityState('x-1')
    expect(r!.byKey.PURCHASE.implementationState).toBe('NOT_SUPPORTED')
    expect(r!.byKey.PURCHASE.enabled).toBe(false)
  })

  it('Telna regression: wired purchase is SUPPORTED while install-data-at-purchase remains UNKNOWN (no conflation)', async () => {
    mockProviderFindUnique.mockResolvedValue({ id: 'telna-1', code: 'TELNA', enabledCapabilities: null })
    mockBuildConnector.mockResolvedValue(telnaPurchaseConnector())
    const r = await getProviderCapabilityState('telna-1')
    expect(r!.byKey.PURCHASE.implementationState).toBe('SUPPORTED')
    expect(r!.byKey.INSTALLATION_DATA_AT_PURCHASE.implementationState).toBe('UNKNOWN')
  })

  it('provider-neutral legacy fallback: existing connectors without `purchase` keep working', async () => {
    mockProviderFindUnique.mockResolvedValue({ id: 'usm-1', code: 'USMATRIX', enabledCapabilities: null })
    mockBuildConnector.mockResolvedValue(usmConnector()) // declares only installationDataAtPurchase: true
    const r = await getProviderCapabilityState('usm-1')
    expect(r!.byKey.PURCHASE.implementationState).toBe('SUPPORTED')
    expect(r!.byKey.PURCHASE.enabled).toBe(true)
  })
})

describe('CUSTOM_PACKAGE_CREATION registry entry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExposePortal.mockResolvedValue(true)
    mockExposeApi.mockResolvedValue(true)
  })

  it('is enabled only when connector supports it AND provider explicitly enables it (default disabled)', async () => {
    const telnaConnector = {
      constructor: { name: 'TelnaConnector' },
      capabilities: {
        installationLookup: false,
        installationDataAtPurchase: true,
        installationLookupHistorical: false,
        statusLookup: true,
        usageLookup: true,
        topUp: false,
        suspend: false,
        resume: false,
        balance: true,
        inventory: true,
        webhooks: false,
        customPackageCreation: true,
      },
    }
    // Default (no explicit enabledCapabilities → represents null → TELNA defaults, which exclude it).
    mockProviderFindUnique.mockResolvedValue({ id: 'telna-1', code: 'TELNA', enabledCapabilities: null })
    mockBuildConnector.mockResolvedValue(telnaConnector)
    let r = await getProviderCapabilityState('telna-1')
    expect(r!.byKey.CUSTOM_PACKAGE_CREATION.implementationState).toBe('SUPPORTED')
    expect(r!.byKey.CUSTOM_PACKAGE_CREATION.enabled).toBe(false)

    // Explicitly enabled via enabledCapabilities.
    mockProviderFindUnique.mockResolvedValue({ id: 'telna-1', code: 'TELNA', enabledCapabilities: ['CUSTOM_PACKAGE_CREATION'] })
    r = await getProviderCapabilityState('telna-1')
    expect(r!.byKey.CUSTOM_PACKAGE_CREATION.enabled).toBe(true)
  })

  it('is NEVER enabled when the connector does not support it, regardless of provider flag', async () => {
    mockProviderFindUnique.mockResolvedValue({ id: 'p-1', code: 'CHOICE', enabledCapabilities: ['CUSTOM_PACKAGE_CREATION'] })
    mockBuildConnector.mockResolvedValue(usmConnector()) // no customPackageCreation declared → NOT_SUPPORTED (default false)
    const r = await getProviderCapabilityState('p-1')
    expect(r!.byKey.CUSTOM_PACKAGE_CREATION.implementationState).toBe('NOT_SUPPORTED')
    expect(r!.byKey.CUSTOM_PACKAGE_CREATION.enabled).toBe(false)
  })
})

describe('getCustomPackageCreationReadiness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExposePortal.mockResolvedValue(true)
    mockExposeApi.mockResolvedValue(true)
  })

  function telnaConnector() {
    return { constructor: { name: 'TelnaConnector' }, capabilities: { ...usmConnector().capabilities, customPackageCreation: true } }
  }

  it('ready only when connector supports + provider operational + explicitly enabled', async () => {
    mockProviderFindUnique.mockResolvedValue({ id: 'telna-1', code: 'TELNA', status: 'ACTIVE', enabledCapabilities: ['CUSTOM_PACKAGE_CREATION'] })
    mockBuildConnector.mockResolvedValue(telnaConnector())
    expect(await getCustomPackageCreationReadiness('telna-1')).toEqual({ ready: true })
  })

  it('defaults to DISABLED when not explicitly enabled (null → TELNA defaults exclude it)', async () => {
    mockProviderFindUnique.mockResolvedValue({ id: 'telna-1', code: 'TELNA', status: 'ACTIVE', enabledCapabilities: null })
    mockBuildConnector.mockResolvedValue(telnaConnector())
    expect(await getCustomPackageCreationReadiness('telna-1')).toEqual({ ready: false, reason: 'account-not-enabled' })
  })

  it('an EXPLICIT empty array is a hard disable (never re-expanded to defaults)', async () => {
    // Even where CUSTOM_PACKAGE_CREATION is a documented default, an explicit []
    // must NOT fall back to enable it.
    mockProviderFindUnique.mockResolvedValue({ id: 'telna-1', code: 'TELNA', status: 'ACTIVE', enabledCapabilities: [] })
    mockBuildConnector.mockResolvedValue(telnaConnector())
    expect(await getCustomPackageCreationReadiness('telna-1')).toEqual({ ready: false, reason: 'account-not-enabled' })
    // And an explicitly-enabling provider is NOT affected.
    mockProviderFindUnique.mockResolvedValue({ id: 'telna-1', code: 'TELNA', status: 'ACTIVE', enabledCapabilities: ['CUSTOM_PACKAGE_CREATION'] })
    expect((await getCustomPackageCreationReadiness('telna-1')).ready).toBe(true)
  })

  it('is disabled when the connector does not support customPackageCreation', async () => {
    mockProviderFindUnique.mockResolvedValue({ id: 'telna-1', code: 'TELNA', status: 'ACTIVE', enabledCapabilities: ['CUSTOM_PACKAGE_CREATION'] })
    mockBuildConnector.mockResolvedValue(usmConnector()) // no customPackageCreation
    const r = await getCustomPackageCreationReadiness('telna-1')
    expect(r.ready).toBe(false)
    expect(r.reason).toBe('connector-does-not-support')
  })

  it('is disabled for non-operational providers even when enabled', async () => {
    mockProviderFindUnique.mockResolvedValue({ id: 'telna-1', code: 'TELNA', status: 'SUSPENDED', enabledCapabilities: ['CUSTOM_PACKAGE_CREATION'] })
    mockBuildConnector.mockResolvedValue(telnaConnector())
    const r = await getCustomPackageCreationReadiness('telna-1')
    expect(r.ready).toBe(false)
    expect(r.reason).toContain('provider-not-operational')
  })

  it('is disabled for unknown providers', async () => {
    mockProviderFindUnique.mockResolvedValue(null)
    expect((await getCustomPackageCreationReadiness('missing')).ready).toBe(false)
  })

  it('is provider-neutral — a future provider code works identically when explicitly enabled', async () => {
    mockProviderFindUnique.mockResolvedValue({ id: 'x-1', code: 'SOME_FUTURE', status: 'ACTIVE', enabledCapabilities: ['CUSTOM_PACKAGE_CREATION'] })
    mockBuildConnector.mockResolvedValue(telnaConnector())
    expect((await getCustomPackageCreationReadiness('x-1')).ready).toBe(true)
  })

  it('does not fetch the network (readiness is local to provider config + connector)', async () => {
    mockProviderFindUnique.mockResolvedValue({ id: 'telna-1', code: 'TELNA', status: 'ACTIVE', enabledCapabilities: ['CUSTOM_PACKAGE_CREATION'] })
    mockBuildConnector.mockResolvedValue(telnaConnector())
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('no network') })
    await getCustomPackageCreationReadiness('telna-1')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
