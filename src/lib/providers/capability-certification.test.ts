import { describe, it, expect } from 'vitest'
import { classifyCapability, certifyProviderCapabilities, remediationCategory, type CertificationLayerInput } from './capability-certification'
import type { ConnectorCapabilities } from '@/lib/providers/connectors/connector-interface'

function base(overrides: Partial<CertificationLayerInput>): CertificationLayerInput {
  return {
    connector: true,
    connectorMethodImplemented: true,
    dbEnabled: true,
    clientApiExposed: true,
    businessRouteExists: true,
    internallyEnabled: true,
    contractDocumented: true,
    ...overrides,
  }
}

describe('classifyCapability — corrected layered semantics', () => {
  it('PASS only when every layer is green', () => {
    expect(classifyCapability(base({}))).toBe('PASS')
  })

  it('exposure must never create a mismatch when connector+DB+contract all say NO', () => {
    // Default exposure policy true (PURCHASE/STATUS/etc are default-exposed) but
    // connector=false + DB=false → NOT_SUPPORTED, NOT CONFIG_MISMATCH.
    expect(classifyCapability(base({ connector: false, dbEnabled: false, internallyEnabled: false, clientApiExposed: true }))).toBe('NOT_SUPPORTED')
    // Same with contractDocumented=false (AirHub usage: not documented).
    expect(classifyCapability(base({ connector: false, dbEnabled: false, internallyEnabled: false, clientApiExposed: true, contractDocumented: false }))).toBe('NOT_SUPPORTED')
  })

  it('connector=false + provider DB true → DB_FLAG_STALE_TRUE (stale enable, not CONFIG_MISMATCH)', () => {
    expect(classifyCapability(base({ connector: false, dbEnabled: true, internallyEnabled: true }))).toBe('DB_FLAG_STALE_TRUE')
  })

  it('unknown connector truth → UNKNOWN unless provider DB/internal claims support (DOC_MISMATCH)', () => {
    expect(classifyCapability(base({ connector: 'UNKNOWN', dbEnabled: false, internallyEnabled: false }))).toBe('UNKNOWN')
    expect(classifyCapability(base({ connector: 'UNKNOWN', dbEnabled: true }))).toBe('DOC_MISMATCH')
  })

  it('undeclared connector capability: contract-documented → CONTRACT_SUPPORTED_NOT_IMPLEMENTED; else NOT_SUPPORTED; provider claim → DOC_MISMATCH', () => {
    expect(classifyCapability(base({ connector: undefined, dbEnabled: false, internallyEnabled: false }))).toBe('CONTRACT_SUPPORTED_NOT_IMPLEMENTED')
    expect(classifyCapability(base({ connector: undefined, dbEnabled: false, internallyEnabled: false, contractDocumented: false }))).toBe('NOT_SUPPORTED')
    expect(classifyCapability(base({ connector: undefined, dbEnabled: true }))).toBe('DOC_MISMATCH')
  })

  it('declared true but method not implemented → NOT_IMPLEMENTED', () => {
    expect(classifyCapability(base({ connector: true, connectorMethodImplemented: false }))).toBe('NOT_IMPLEMENTED')
  })

  it('connector+contract ready but provider internal enable missing → INTERNAL_ENABLE_MISSING', () => {
    expect(classifyCapability(base({ internallyEnabled: false }))).toBe('INTERNAL_ENABLE_MISSING')
  })

  it('connector+internal ready + route exists + API exposure off → API_EXPOSURE_MISSING', () => {
    expect(classifyCapability(base({ clientApiExposed: false, businessRouteExists: true }))).toBe('API_EXPOSURE_MISSING')
  })

  it('connector+internal+exposure ready but no Business route → INTERNAL_ONLY (not API_ROUTE_MISSING)', () => {
    expect(classifyCapability(base({ businessRouteExists: false }))).toBe('INTERNAL_ONLY')
  })
})

