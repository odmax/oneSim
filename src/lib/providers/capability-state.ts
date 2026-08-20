import { prisma } from '@/lib/prisma'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import { DEFAULT_CONNECTOR_CAPABILITIES, type ConnectorCapabilities } from '@/lib/providers/connectors/connector-interface'
import { ProviderCapability } from '@/lib/providers/capabilities/types'
import { DEFAULT_PROVIDER_CAPABILITIES } from '@/lib/providers/capabilities/defaults'
import { isCapabilityExposedToPortal, isCapabilityExposedToApi } from '@/lib/providers/capabilities/exposure'

export type CapabilityImplementation = 'SUPPORTED' | 'NOT_IMPLEMENTED' | 'NOT_SUPPORTED' | 'UNKNOWN'
export type CapabilitySource = 'CONNECTOR' | 'TEMPLATE' | 'DEFAULT' | 'PROVIDER_OVERRIDE'

/**
 * Canonical per-capability state for a provider. Separates three concepts:
 *   - implementationState : what the connector ACTUALLY implements (runtime truth)
 *   - enabled             : whether this provider instance allows it
 *   - portalExposed/apiExposed : client exposure
 * The `effective` state is enabled = implementation supported AND provider allows.
 */
export interface ProviderCapabilityState {
  capability: string
  label: string
  category: string
  implementationState: CapabilityImplementation
  enabled: boolean
  portalExposed: boolean
  apiExposed: boolean
  source: CapabilitySource
}

export interface ProviderCapabilityStateResult {
  providerId: string
  connectorClass: string | null
  states: ProviderCapabilityState[]
  byKey: Record<string, ProviderCapabilityState>
}

/**
 * Canonical registry of logical OneSIM capabilities → connector capability key,
 * label, and category. The connector remains the implementation truth; this
 * registry only describes how to surface each capability in management UI.
 *
 * `PURCHASE` maps to the connector's `installationDataAtPurchase` capability:
 * a connector that returns install data at purchase has an implemented
 * `activateESIM` path. (A connector that implements purchase without install
 * data is not expressible in ConnectorCapabilities today; in that case the
 * provider's DEFAULT/enabled PURCHASE flag is used for `enabled`.)
 */
export const CAPABILITY_REGISTRY: Array<{
  key: string
  label: string
  category: string
  connectorKey: keyof ConnectorCapabilities
}> = [
  { key: 'PURCHASE', label: 'Purchase', category: 'Purchase', connectorKey: 'installationDataAtPurchase' },
  { key: 'INSTALLATION_DATA_AT_PURCHASE', label: 'Installation Data at Purchase', category: 'Installation', connectorKey: 'installationDataAtPurchase' },
  { key: 'INSTALLATION_LOOKUP_HISTORICAL', label: 'Historical Installation Lookup', category: 'Installation', connectorKey: 'installationLookupHistorical' },
  { key: 'INSTALLATION_LOOKUP', label: 'Installation Lookup', category: 'Installation', connectorKey: 'installationLookup' },
  { key: 'STATUS', label: 'Status', category: 'Lifecycle', connectorKey: 'statusLookup' },
  { key: 'USAGE', label: 'Usage', category: 'Lifecycle', connectorKey: 'usageLookup' },
  { key: 'SUSPEND', label: 'Suspend', category: 'Lifecycle', connectorKey: 'suspend' },
  { key: 'RESUME', label: 'Resume', category: 'Lifecycle', connectorKey: 'resume' },
  { key: 'TOP_UP', label: 'Top-Up', category: 'Lifecycle', connectorKey: 'topUp' },
  { key: 'BALANCE', label: 'Balance', category: 'Billing', connectorKey: 'balance' },
  { key: 'INVENTORY', label: 'Inventory', category: 'Catalog', connectorKey: 'inventory' },
  { key: 'WEBHOOKS', label: 'Webhooks', category: 'Integration', connectorKey: 'webhooks' },
  { key: 'CUSTOM_PACKAGE_CREATION', label: 'Custom Package Creation', category: 'Catalog', connectorKey: 'customPackageCreation' },
]

const CATEGORY_ORDER: Record<string, number> = {
  Purchase: 0,
  Installation: 1,
  Lifecycle: 2,
  Catalog: 3,
  Billing: 4,
  Integration: 5,
}

/** Classify a connector-declared capability value into a CapabilityImplementation. */
export function connectorValueToImplementation(value: boolean | 'UNKNOWN' | undefined): CapabilityImplementation {
  if (value === true) return 'SUPPORTED'
  if (value === false) return 'NOT_SUPPORTED'
  if (value === 'UNKNOWN') return 'UNKNOWN'
  return 'NOT_IMPLEMENTED'
}

/**
 * Resolve a provider's effective enabled-capability list with NULL/EMPTY
 * distinction (see §4 guardrail):
 *   - null / undefined  → "not configured" → use DEFAULT_PROVIDER_CAPABILITIES[code].
 *   - a PRESENT array (including []) → "explicitly configured" → used EXACTLY.
 * An explicit empty array therefore means "no capabilities enabled" and must
 * never be re-expanded to the defaults — this is what lets an operator reliably
 * disable a default capability.
 * A non-array value (malformed JSON) degrades to the defaults conservatively.
 */
