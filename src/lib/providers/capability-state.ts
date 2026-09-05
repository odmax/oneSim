import { prisma } from '@/lib/prisma'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import { DEFAULT_CONNECTOR_CAPABILITIES, type ConnectorCapabilities } from '@/lib/providers/connectors/connector-interface'
import { ProviderCapability } from '@/lib/providers/capabilities/types'
import { DEFAULT_PROVIDER_CAPABILITIES } from '@/lib/providers/capabilities/defaults'
import { isCapabilityExposedToPortal, isCapabilityExposedToApi } from '@/lib/providers/capabilities/exposure'
import { providerSupports } from '@/lib/providers/capabilities/registry'

/** Minimal shape a gate needs from a provider record. */
export type GateProviderLike = {
  id: string
  code?: string | null
  enabledCapabilities?: unknown
}

/** Minimal connector surface with a declared capability map (implementation truth). */
export interface GateConnectorLike {
  capabilities?: Partial<ConnectorCapabilities>
}

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
 * `PURCHASE` resolves via the connector's explicit `purchase` declaration with
 * legacy fallback to `installationDataAtPurchase` (see
 * resolveRegistryImplementation) — support and install-data delivery are
 * separate concerns and must never be conflated.
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
  { key: 'CATALOG_SYNC', label: 'Catalog Sync', category: 'Catalog', connectorKey: 'catalogSync' },
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
 * Resolve a connector capability's implementation state for a registry entry.
 *
 * PURCHASE is special: its implementation truth is the connector's explicit
 * `purchase` declaration when present, falling back to the legacy
 * `installationDataAtPurchase` key for connectors that predate the split.
 * This keeps "wired purchase path" separate from "returns install data in the
 * purchase response" — some providers complete purchases whose install data
 * only arrives later via installation/status lookup. Provider-neutral: no
 * provider-code branching; every connector expresses this through the same
 * generic capability keys.
 */
export function resolveRegistryImplementation(
  entry: { key: string; connectorKey: keyof ConnectorCapabilities },
  caps: ConnectorCapabilities,
): CapabilityImplementation {
  if (entry.key === 'PURCHASE') {
    return connectorValueToImplementation(caps.purchase ?? caps.installationDataAtPurchase)
  }
  return connectorValueToImplementation(caps[entry.connectorKey])
}

/**
 * Resolve a provider's effective enabled-capability list with NULL/EMPTY
 * distinction (see §4 guardrail):
 *   - null / undefined  → "not configured" → use DEFAULT_PROVIDER_CAPABILITIES[code].
 *   - a PRESENT array (including []) → "explicitly configured" → used EXACTLY,
 *     with ONE legacy carve-out: CATALOG_SYNC is a canonical connector capability
 *     that legacy provider arrays (provisioned before the token existed) never
 *     mention. Such non-empty arrays that omit CATALOG_SYNC are treated as
 *     predating the token — when the documented defaults include it, it stays
 *     enabled. An explicit empty array remains a hard disable for everything.
 *   - a MAP overlay → the canonical writer's per-key form
 *     (e.g. `{ CATALOG_SYNC: { enabled: false } }`): keys with `enabled:true` or
 *     string values are forced on, keys with `enabled:false` are forced off,
 *     everything else falls back to the documented defaults. This is the ONLY way
 *     an operator can reliably disable a default-enabled capability like
 *     CATALOG_SYNC (an array can neither express it nor survive legacy re-expansion).
 * An explicit empty array must never be re-expanded to the defaults — this is
 * what lets an operator reliably disable a default capability.
 * A non-array, non-map value (malformed JSON) degrades to the defaults conservatively.
 */
