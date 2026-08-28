import type { ConnectorCapabilities } from '@/lib/providers/connectors/connector-interface'
import { ProviderCapability } from '@/lib/providers/capabilities/types'

/**
 * Capability certification classification. A capability is BUSINESS_READY only
 * when every layer (contract/connector + DB internal enable + API exposure +
 * endpoint availability) is green. UNKNOWN is preferred over falsely claiming
 * SUPPORTED or NOT_SUPPORTED.
 *
 * IMPORTANT SEMANTIC INVARIANT: `clientApiExposed` (which can be true via a
 * DEFAULT exposure policy for a whole capability family) is NEVER evidence that
 * a capability is actually supported. A provider-side DB flag (`dbEnabled`) or
 * a registry enabled-capability (`internallyEnabled`) is the only provider-side
 * claim of enablement. Exposure is a permission gate, not a support claim.
 */
export type CapabilityCertification =
  | 'PASS'   // every layer green, route present, client-exposed
  | 'INTERNAL_ONLY' // connector+internal ok but intentionally not a Business route
  | 'API_ROUTE_INTENTIONALLY_MISSING' // connector+internal ok, no Business route, and none intended
  | 'NOT_EXPOSED' // connector+internal ok but API exposure off (and a route exists)
  | 'API_EXPOSURE_MISSING' // connector+internal+route ready but clientApiEnabled off
  | 'NOT_IMPLEMENTED' // contract may exist but connector has no method
  | 'NOT_SUPPORTED' // explicit evidence against it (connector false + no DB/internal claim)
  | 'UNKNOWN' // no verified evidence either way
  | 'ENTITLEMENT_PENDING' // supported+implemented but gated (e.g. Telna account)
  | 'ADMIN_ONLY' // supported+implemented but admin-only, never business-exposed (e.g. custom package creation)
  | 'CONTRACT_SUPPORTED_NOT_IMPLEMENTED' // provider contract documents it but connector lacks impl
  | 'DOC_MISMATCH' // connector declares X but provider DB/registry suggests otherwise
  | 'CONFIG_MISMATCH' // DB/internal says X but connector explicitly does not implement it
  | 'DB_FLAG_STALE_TRUE' // provider DB/internal enable is true but connector does not support it
  | 'INTERNAL_ENABLE_MISSING' // connector+contract support it but provider DB/internal enable is off
  | 'API_ROUTE_MISSING' // capability exists but no Business API route yet

export interface CertificationLayerInput {
  /** Runtime truth from the connector (or undefined when not declared). */
  connector: boolean | 'UNKNOWN' | undefined
  /** Whether the connector implements the operation method(s). */
  connectorMethodImplemented: boolean
  /** Provider DB/internal enable flag (supports* boolean). */
  dbEnabled: boolean | null
  /** Whether the capability is exposed to the Business API (clientApiEnabled). */
  clientApiExposed: boolean
  /** Whether a Business V1 route exists that exercises this capability. */
  businessRouteExists: boolean
  /** Internal enable via provider.enabledCapabilities registry (e.g. PURCHASE). */
  internallyEnabled: boolean
  /** Explicit upstream contract documentation of this operation. */
  contractDocumented?: boolean
  /** Capability is admin-only (e.g. custom package creation): never business-exposed. */
  adminOnly?: boolean
  /** Capability is entitlement/account-gated (e.g. Telna custom package): pending certification. */
  entitlementPending?: boolean
  /** Free-form note (safe only). */
  note?: string
}

export interface CertificationRow {
  capability: string
  contractSupports: boolean | 'UNKNOWN' | 'NOT_DECLARED'
  connectorImplements: boolean
  dbEnabled: boolean | null
  internallyEnabled: boolean
  clientApiExposed: boolean
  businessRouteExists: boolean
  classification: CapabilityCertification
  remediation?: string
}

/**
 * Classify one capability against the full layer chain. Provider-neutral.
 *
 * Correct semantics:
 *  - exposure (clientApiExposed) is NEVER support evidence.
 *  - connector=false + DB/internal false → NOT_SUPPORTED (even if default
 *    exposure policy is true).
 *  - connector=false + DB/internal true → DB_FLAG_STALE_TRUE (stale enable).
 *  - connector=true + contract true + DB/internal missing → INTERNAL_ENABLE_MISSING.
 *  - connector+internal ready + route exists + exposure off → API_EXPOSURE_MISSING.
 *  - connector+internal ready + no route → INTERNAL_ONLY / API_ROUTE_INTENTIONALLY_MISSING.
 *  - admin-only capabilities (customPackageCreation) never reach BUSINESS_READY.
 */