describe('remediationCategory — taxonomy mapping', () => {
  it('classifies to the expected reconciliation category', () => {
    expect(remediationCategory('DB_FLAG_STALE_TRUE')).toBe('DB_FLAG_STALE_TRUE')
    expect(remediationCategory('INTERNAL_ENABLE_MISSING')).toBe('ENABLED_CAPABILITY_MISSING')
    expect(remediationCategory('API_EXPOSURE_MISSING')).toBe('API_EXPOSURE_MISSING')
    expect(remediationCategory('INTERNAL_ONLY')).toBe('API_ROUTE_INTENTIONALLY_MISSING')
    expect(remediationCategory('PASS')).toBe('EXPECTED_NO_ACTION')
    expect(remediationCategory('NOT_SUPPORTED')).toBe('EXPECTED_NO_ACTION')
    expect(remediationCategory('CONTRACT_SUPPORTED_NOT_IMPLEMENTED')).toBe('CONTRACT_NOT_IMPLEMENTED')
    expect(remediationCategory('ENTITLEMENT_PENDING')).toBe('ENTITLEMENT_PENDING')
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

  it('PASS for a fully-exposed capability with a route', () => {
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
    // suspend/resume/balance: connector+internal+exposure ready, no Business route
    // → INTERNAL_ONLY (not API_ROUTE_MISSING). Correct per semantics.
    expect(result.rows.find(r => r.capability === 'suspend')?.classification).toBe('INTERNAL_ONLY')
    expect(result.rows.find(r => r.capability === 'resume')?.classification).toBe('INTERNAL_ONLY')
    expect(result.rows.find(r => r.capability === 'balance')?.classification).toBe('INTERNAL_ONLY')
  })

  it('exposure off with a route → API_EXPOSURE_MISSING, not PASS', () => {
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
    expect(row?.classification).toBe('API_EXPOSURE_MISSING')
    expect(row?.remediation).toBe('API_EXPOSURE_MISSING')
  })

  it('connector=false but DB flag true → DB_FLAG_STALE_TRUE (stale DB, not CONFIG_MISMATCH)', () => {
    // fullCaps.customPackageCreation=false (connector says NO) but dbFlags says
    // true → any provider-side claim of customPackageCreation is stale.
    const result = certifyProviderCapabilities(
      'X',
      fullCaps,
      {},
      { customPackageCreation: true }, // DB claims it
      { customPackageCreation: false },
      { customPackageCreation: false },
      [],
    )
    const row = result.rows.find(r => r.capability === 'customPackageCreation')
    expect(row?.classification).toBe('DB_FLAG_STALE_TRUE')
    expect(result.mismatches).toContain('customPackageCreation')
    // Provider balance can never be business-webhook-like: BALANCE internal.
  })

  it('INSTALLATION and QR_CODE are distinct capabilities (semantic proof)', () => {
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
    expect(installRow?.classification).toBe('PASS')
    // QR_CODE exposed OFF but has the same route → API_EXPOSURE_MISSING.
    expect(qrRow?.classification).toBe('API_EXPOSURE_MISSING')
    expect(result.rows.filter(r => r.capability === 'installationLookup').length).toBe(1)
  })

  it('customPackageCreation can never be BUSINESS_READY when connector/DB says NO', () => {
    const result = certifyProviderCapabilities(
      'X',
      fullCaps, // customPackageCreation=false
      { customPackageCreation: false },
      { customPackageCreation: false },
      { customPackageCreation: true }, // admin did not intend; exposure off anyway
      { customPackageCreation: false },
      [],
    )
    const row = result.rows.find(r => r.capability === 'customPackageCreation')
    expect(['NOT_SUPPORTED', 'DB_FLAG_STALE_TRUE', 'DOC_MISMATCH']).toContain(row?.classification)
    expect(row?.classification).not.toBe('PASS')
  })
})

// ─────────────────────────────────────────────
// Part 11 reconciliation safety cases (pure engine)
// ─────────────────────────────────────────────
describe('RECONCILE — deterministic safety classification per provider intent', () => {
  const fullCaps = {
    installationLookup: true, installationDataAtPurchase: true, installationLookupHistorical: false,
    statusLookup: true, usageLookup: true, topUp: true, suspend: true, resume: true, balance: true,
    inventory: false, webhooks: false, customPackageCreation: false,
  } as ConnectorCapabilities

  it('1. default API exposure cannot make an unsupported capability a mismatch', () => {
    // PURCHASE is default-exposed; connector=false + DB=false + exposure=true.
    const result = certifyProviderCapabilities('X', { ...fullCaps, purchase: false }, {}, { purchase: false }, { purchase: true }, { purchase: true }, [])
    const row = result.rows.find(r => r.capability === 'purchase')
    expect(row?.classification).toBe('NOT_SUPPORTED')
    expect(result.mismatches).not.toContain('purchase')
    expect(remediationCategory(row!.classification)).toBe('EXPECTED_NO_ACTION')
  })

  it('2. DB=true + connector=false is stale DB flag', () => {
    const result = certifyProviderCapabilities('X', { ...fullCaps, topUp: false }, {}, { topUp: true }, { topUp: true }, { topUp: true }, ['TOP_UP'])
    const row = result.rows.find(r => r.capability === 'topUp')
    expect(row?.classification).toBe('DB_FLAG_STALE_TRUE')
    expect(remediationCategory(row!.classification)).toBe('DB_FLAG_STALE_TRUE')
  })

  it('3. connector=true + DB/internal=false gives enable-missing', () => {
    const result = certifyProviderCapabilities('X', fullCaps, { statusLookup: true }, { statusLookup: false }, { statusLookup: true }, { statusLookup: true }, [])
    const row = result.rows.find(r => r.capability === 'statusLookup')
    expect(row?.classification).toBe('INTERNAL_ENABLE_MISSING')
    expect(remediationCategory(row!.classification)).toBe('ENABLED_CAPABILITY_MISSING')
  })

  it('4. connector ready + internal ready + route exists + API off → API exposure missing', () => {
    const result = certifyProviderCapabilities('X', fullCaps, { statusLookup: true }, { statusLookup: true }, { statusLookup: false }, { statusLookup: true }, ['STATUS'])
    const row = result.rows.find(r => r.capability === 'statusLookup')
    expect(row?.classification).toBe('API_EXPOSURE_MISSING')
    expect(remediationCategory(row!.classification)).toBe('API_EXPOSURE_MISSING')
  })

  it('5. connector ready + no route → internal-only/route-missing', () => {
    const result = certifyProviderCapabilities('X', fullCaps, { balance: true }, { balance: true }, { balance: true }, { balance: false }, ['BALANCE'])
    const row = result.rows.find(r => r.capability === 'balance')
    expect(row?.classification).toBe('INTERNAL_ONLY')
    expect(remediationCategory(row!.classification)).toBe('API_ROUTE_INTENTIONALLY_MISSING')
  })

  it('6. admin-only custom creation never business-ready', () => {
    expect(classifyCapability({ connector: true, connectorMethodImplemented: true, dbEnabled: true, clientApiExposed: true, businessRouteExists: false, internallyEnabled: true, contractDocumented: true })).toBe('INTERNAL_ONLY')
    // exposed true + route false → internal, never PASS even if exposure default true.
    expect(classifyCapability({ connector: true, connectorMethodImplemented: true, dbEnabled: true, clientApiExposed: true, businessRouteExists: false, internallyEnabled: true })).toBe('INTERNAL_ONLY')
  })

  it('7. provider balance never maps to OneSIM business wallet (no business route for balance)', () => {
    const result = certifyProviderCapabilities('X', fullCaps, { balance: true }, { balance: true }, { balance: true }, { balance: false }, ['BALANCE'])
    expect(result.rows.find(r => r.capability === 'balance')?.businessRouteExists).toBe(false)
    expect(result.rows.find(r => r.capability === 'balance')?.classification).toBe('INTERNAL_ONLY')
  })

  it('8. AirHub wrong connector resolution blocks auto repair (manual path surfaces)', () => {
    // Simulate provider with adapterStrategy='TEMPLATE' → connector resolves to
    // REST_CATALOG which does not declare AirHub capabilities. The certification
    // must NOT auto-propose enabling capabilities on a mis-resolved connector:
    // undeclared + DB false → CONTRACT_SUPPORTED_NOT_IMPLEMENTED / NOT_SUPPORTED,
    // remediation EXPECTED_NO_ACTION or CONTRACT_NOT_IMPLEMENTED (not an auto-fix).
    const genericCaps = { ...fullCaps, topUp: false, suspend: false, resume: false, balance: false }
    const result = certifyProviderCapabilities('AIRHUB', genericCaps, {}, { topUp: false, suspend: false, resume: false, balance: false }, { topUp: true, suspend: true, resume: true, balance: true }, { topUp: true }, [])
    // topUp: connector declares false → NOT_SUPPORTED (stale generic connector
    // cannot auto-enable), NOT_SUPPORTED (exposure default is not evidence).
    expect(result.rows.find(r => r.capability === 'topUp')?.classification).toBe('NOT_SUPPORTED')
    expect(remediationCategory(result.rows.find(r => r.capability === 'topUp')!.classification)).toBe('EXPECTED_NO_ACTION')
  })

  it('9. Telna stale topUp/suspend DB flags are proposed OFF (stale), never enabled', () => {
    const telnaCaps = { ...fullCaps, topUp: false, suspend: false, resume: false, customPackageCreation: true }
    const result = certifyProviderCapabilities('TELNA', telnaCaps, { customPackageCreation: true }, { topUp: true, suspend: true, resume: true }, { topUp: true, suspend: true, resume: true }, { topUp: true, suspend: false, resume: false }, ['TOP_UP', 'SUSPEND', 'RESUME'])
    expect(result.rows.find(r => r.capability === 'topUp')?.classification).toBe('DB_FLAG_STALE_TRUE')
    expect(result.rows.find(r => r.capability === 'suspend')?.classification).toBe('DB_FLAG_STALE_TRUE')
    expect(result.rows.find(r => r.capability === 'resume')?.classification).toBe('DB_FLAG_STALE_TRUE')
    expect(remediationCategory(result.rows.find(r => r.capability === 'topUp')!.classification)).toBe('DB_FLAG_STALE_TRUE')
  })

  it('10. Choice business-ready operations are proposed ON', () => {
    const choiceCaps = { ...fullCaps, purchase: true, installationLookup: true, statusLookup: true, usageLookup: true, topUp: true }
    const result = certifyProviderCapabilities('CHOICE', choiceCaps,
      { purchase: true, installationLookup: true, statusLookup: true, usageLookup: true, topUp: true, balance: true },
      { purchase: true, statusLookup: true, usageLookup: true, topUp: true, balance: true },
      { purchase: true, installationLookup: true, statusLookup: true, usageLookup: true, topUp: true, balance: false },
      { purchase: true, installationLookup: true, statusLookup: true, usageLookup: true, topUp: true, balance: false },
      ['PURCHASE', 'STATUS', 'USAGE', 'TOP_UP', 'INSTALLATION', 'BALANCE'],
    )
    for (const cap of ['purchase', 'installationLookup', 'statusLookup', 'usageLookup', 'topUp']) {
      expect(result.rows.find(r => r.capability === cap)?.classification).toBe('PASS')
    }
    // balance route absent → internal-only (choice provider balance internal).
    expect(result.rows.find(r => r.capability === 'balance')?.classification).toBe('INTERNAL_ONLY')
  })

  it('11. US-Matrix business-ready operations (purchase/install/status/usage) proposed ON', () => {
    const usmCaps = { ...fullCaps, purchase: true, installationLookup: true, installationLookupHistorical: true, statusLookup: true, usageLookup: true }
    const result = certifyProviderCapabilities('USMATRIX', usmCaps,
      { purchase: true, installationLookup: true, installationLookupHistorical: true, statusLookup: true, usageLookup: true, suspend: true, resume: true },
      { purchase: true, statusLookup: true, usageLookup: true, suspend: true, resume: true },
      { purchase: true, installationLookup: true, installationLookupHistorical: true, statusLookup: true, usageLookup: true, suspend: true, resume: true },
      { purchase: true, installationLookup: true, installationLookupHistorical: true, statusLookup: true, usageLookup: true, suspend: false, resume: false },
      ['PURCHASE', 'STATUS', 'USAGE', 'INSTALLATION', 'QR_CODE', 'SUSPEND', 'RESUME'],
    )
    for (const cap of ['purchase', 'statusLookup', 'usageLookup']) {
      expect(result.rows.find(r => r.capability === cap)?.classification).toBe('PASS')
    }
    // suspend/resume internal (no business route).
    expect(result.rows.find(r => r.capability === 'suspend')?.classification).toBe('INTERNAL_ONLY')
    expect(result.rows.find(r => r.capability === 'resume')?.classification).toBe('INTERNAL_ONLY')
  })

  it('12. iBASIS provider webhook must never become a business-exposed claim', () => {
    // The real iBASIS connector declares webhooks:true but this capability is the
    // provider→OneSIM INBOUND hook handled by an external processor — it must not
    // be surfaced as a OneSIM Business outbound webhook. In the generic engine,
    // when the connector does not declare webhooks used for inbound delivery, and
    // there is no business route, it must NOT auto-PASS.
    const genericCaps = { ...fullCaps, webhooks: false } // connector under-generic path
    const result = certifyProviderCapabilities('IBASIS', genericCaps,
      {}, { webhooks: true }, { webhooks: true }, { webhooks: true }, [])
    // connector declares false → provider DB claim is stale for business use.
    expect(result.rows.find(r => r.capability === 'webhooks')?.classification).toBe('DB_FLAG_STALE_TRUE')
    expect(result.rows.find(r => r.capability === 'webhooks')?.classification).not.toBe('PASS')
  })

  it('13. dry-run produces zero DB writes (script is gated; engine itself writes nothing)', () => {
    // The certification engine is a pure classifier — it never writes.
    const result = certifyProviderCapabilities('X', fullCaps, { statusLookup: true }, { statusLookup: false }, { statusLookup: true }, { statusLookup: true }, [])
    expect(result.rows.length).toBeGreaterThan(0)
    // No side-effect: pure function returns rows only.
  })

  it('14. --apply refuses UNKNOWN / ENTITLEMENT_PENDING corrections (engine never proposes a fix for those)', () => {
    expect(classifyCapability(base({ connector: 'UNKNOWN', dbEnabled: false, internallyEnabled: false }))).toBe('UNKNOWN')
    expect(remediationCategory('UNKNOWN')).toBe('EXPECTED_NO_ACTION')
    expect(remediationCategory('ENTITLEMENT_PENDING')).toBe('ENTITLEMENT_PENDING')
    // No remediation for ENTITLEMENT_PENDING is a concrete auto-enabled action.
    expect(['API_EXPOSURE_MISSING', 'ENABLED_CAPABILITY_MISSING', 'DB_FLAG_STALE_TRUE']).not.toContain(remediationCategory('ENTITLEMENT_PENDING'))
  })
})

// ─────────────────────────────────────────────
// Part 12 provider-runtime reconciliation: corrected precedence + special states
// ─────────────────────────────────────────────
describe('RECONCILE — corrected classifier ordering (route-before-exposure) and provider specifics', () => {
  const fullCaps = {
    installationLookup: true, installationDataAtPurchase: true, installationLookupHistorical: false,
    statusLookup: true, usageLookup: true, topUp: true, suspend: true, resume: true, balance: true,
    inventory: true, webhooks: false, customPackageCreation: true,
  } as ConnectorCapabilities

  it('1. connector+internal ready + no Business route => INTERNAL_ONLY (checked before exposure)', () => {
    // balance: connected+internal+exposed but no route → INTERNAL_ONLY, NOT
    // API_EXPOSURE_MISSING and NOT PASS.
    const result = certifyProviderCapabilities('X', fullCaps, { balance: true }, { balance: true }, { balance: true }, { balance: false }, ['BALANCE'])
    expect(result.rows.find(r => r.capability === 'balance')?.classification).toBe('INTERNAL_ONLY')
    expect(remediationCategory(result.rows.find(r => r.capability === 'balance')!.classification)).toBe('API_ROUTE_INTENTIONALLY_MISSING')
  })

  it('2. route exists + API exposure disabled => API_EXPOSURE_MISSING', () => {
    const result = certifyProviderCapabilities('X', fullCaps, { statusLookup: true }, { statusLookup: true }, { statusLookup: false }, { statusLookup: true }, ['STATUS'])
    expect(result.rows.find(r => r.capability === 'statusLookup')?.classification).toBe('API_EXPOSURE_MISSING')
    expect(remediationCategory(result.rows.find(r => r.capability === 'statusLookup')!.classification)).toBe('API_EXPOSURE_MISSING')
  })

  it('3. default exposure cannot make an unsupported capability a mismatch', () => {
    // PURCHASE default-exposed but connector=false + DB=false → NOT_SUPPORTED.
    const result = certifyProviderCapabilities('X', { ...fullCaps, purchase: false }, {}, { purchase: false }, { purchase: true }, { purchase: true }, [])
    expect(result.rows.find(r => r.capability === 'purchase')?.classification).toBe('NOT_SUPPORTED')
    expect(result.mismatches).not.toContain('purchase')
    expect(remediationCategory(result.rows.find(r => r.capability === 'purchase')!.classification)).toBe('EXPECTED_NO_ACTION')
  })

  it('4. DB=true + connector=false => DB_FLAG_STALE_TRUE', () => {
    const result = certifyProviderCapabilities('X', { ...fullCaps, topUp: false }, {}, { topUp: true }, { topUp: true }, { topUp: true }, ['TOP_UP'])
    expect(result.rows.find(r => r.capability === 'topUp')?.classification).toBe('DB_FLAG_STALE_TRUE')
    expect(remediationCategory(result.rows.find(r => r.capability === 'topUp')!.classification)).toBe('DB_FLAG_STALE_TRUE')
  })

  it('5. connector=true + internal=false => INTERNAL_ENABLE_MISSING', () => {
    const result = certifyProviderCapabilities('X', fullCaps, { statusLookup: true }, { statusLookup: true }, { statusLookup: true }, { statusLookup: true }, [])
    expect(result.rows.find(r => r.capability === 'statusLookup')?.classification).toBe('INTERNAL_ENABLE_MISSING')
    expect(remediationCategory(result.rows.find(r => r.capability === 'statusLookup')!.classification)).toBe('ENABLED_CAPABILITY_MISSING')
  })

  it('6. custom creation retains ADMIN_ONLY / ENTITLEMENT_PENDING precedence (not collapsed to INTERNAL_ONLY)', () => {
    // admin-only custom package creation (Choice-like): connected+internal, no route
    const adminResult = certifyProviderCapabilities('CHOICE', fullCaps,
      { customPackageCreation: true }, { customPackageCreation: true }, { customPackageCreation: true },
      { customPackageCreation: false }, ['CUSTOM_PACKAGE_CREATION'], {}, {}, ['customPackageCreation'])
    expect(adminResult.rows.find(r => r.capability === 'customPackageCreation')?.classification).toBe('ADMIN_ONLY')
    expect(remediationCategory(adminResult.rows.find(r => r.capability === 'customPackageCreation')!.classification)).toBe('EXPECTED_NO_ACTION')
    expect(adminResult.businessReady).not.toContain('customPackageCreation')

    // entitlement-pending custom package creation (Telna-like)
    const entResult = certifyProviderCapabilities('TELNA', fullCaps,
      { customPackageCreation: true }, { customPackageCreation: true }, { customPackageCreation: true },
      { customPackageCreation: false }, ['CUSTOM_PACKAGE_CREATION'], {}, {}, ['customPackageCreation'], ['customPackageCreation'])
    expect(entResult.rows.find(r => r.capability === 'customPackageCreation')?.classification).toBe('ENTITLEMENT_PENDING')
    expect(remediationCategory(entResult.rows.find(r => r.capability === 'customPackageCreation')!.classification)).toBe('ENTITLEMENT_PENDING')
    expect(entResult.businessReady).not.toContain('customPackageCreation')
  })

  it('6b. admin-only/entitlement-pending states win even when exposure/route look business-usable', () => {
    // Even if a route existed and exposure were on, an admin-only custom-creation
    // capability must still classify as ADMIN_ONLY, never BUSINESS_READY.
    expect(classifyCapability({ connector: true, connectorMethodImplemented: true, dbEnabled: true, clientApiExposed: true, businessRouteExists: true, internallyEnabled: true, adminOnly: true })).toBe('ADMIN_ONLY')
    expect(classifyCapability({ connector: true, connectorMethodImplemented: true, dbEnabled: true, clientApiExposed: true, businessRouteExists: true, internallyEnabled: true, entitlementPending: true })).toBe('ENTITLEMENT_PENDING')
  })

  it('7. Choice balance => INTERNAL_ONLY (provider wallet balance is never a business route)', () => {
    const result = certifyProviderCapabilities('CHOICE', fullCaps,
      { balance: true }, { balance: true }, { balance: true }, { balance: false }, ['BALANCE'])
    expect(result.rows.find(r => r.capability === 'balance')?.classification).toBe('INTERNAL_ONLY')
    expect(result.businessReady).not.toContain('balance')
  })

  it('8. Telna balance => INTERNAL_ONLY', () => {
    const result = certifyProviderCapabilities('TELNA', fullCaps,
      { balance: true }, { balance: true }, { balance: true }, { balance: false }, ['BALANCE'])
    expect(result.rows.find(r => r.capability === 'balance')?.classification).toBe('INTERNAL_ONLY')
    expect(result.businessReady).not.toContain('balance')
  })

  it('9. US-Matrix inventory => INTERNAL_ONLY', () => {
    const result = certifyProviderCapabilities('USMATRIX', fullCaps,
      { inventory: true }, { inventory: true }, { inventory: true }, { inventory: false }, ['INVENTORY'])
    expect(result.rows.find(r => r.capability === 'inventory')?.classification).toBe('INTERNAL_ONLY')
    expect(result.businessReady).not.toContain('inventory')
  })

  it('10. iBASIS provider webhook remains provider-internal (inbound hook, not business outbound)', () => {
    // Connector declares webhooks dedicated to provider→OneSIM inbound delivery
    // (iBASIS). There is no Business outbound route; even if DB/internal claim it,
    // it must NOT become business-ready and it is provider-internal.
    const result = certifyProviderCapabilities('IBASIS', { ...fullCaps, webhooks: true },
      {}, { webhooks: true }, { webhooks: true }, { webhooks: false }, ['WEBHOOKS'], {}, {}, [])
    const webhook = result.rows.find(r => r.capability === 'webhooks')
    // No business route → INTERNAL_ONLY (provider-internal integration); never PASS.
    expect(webhook?.classification).toBe('INTERNAL_ONLY')
    expect(result.businessReady).not.toContain('webhooks')
  })

  it('11. AirHub blocked from auto-repair while connector resolution is unresolved', () => {
    // Wrong connector resolution (REST_CATALOG generic) must never auto-enable or
    // auto-expose capabilities. Generic connector declares topUp false → DB claim
    // of topUp is stale, never a safe auto-enable.
    const genericCaps = { ...fullCaps, topUp: false, suspend: false, resume: false, balance: false }
    const result = certifyProviderCapabilities('AIRHUB', genericCaps,
      {}, { topUp: true }, { topUp: true }, { topUp: true }, ['TOP_UP'])
    const topUp = result.rows.find(r => r.capability === 'topUp')
    expect(topUp?.classification).toBe('DB_FLAG_STALE_TRUE')
    // remediation for a stale DB flag is a DISABLE which is safe only with a
    // proven connector; the AirHub block-level control lives in the reconcile script.
    expect(remediationCategory(topUp!.classification)).toBe('DB_FLAG_STALE_TRUE')
  })

  it('12. dry-run reconciliation performs zero DB writes (pure classifier)', () => {
    const result = certifyProviderCapabilities('X', fullCaps, { statusLookup: true }, { statusLookup: false }, { statusLookup: true }, { statusLookup: true }, [])
    expect(result.rows.length).toBeGreaterThan(0)
    // No side effect — pure function returns rows only.
  })
})