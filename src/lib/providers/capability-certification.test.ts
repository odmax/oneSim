import { describe, it, expect } from 'vitest'
import { classifyCapability, certifyProviderCapabilities, type CertificationLayerInput } from './capability-certification'
import type { ConnectorCapabilities } from '@/lib/providers/connectors/connector-interface'

function base(overrides: Partial<CertificationLayerInput>): CertificationLayerInput {
  return {
    connector: true,
    connectorMethodImplemented: true,
    dbEnabled: true,
    clientApiExposed: true,
    businessRouteExists: true,
    internallyEnabled: true,
    ...overrides,
  }
}

describe('classifyCapability — layered certification', () => {
  it('PASS only when every layer is green', () => {
    expect(classifyCapability(base({}))).toBe('PASS')
  })

  it('a connector-declared false is a hard NOT_SUPPORTED; if exposure/DB claim it → CONFIG_MISMATCH', () => {
    expect(classifyCapability(base({ connector: false, dbEnabled: false, internallyEnabled: false, clientApiExposed: false }))).toBe('NOT_SUPPORTED')
    expect(classifyCapability(base({ connector: false, dbEnabled: true }))).toBe('CONFIG_MISMATCH')
    expect(classifyCapability(base({ connector: false, clientApiExposed: true }))).toBe('CONFIG_MISMATCH')
  })

  it('unknown connector truth → UNKNOWN unless something claims support (DOC_MISMATCH)', () => {
    expect(classifyCapability(base({ connector: 'UNKNOWN', dbEnabled: false, internallyEnabled: false, clientApiExposed: false }))).toBe('UNKNOWN')
    expect(classifyCapability(base({ connector: 'UNKNOWN', dbEnabled: true }))).toBe('DOC_MISMATCH')
  })

  it('undeclared connector capability is NOT_IMPLEMENTED unless a layer claims it (DOC_MISMATCH)', () => {
    expect(classifyCapability(base({ connector: undefined, dbEnabled: false, internallyEnabled: false, clientApiExposed: false }))).toBe('NOT_IMPLEMENTED')
    expect(classifyCapability(base({ connector: undefined, internallyEnabled: true }))).toBe('DOC_MISMATCH')
  })

  it('declared true but method not implemented → NOT_IMPLEMENTED', () => {
    expect(classifyCapability(base({ connector: true, connectorMethodImplemented: false }))).toBe('NOT_IMPLEMENTED')
  })

  it('exposure off → NOT_EXPOSED; internal off + db on → INTERNAL_ONLY', () => {
    expect(classifyCapability(base({ clientApiExposed: false }))).toBe('NOT_EXPOSED')
    expect(classifyCapability(base({ internallyEnabled: false, dbEnabled: true }))).toBe('INTERNAL_ONLY')
  })

  it('exposure on but no business route → API_ROUTE_MISSING', () => {
    expect(classifyCapability(base({ businessRouteExists: false }))).toBe('API_ROUTE_MISSING')
  })
})

describe('certifyProviderCapabilities — full matrix', () => {
  const fullCaps: ConnectorCapabilities = {
    installationLookup: true,
    installationDataAtPurchase: true,
    installationLookupHistorical: false,
    statusLookup: true,
    usageLookup: true,
    topUp: true,
    suspend: true,
    resume: true,
    balance: true,
    inventory: false,
    webhooks: false,
    customPackageCreation: false,
  }

  it('returns a row per capability and classifies PASS for a fully-exposed provider', () => {
    const result = certifyProviderCapabilities(
      'CHOICE',
      fullCaps,
      { purchase: true, installationLookup: true, installationDataAtPurchase: true, installationLookupHistorical: true, statusLookup: true, usageLookup: true, topUp: true, suspend: true, resume: true, balance: true },
      { purchase: true, statusLookup: true, usageLookup: true, topUp: true, suspend: true, resume: true, balance: true },
      { purchase: true, statusLookup: true, usageLookup: true, topUp: true, suspend: true, resume: true, balance: true, installationLookup: true, installationLookupHistorical: true },
      { purchase: true, statusLookup: true, usageLookup: true, topUp: true, suspend: false, resume: false, balance: false, installationLookup: true, installationLookupHistorical: true },
      ['PURCHASE', 'STATUS', 'USAGE', 'TOP_UP', 'SUSPEND', 'RESUME', 'INSTALLATION', 'QR_CODE', 'BALANCE'],
    )
    expect(result.rows.some(r => r.capability === 'purchase' && r.classification === 'PASS')).toBe(true)
    // suspend/resume have no business route yet → API_ROUTE_MISSING (decision pending)
    expect(result.rows.find(r => r.capability === 'suspend')?.classification).toBe('API_ROUTE_MISSING')
    expect(result.rows.find(r => r.capability === 'resume')?.classification).toBe('API_ROUTE_MISSING')
  })

  it('exposure off for a capability → NOT_EXPOSED, not PASS', () => {
    const result = certifyProviderCapabilities(
      'CHOICE',
      fullCaps,
      { statusLookup: true },
      { statusLookup: true },
      { statusLookup: false }, // API exposure OFF
      { statusLookup: true },
      ['STATUS'],
    )
    const row = result.rows.find(r => r.capability === 'statusLookup')
    expect(row?.classification).toBe('NOT_EXPOSED')
  })

  it('DB flag true but connector declares false → CONFIG_MISMATCH', () => {
    const result = certifyProviderCapabilities(
      'X',
      fullCaps, // customPackageCreation is explicitly false here
      {},
      { customPackageCreation: true }, // DB claims it
      { customPackageCreation: false },
      { customPackageCreation: false },
      [],
    )
    const row = result.rows.find(r => r.capability === 'customPackageCreation')
    // Connector explicitly declares false while DB claims support → configuration
    // mismatch (exposure/internal may resurrect an unsupported operation).
    expect(row?.classification).toBe('CONFIG_MISMATCH')
    expect(result.mismatches).toContain('customPackageCreation')
  })

  it('INSTALLATION and QR_CODE are distinct capabilities (semantic proof)', () => {
    // A provider that delivers install credentials (activationCode/smdp/matchingId)
    // but no QR image is INSTALLATION-capable without QR_CODE. Both map to the
    // same connector operation layer but must be exposed independently.
    const qrCapable = { ...fullCaps, installationLookupHistorical: true }
    const result = certifyProviderCapabilities(
      'P',
      qrCapable,
      { installationLookup: true, installationLookupHistorical: true },
      { installationLookup: true, installationLookupHistorical: true },
      { installationLookup: true, installationLookupHistorical: false }, // QR exposed OFF
      { installationLookup: true, installationLookupHistorical: true },
      ['INSTALLATION', 'QR_CODE'],
    )
    const installRow = result.rows.find(r => r.capability === 'installationLookup')
    const qrRow = result.rows.find(r => r.capability === 'installationLookupHistorical')
    // INSTALLATION exposed → PASS; QR_CODE not exposed → NOT_EXPOSED. They are
    // NOT the same capability and must be surfaced separately.
    expect(installRow?.classification).toBe('PASS')
    expect(qrRow?.classification).toBe('NOT_EXPOSED')
    expect(result.rows.filter(r => r.capability === 'installationLookup').length).toBe(1)
  })
})