export function classifyCapability(input: CertificationLayerInput): CapabilityCertification {
  const { connector, connectorMethodImplemented, dbEnabled, clientApiExposed, businessRouteExists, internallyEnabled, contractDocumented = true, adminOnly = false, entitlementPending = false } = input

  // Provider-side enable claims (the ONLY support evidence besides connector).
  const providerClaimsSupport = dbEnabled === true || internallyEnabled === true

  if (connector === false) {
    // Explicit connector NOT_SUPPORTED. Exposure must NEVER resurrect it.
    // Remove exposure entirely from this decision.
    return providerClaimsSupport
      ? 'DB_FLAG_STALE_TRUE'
      : 'NOT_SUPPORTED'
  }

  if (connector === 'UNKNOWN') {
    return providerClaimsSupport
      ? 'DOC_MISMATCH'  // claiming support without connector truth
      : 'UNKNOWN'
  }

  if (connector === undefined) {
    // Not declared. Absence is NOT support. DB/registry claim ≠ connector impl.
    if (providerClaimsSupport) return 'DOC_MISMATCH'
    // Contract documented but connector never declares it → contract-not-implemented.
    if (!contractDocumented) return 'NOT_SUPPORTED'
    return 'CONTRACT_SUPPORTED_NOT_IMPLEMENTED'
  }

  // Connector declares true but method not implemented.
  if (connector === true && !connectorMethodImplemented) {
    return 'NOT_IMPLEMENTED'
  }

  // Connector supports + implements. Now internal layer.
  if (!internallyEnabled) {
    // Provider registry not enabled. If DB flag is true but registry missing →
    // INTERNAL_ENABLE_MISSING (registry is the gate). If neither → still missing.
    return 'INTERNAL_ENABLE_MISSING'
  }

  // Connector + internal ready.
  // Explicit special states (admin-only / entitlement-gated) win FIRST over the
  // generic INTERNAL_ONLY collapse. CUSTOM_PACKAGE_CREATION must NOT be collapsed
  // into generic INTERNAL_ONLY when it is ADMIN_ONLY or ENTITLEMENT_PENDING, and
  // they must never reach BUSINESS_READY.
  if (entitlementPending) return 'ENTITLEMENT_PENDING'
  if (adminOnly) return 'ADMIN_ONLY'

  // A capability with NO Business route is internal-only regardless of exposure
  // (there is nowhere to expose it). Check this before the exposure gate.
  if (!businessRouteExists) {
    return 'INTERNAL_ONLY'
  }

  // Route exists but client API exposure off → API_EXPOSURE_MISSING.
  if (!clientApiExposed) {
    return 'API_EXPOSURE_MISSING'
  }

  return 'PASS'
}

/**
 * Map a certification to the reconciliation remediation category used by the
 * reconciliation plan (dry-run default).
 */
export function remediationCategory(classification: CapabilityCertification): string {
  switch (classification) {
    case 'PASS': return 'EXPECTED_NO_ACTION'
    case 'INTERNAL_ONLY':
    case 'API_ROUTE_INTENTIONALLY_MISSING': return 'API_ROUTE_INTENTIONALLY_MISSING'
    case 'NOT_EXPOSED':
    case 'API_EXPOSURE_MISSING': return 'API_EXPOSURE_MISSING'
    case 'INTERNAL_ENABLE_MISSING': return 'ENABLED_CAPABILITY_MISSING'
    case 'DB_FLAG_STALE_TRUE': return 'DB_FLAG_STALE_TRUE'
    case 'CONFIG_MISMATCH': return 'CONNECTOR_CAPABILITY_WRONG'
    case 'DOC_MISMATCH': return 'CONNECTOR_CAPABILITY_WRONG'
    case 'CONTRACT_SUPPORTED_NOT_IMPLEMENTED': return 'CONTRACT_NOT_IMPLEMENTED'
    case 'ENTITLEMENT_PENDING': return 'ENTITLEMENT_PENDING'
    case 'ADMIN_ONLY': return 'EXPECTED_NO_ACTION'
    case 'NOT_SUPPORTED': return 'EXPECTED_NO_ACTION'
    case 'NOT_IMPLEMENTED': return 'CONTRACT_NOT_IMPLEMENTED'
    case 'UNKNOWN': return 'EXPECTED_NO_ACTION'
    case 'API_ROUTE_MISSING': return 'API_ROUTE_INTENTIONALLY_MISSING'
    default: return 'EXPECTED_NO_ACTION'
  }
}

