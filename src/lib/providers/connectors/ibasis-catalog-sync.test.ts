import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    provider: { findUnique: vi.fn(), update: vi.fn() },
  },
}))

vi.mock('@/lib/encryption', () => ({
  encryptToken: vi.fn((t: string | null | undefined) => (t ? `enc:${t}` : null)),
  decryptToken: vi.fn((t: string | null | undefined) => {
    if (!t) return null
    if (typeof t === 'string' && t.startsWith('enc:')) return t.slice(4)
    return t
  }),
}))

vi.mock('@/lib/services/providers/health-monitor', () => ({
  recordHealthEvent: vi.fn().mockResolvedValue(undefined),
}))

const { mockBuildConnector } = vi.hoisted(() => ({ mockBuildConnector: vi.fn() }))
vi.mock('@/lib/providers/connectors/connector-factory', () => ({
  buildConnectorFromProvider: mockBuildConnector,
}))

import { IbasisConnector } from './ibasis-connector'
import { resolveConnectorType } from './connector-type'
import { DEFAULT_PROVIDER_CAPABILITIES } from '@/lib/providers/capabilities/defaults'
import { ProviderCapability } from '@/lib/providers/capabilities/types'
import { parseCapabilities, providerSupports } from '@/lib/providers/capabilities/registry'
import { CAPABILITY_REGISTRY, providerSupportsConnectorCapability } from '@/lib/providers/capability-state'
import { DEFAULT_CONNECTOR_CAPABILITIES } from './connector-interface'
import fs from 'fs'

describe('iBASIS catalog sync — connector runtime truth', () => {
  it('advertises catalogSync=true (syncPlans is genuinely implemented)', () => {
    expect(new IbasisConnector('ibasis-1').capabilities.catalogSync).toBe(true)
  })

  it('resolves the IBASIS adapter strategy to the canonical IBASIS connector', () => {
    expect(resolveConnectorType('IBASIS', 'CUSTOM')).toBe('IBASIS')
    // A stale AIRHUB code never displaces the explicit IBASIS strategy.
    expect(resolveConnectorType('IBASIS', 'CUSTOM', 'AIRHUB')).toBe('IBASIS')
  })

  it('DEFAULT_PROVIDER_CAPABILITIES for IBASIS include the canonical CATALOG_SYNC token', () => {
    expect(DEFAULT_PROVIDER_CAPABILITIES['IBASIS']).toContain(ProviderCapability.CATALOG_SYNC)
  })
})

describe('catalog-sync detection — registry precedence for IBASIS records', () => {
  function provider(overrides: Record<string, unknown> = {}) {
    return { id: 'p1', type: 'CUSTOM', code: 'IBASIS', ...overrides }
  }

  it('explicit array WITH CATALOG_SYNC passes the plan-sync gate', () => {
    expect(providerSupports(provider({ capabilities: ['AUTH', 'INVENTORY', 'CATALOG_SYNC'] }), 'CATALOG_SYNC')).toBe(true)
  })

  it('explicit array WITHOUT CATALOG_SYNC (legacy PLAN_SYNC only) blocks the gate — the provisioning bug', () => {
    expect(providerSupports(provider({ enabledCapabilities: ['AUTH', 'INVENTORY', 'PLAN_SYNC'] }), 'CATALOG_SYNC')).toBe(false)
  })

  it('no explicit array falls back to defaults which include CATALOG_SYNC', () => {
    expect(providerSupports(provider({ enabledCapabilities: null, capabilities: null }), 'CATALOG_SYNC')).toBe(true)
  })

  it('an explicit empty array falls back to defaults in the record gate (parseCapabilities contract)', () => {
    // registry.parseCapabilities treats [] as "not configured" (only the canonical
    // capability-state resolveEnabledCapabilities layer honors [] as a hard disable).
    expect(providerSupports(provider({ enabledCapabilities: [] }), 'CATALOG_SYNC')).toBe(true)
  })

  it('parseCapabilities resolves the explicit array exactly', () => {
    expect(parseCapabilities(provider({ enabledCapabilities: ['PLAN_SYNC', 'PURCHASE'] }))).toEqual(['PLAN_SYNC', 'PURCHASE'])
  })
})

describe('canonical connector-truth subsystem surfaces CATALOG_SYNC', () => {
  it('CAPABILITY_REGISTRY maps CATALOG_SYNC → catalogSync connector key', () => {
    const entry = CAPABILITY_REGISTRY.find(e => e.key === 'CATALOG_SYNC')
    expect(entry?.connectorKey).toBe('catalogSync')
  })

  it('DEFAULT_CONNECTOR_CAPABILITIES declares catalogSync=false (absent means NOT supported)', () => {
    expect(DEFAULT_CONNECTOR_CAPABILITIES.catalogSync).toBe(false)
  })
})

