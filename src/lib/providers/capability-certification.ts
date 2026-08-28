import type { ConnectorCapabilities } from '@/lib/providers/connectors/connector-interface'
import { ProviderCapability } from '@/lib/providers/capabilities/types'

/**
 * Capability certification classification. A capability is BUSINESS_READY only
 * when every layer (contract/connector + DB internal enable + API exposure +
 * endpoint availability) is green. UNKNOWN is preferred over falsely claiming
 * SUPPORTED or NOT_SUPPORTED.
 */
export type CapabilityCertification =
  | 'PASS'   // every layer green, route present, client-exposed
  | 'INTERNAL_ONLY' // connector+internal ok but not client-exposed
  | 'NOT_EXPOSED' // internal ok but portal/api exposure off
  | 'NOT_IMPLEMENTED' // contract may exist but connector has no method
  | 'NOT_SUPPORTED' // explicit evidence against it
  | 'UNKNOWN' // no verified evidence either way
  | 'ENTITLEMENT_PENDING' // supported+implemented but gated (e.g. Telna account)
  | 'DOC_MISMATCH' // connector declares X but DB/route disagrees
  | 'CONFIG_MISMATCH' // DB says X but connector does not implement
  | 'API_ROUTE_MISSING' // capability exists but no Business API route

export interface CertificationLayerInput {
  /** Runtime truth from the connector (or undefined when not declared). */
  connector: boolean | 'UNKNOWN' | undefined
  /** Whether the connector implements the operation method(s). */
  connectorMethodImplemented: boolean
  /** Provider DB/internal enable flag. */
  dbEnabled: boolean | null
  /** Whether the capability is exposed to the Business API (clientApiEnabled). */
  clientApiExposed: boolean
  /** Whether a Business V1 route exists that exercises this capability. */
  businessRouteExists: boolean
  /** Internal enable via provider.enabledCapabilities registry (e.g. PURCHASE). */
  internallyEnabled: boolean
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
}

/**
 * Classify one capability against the full layer chain. Provider-neutral.
 */
export function classifyCapability(input: CertificationLayerInput): CapabilityCertification {
  const { connector, connectorMethodImplemented, dbEnabled, clientApiExposed, businessRouteExists, internallyEnabled } = input

  // Connector truth first.
  const connectorTruth: boolean | 'UNKNOWN' | undefined = connector
  if (connectorTruth === false) {
    // Explicitly unsupported by connector. If DB/internal/exposure claims it,
    // that is a CONFIG_MISMATCH — exposure must never resurrect it.
    return (dbEnabled === true || internallyEnabled || clientApiExposed)
      ? 'CONFIG_MISMATCH'
      : 'NOT_SUPPORTED'
  }
  if (connectorTruth === 'UNKNOWN') {
    return (dbEnabled === true || internallyEnabled || clientApiExposed)
      ? 'DOC_MISMATCH' // claiming support without verified connector truth
      : 'UNKNOWN'
  }
  if (connectorTruth === undefined) {
    // Not declared. Absence is NOT support. If DB/exposure claim it → mismatch.
    return (dbEnabled === true || internallyEnabled || clientApiExposed)
      ? 'DOC_MISMATCH'
      : 'NOT_IMPLEMENTED'
  }

  // Connector declares true but method not implemented → NOT_IMPLEMENTED.
  if (connectorTruth === true && !connectorMethodImplemented) {
    return 'NOT_IMPLEMENTED'
  }

  // Connector supports it. Now internal layer.
  if (!internallyEnabled) {
    return dbEnabled === true ? 'INTERNAL_ONLY' : 'NOT_EXPOSED'
  }

  // Client API exposure OFF → INTERNAL_ONLY / NOT_EXPOSED.
  if (!clientApiExposed) {
    return 'NOT_EXPOSED'
  }

  // Exposure on but no Business route → API_ROUTE_MISSING.
  if (!businessRouteExists) {
    return 'API_ROUTE_MISSING'
  }

  return 'PASS'
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
    })

    if (classification === 'PASS') businessReady.push(capKey)
    if (classification === 'INTERNAL_ONLY' || classification === 'NOT_EXPOSED') internalOnly.push(capKey)
    if (classification === 'DOC_MISMATCH' || classification === 'CONFIG_MISMATCH' || classification === 'API_ROUTE_MISSING') mismatches.push(capKey)
  }

  return { rows, businessReady, internalOnly, mismatches }
}