export interface CapabilityCertificationResult {
  rows: CertificationRow[]
  businessReady: string[]
  internalOnly: string[]
  mismatches: string[]
}

/**
 * Build the full layered certification matrix for a single provider.
 */
export function certifyProviderCapabilities(
  providerCode: string,
  connectorCaps: ConnectorCapabilities,
  connectorMethodAvail: Partial<Record<keyof ConnectorCapabilities, boolean>>,
  dbFlags: Partial<Record<keyof ConnectorCapabilities, boolean | string | null>>,
  exposure: Partial<Record<keyof ConnectorCapabilities, boolean>>,
  businessRoutes: Partial<Record<keyof ConnectorCapabilities, boolean>>,
  internallyEnabledCaps: string[],
  notes: Partial<Record<string, string>> = {},
  contractDocuments: Partial<Record<keyof ConnectorCapabilities, boolean>> = {},
  adminOnlyCaps: string[] = [],
  entitlementPendingCaps: string[] = [],
): CapabilityCertificationResult {
  const keys: (keyof ConnectorCapabilities)[] = [
    'purchase', 'installationLookup', 'installationDataAtPurchase', 'installationLookupHistorical',
    'statusLookup', 'usageLookup', 'topUp', 'suspend', 'resume', 'balance', 'inventory', 'webhooks', 'customPackageCreation',
  ]

  const internallyEnabled = (capKey: keyof ConnectorCapabilities): boolean => {
    const map: Partial<Record<keyof ConnectorCapabilities, string>> = {
      purchase: ProviderCapability.PURCHASE,
      installationLookup: ProviderCapability.INSTALLATION,
      installationDataAtPurchase: ProviderCapability.INSTALLATION,
      installationLookupHistorical: ProviderCapability.QR_CODE,
      statusLookup: ProviderCapability.STATUS,
      usageLookup: ProviderCapability.USAGE,
      topUp: ProviderCapability.TOP_UP,
      suspend: ProviderCapability.SUSPEND,
      resume: ProviderCapability.RESUME,
      balance: ProviderCapability.BALANCE,
      inventory: ProviderCapability.INVENTORY,
      webhooks: ProviderCapability.WEBHOOKS,
      customPackageCreation: ProviderCapability.CUSTOM_PACKAGE_CREATION,
    }
    const key = map[capKey]
    return key ? internallyEnabledCaps.includes(key) : false
  }

  const rows: CertificationRow[] = []
  const businessReady: string[] = []
  const internalOnly: string[] = []
  const mismatches: string[] = []

  for (const capKey of keys) {
    const raw = capKey === 'purchase' ? connectorCaps.purchase ?? connectorCaps.installationDataAtPurchase : connectorCaps[capKey]
    const connectorTruth = raw === undefined ? undefined : raw
    const classification = classifyCapability({
      connector: connectorTruth,
      connectorMethodImplemented: connectorMethodAvail[capKey] !== false,
      dbEnabled: dbFlags[capKey] !== undefined ? Boolean(dbFlags[capKey]) : null,
      clientApiExposed: exposure[capKey] === true,
      businessRouteExists: businessRoutes[capKey] === true,
      internallyEnabled: internallyEnabled(capKey),
      contractDocumented: contractDocuments[capKey],
      adminOnly: adminOnlyCaps.includes(capKey),
      entitlementPending: entitlementPendingCaps.includes(capKey),
      note: notes[capKey],
    })

    rows.push({
      capability: capKey,
      contractSupports: connectorTruth === undefined ? 'NOT_DECLARED' : connectorTruth,
      connectorImplements: connectorMethodAvail[capKey] !== false,
      dbEnabled: dbFlags[capKey] !== undefined ? Boolean(dbFlags[capKey]) : null,
      internallyEnabled: internallyEnabled(capKey),
      clientApiExposed: exposure[capKey] === true,
      businessRouteExists: businessRoutes[capKey] === true,
      classification,
      remediation: remediationCategory(classification),
    })

    if (classification === 'PASS') businessReady.push(capKey)
    if (['INTERNAL_ONLY', 'NOT_EXPOSED', 'API_ROUTE_INTENTIONALLY_MISSING', 'ADMIN_ONLY', 'ENTITLEMENT_PENDING'].includes(classification)) internalOnly.push(capKey)
    if (['DOC_MISMATCH', 'CONFIG_MISMATCH', 'DB_FLAG_STALE_TRUE', 'INTERNAL_ENABLE_MISSING', 'API_EXPOSURE_MISSING', 'API_ROUTE_MISSING'].includes(classification)) mismatches.push(capKey)
  }

  return { rows, businessReady, internalOnly, mismatches }
}