describe('CANONICAL plan-sync gate — connector truth wins over legacy record arrays (no DB change/re-save)', () => {
  const LEGACY_ARRAY = ['AUTH', 'INVENTORY', 'ESIM', 'PLAN_SYNC', 'PURCHASE', 'STATUS', 'SUSPEND', 'RESUME']

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('existing legacy IBASIS record (no CATALOG_SYNC in array) + catalogSync:true connector ⇒ gate PASSES without DB change', async () => {
    mockBuildConnector.mockResolvedValue({ capabilities: { catalogSync: true } })
    const rec = { id: 'p1', type: 'CUSTOM', code: 'IBASIS', enabledCapabilities: LEGACY_ARRAY }
    // The legacy record gate (providerSupports) would block — prove the canonical gate passes.
    expect(providerSupports(rec as never, 'CATALOG_SYNC')).toBe(false)
    expect(await providerSupportsConnectorCapability(rec as never, 'CATALOG_SYNC')).toBe(true)
  })

  it('a stale record containing CATALOG_SYNC CANNOT pass when the connector declares catalogSync:false (case 6)', async () => {
    mockBuildConnector.mockResolvedValue({ capabilities: { catalogSync: false } })
    const rec = { id: 'p1', type: 'CUSTOM', code: 'IBASIS', enabledCapabilities: ['AUTH', 'CATALOG_SYNC'] }
    expect(await providerSupportsConnectorCapability(rec as never, 'CATALOG_SYNC')).toBe(false)
  })

  it('PLAN_SYNC stays backward-compatible but is NOT the source of truth for catalog sync (case 5)', async () => {
    // Connector truth decides regardless of PLAN_SYNC presence.
    mockBuildConnector.mockResolvedValue({ capabilities: { catalogSync: false } })
    const rec = { id: 'p1', type: 'CUSTOM', code: 'IBASIS', enabledCapabilities: ['PLAN_SYNC'] }
    expect(await providerSupportsConnectorCapability(rec as never, 'CATALOG_SYNC')).toBe(false)
    mockBuildConnector.mockResolvedValue({ capabilities: { catalogSync: true } })
    const rec2 = { id: 'p1', type: 'CUSTOM', code: 'IBASIS', enabledCapabilities: ['AUTH'] }
    expect(await providerSupportsConnectorCapability(rec2 as never, 'CATALOG_SYNC')).toBe(true)
  })

  it('explicit [] is a hard disable even when the connector supports catalogSync (never silently re-enabled)', async () => {
    mockBuildConnector.mockResolvedValue({ capabilities: { catalogSync: true } })
    const rec = { id: 'p1', type: 'CUSTOM', code: 'IBASIS', enabledCapabilities: [] }
    expect(await providerSupportsConnectorCapability(rec as never, 'CATALOG_SYNC')).toBe(false)
  })

  it('a MAP explicit disable ({ CATALOG_SYNC: { enabled:false } }) blocks the gate despite connector truth', async () => {
    mockBuildConnector.mockResolvedValue({ capabilities: { catalogSync: true } })
    const rec = { id: 'p1', type: 'CUSTOM', code: 'IBASIS', enabledCapabilities: { CATALOG_SYNC: { enabled: false } } }
    expect(await providerSupportsConnectorCapability(rec as never, 'CATALOG_SYNC')).toBe(false)
  })

  it('a connector that fails to build falls back to the legacy record gate (behavior unchanged)', async () => {
    mockBuildConnector.mockRejectedValue(new Error('unbuildable'))
    const rec = { id: 'p1', type: 'CUSTOM', code: 'IBASIS', enabledCapabilities: ['AUTH', 'CATALOG_SYNC'] }
    expect(await providerSupportsConnectorCapability(rec as never, 'CATALOG_SYNC')).toBe(true)
  })
})

describe('iBASIS provisioning sites persist the canonical CATALOG_SYNC token', () => {
  it('seed-ibasis-provider.mjs enabledCapabilities includes CATALOG_SYNC', () => {
    const content = fs.readFileSync('scripts/seed-ibasis-provider.mjs', 'utf8')
    expect(content).toContain("'CATALOG_SYNC'")
  })

  it('NewProviderForm iBASIS preset capabilities include CATALOG_SYNC', () => {
    const content = fs.readFileSync('src/app/admin/providers/new/NewProviderForm.tsx', 'utf8')
    expect(content).toContain("'CATALOG_SYNC'")
  })

  it('createProvider IBASIS default capabilities include CATALOG_SYNC', () => {
    const content = fs.readFileSync('src/lib/actions/providers.ts', 'utf8')
    expect(content).toContain("'CATALOG_SYNC'")
  })
})