export function resolveEnabledCapabilities(raw: unknown, providerCode: string): string[] {
  if (raw === null || raw === undefined) {
    return (DEFAULT_PROVIDER_CAPABILITIES[providerCode] || []) as unknown as string[]
  }
  if (Array.isArray(raw)) return raw.map(String)
  return (DEFAULT_PROVIDER_CAPABILITIES[providerCode] || []) as unknown as string[]
}

/**
 * Canonical capability resolver for a provider.
 *
 * Flow: provider → adapterStrategy → resolved connector → connector.capabilities
 * (implementation truth). Enabled = provider.enabledCapabilities (falling back to
 * DEFAULT_PROVIDER_CAPABILITIES[code]) AND connector SUPPORTED. Exposure is read
 * separately per capability.
 *
 * Provider-neutral: never branches on provider.code.
 */
export async function getProviderCapabilityState(providerId: string): Promise<ProviderCapabilityStateResult | null> {
  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return null

  const connector = await buildConnectorFromProvider(provider.id).catch(() => null)
  const connectorClass = connector ? connector.constructor.name : null
  const caps: ConnectorCapabilities = connector?.capabilities
    ? { ...DEFAULT_CONNECTOR_CAPABILITIES, ...connector.capabilities }
    : { ...DEFAULT_CONNECTOR_CAPABILITIES }

  const providerCode = provider.code || ''
  // null/undefined → "unconfigured, use documented defaults".
  // a present array (including []) → "explicitly configured", used EXACTLY so an
  // explicit disable is never silently re-enabled by the defaults fallback.
  const effectiveCaps = resolveEnabledCapabilities(provider.enabledCapabilities, providerCode)
  const defaultCaps: string[] = (DEFAULT_PROVIDER_CAPABILITIES[providerCode] || []) as unknown as string[]
  const allowed = (cap: string): boolean => effectiveCaps.includes(cap)

  const states: ProviderCapabilityState[] = []
  const byKey: Record<string, ProviderCapabilityState> = {}

  for (const entry of CAPABILITY_REGISTRY) {
    const impl = connectorValueToImplementation(caps[entry.connectorKey])
    // Exposure lookup falls back gracefully for non-enum keys; unknown keys
    // resolve to the DEFAULT_EXPOSED_CAPABILITIES set membership (false).
    const exposureKey = entry.key as ProviderCapability
    const [portal, api] = await Promise.all([
      isCapabilityExposedToPortal(providerId, exposureKey as ProviderCapability).catch(() => false),
      isCapabilityExposedToApi(providerId, exposureKey as ProviderCapability).catch(() => false),
    ])

    // enabled = provider allows it AND connector implements it.
    const enabled = allowed(entry.key) && impl === 'SUPPORTED'
    const source: CapabilitySource = connectorClass ? 'CONNECTOR' : 'DEFAULT'

    const state: ProviderCapabilityState = {
      capability: entry.key,
      label: entry.label,
      category: entry.category,
      implementationState: impl,
      enabled,
      portalExposed: portal,
      apiExposed: api,
      source,
    }
    states.push(state)
    byKey[entry.key] = state
  }

  // Sort by category then label for stable UI presentation.
  states.sort((a, b) => (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9) || a.label.localeCompare(b.label))

  return { providerId, connectorClass, states, byKey }
}

export interface CustomPackageCreationReadiness {
  ready: boolean
  reason?: string
}

const OPERATIONAL_PROVIDER_STATUSES = ['ACTIVE', 'DEGRADED', 'TESTING']

/**
 * Provider-neutral runtime readiness for provider-side custom package/template
 * creation (e.g. Telna POST /v2.1/pcr/package-templates).
 *
 * A provider is READY only when ALL hold:
 *   1. connector genuinely supports customPackageCreation (implementation truth,
 *      never true merely because an endpoint exists), AND
 *   2. provider is operational (ACTIVE/DEGRADED/TESTING), AND
 *   3. the provider has been explicitly enabled for CUSTOM_PACKAGE_CREATION via
 *      `provider.enabledCapabilities` (falling back to the documented defaults,
 *      which exclude it — so the default state is disabled).
 *
 * Default is DISABLED (readiness=false) unless explicitly enabled. Provider-neutral:
 * never branches on provider.code. Callers must re-check this server-side before
 * invoking the connector's mutating method; never trust the browser.
 */
export async function getCustomPackageCreationReadiness(providerId: string): Promise<CustomPackageCreationReadiness> {
  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return { ready: false, reason: 'provider-not-found' }

  const providerStatus = String(provider.status || '').toUpperCase()
  if (!OPERATIONAL_PROVIDER_STATUSES.includes(providerStatus)) {
    return { ready: false, reason: `provider-not-operational:${providerStatus || 'UNKNOWN'}` }
  }

  const connector = await buildConnectorFromProvider(provider.id).catch(() => null)
  const caps: ConnectorCapabilities = connector?.capabilities
    ? { ...DEFAULT_CONNECTOR_CAPABILITIES, ...connector.capabilities }
    : { ...DEFAULT_CONNECTOR_CAPABILITIES }
  if (caps.customPackageCreation !== true) {
    return { ready: false, reason: 'connector-does-not-support' }
  }

  const effectiveCaps = resolveEnabledCapabilities(provider.enabledCapabilities, provider.code || '')
  const allowed = effectiveCaps.includes('CUSTOM_PACKAGE_CREATION')
  if (!allowed) {
    return { ready: false, reason: 'account-not-enabled' }
  }

  return { ready: true }
}