export function resolveEnabledCapabilities(raw: unknown, providerCode: string): string[] {
  const defaults = (DEFAULT_PROVIDER_CAPABILITIES[providerCode] || []) as unknown as string[]
  if (raw === null || raw === undefined) {
    return defaults
  }
  if (Array.isArray(raw)) {
    const caps = raw.map(String)
    // Legacy CATALOG_SYNC compatibility: a NON-EMPTY explicit array that predates
    // the token (omits CATALOG_SYNC) must not silently disable canonical catalog
    // sync when the documented defaults include it. Connector truth then decides.
    if (caps.length > 0 && !caps.includes('CATALOG_SYNC') && defaults.includes('CATALOG_SYNC')) {
      caps.push('CATALOG_SYNC')
    }
    return caps
  }
  if (raw && typeof raw === 'object') {
    // MAP overlay: per-key explicit enable/disable over the documented defaults.
    const result = new Set<string>(defaults)
    for (const [key, value] of Object.entries(raw)) {
      if (value && typeof value === 'object') {
        if ((value as { enabled?: boolean }).enabled) result.add(key)
        else result.delete(key)
      } else if (typeof value === 'string') {
        result.add(value)
      }
    }
    return Array.from(result)
  }
  return defaults
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
    const impl = resolveRegistryImplementation(entry, caps)
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

/**
 * Canonical support gate for a connector-backed capability (e.g. CATALOG_SYNC).
 *
 * This is the source of truth for the "Sync Plans" UI + action gates. Unlike the
 * purely record-driven `providerSupports`, it lets the resolved connector's
 * capability declaration win over a stale explicit provider capability array
 * (e.g. a legacy iBASIS record provisioned with PLAN_SYNC but no CATALOG_SYNC),
 * so no DB migration or operator re-save is required for connector truth to apply.
 *
 * Rules (provider-neutral — never branches on provider.code):
 *   - Look the capability up in the canonical registry. If it has no connector
 *     mapping, fall back to the legacy record-driven `providerSupports`.
 *   - Resolve the provider's connector over the passed-in record; when the record
 *     cannot build a connector (missing config / unknown strategy), fall back to
 *     `providerSupports` so behavior is unchanged for connectors that must not
 *     under-declare their capabilities.
 *   - Genuine support requires BOTH connector implementation truth
 *     (`SUPPORTED`) AND the provider record allowing the capability
 *     (resolved via `resolveEnabledCapabilities`, honoring the explicit-array
 *     contract — an explicit [] is a hard disable).
 *
 * Takes the already-fetched provider record so callers avoid a redundant read.
 */
export async function providerSupportsConnectorCapability(
  provider: GateProviderLike | null | undefined,
  entryKey: string,
): Promise<boolean> {
  if (!provider) return false
  const entry = CAPABILITY_REGISTRY.find(e => e.key === entryKey)
  // Capability is not connector-driven — fall back to legacy record semantics.
  if (!entry) return providerSupports(provider as never, entryKey as never)

  // Long-circuit when the record does not allow the capability at all, honoring
  // the explicit-array contract (an explicit [] disables the default capability).
  const providerCode = provider.code || ''
  const effectiveCaps = resolveEnabledCapabilities(provider.enabledCapabilities, providerCode)
  if (!effectiveCaps.includes(entryKey)) return false

  const connector = await buildConnectorFromProvider(provider.id).catch(() => null)
  const caps: ConnectorCapabilities = connector?.capabilities
    ? { ...DEFAULT_CONNECTOR_CAPABILITIES, ...connector.capabilities }
    : { ...DEFAULT_CONNECTOR_CAPABILITIES }
  const impl = resolveRegistryImplementation(entry, caps)
  // Connector truth wins. A connector that fails to build falls back to legacy
  // record semantics (providerSupports) so behavior is unchanged there.
  if (impl === 'SUPPORTED') return true
  if (connector) return false
  return providerSupports(provider as never, entryKey as never)
}

/** Async-friendly alias so the record is fetched by id when a provider object is not already in hand. */
export async function providerSupportsConnectorCapabilityById(
  providerId: string,
  entryKey: string,
): Promise<boolean> {
  const provider = await prisma.provider.findUnique({ where: { id: providerId } })
  if (!provider) return false
  return providerSupportsConnectorCapability(provider, entryKey)
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
