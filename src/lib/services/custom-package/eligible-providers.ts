import { prisma } from '@/lib/prisma'
import { ProviderCapability } from '@/lib/providers/capabilities/types'
import { ProviderStatus } from '@prisma/client'
import { buildConnectorFromProvider } from '@/lib/providers/connectors/connector-factory'
import { DEFAULT_CONNECTOR_CAPABILITIES, type ConnectorCapabilities } from '@/lib/providers/connectors/connector-interface'
import { getCustomPackageCreationReadiness } from '@/lib/providers/capability-state'

export interface EligibleBackingProvider {
  id: string
  name: string
  code: string
  status: string
  adapterStrategy: string | null
  hasPurchaseCapability: boolean
  /** Whether the provider ALSO supports upstream creation (informational). */
  hasCustomPackageCreationCapability: boolean
  eligiblePackageCount: number
}

export interface EligibleUpstreamCreationProvider {
  id: string
  name: string
  code: string
  status: string
  adapterStrategy: string | null
  contractSupported: boolean
  implementationSupported: boolean
  accountEnabled: boolean
  oneSimExposure: boolean
  /** Non-blocking reason for the admin UI (e.g. account certification required). */
  gatedReason?: string
}

const OPERATIONAL_STATUSES: ProviderStatus[] = ['ACTIVE', 'DEGRADED', 'TESTING']
const ELIGIBLE_CONFIG_STATUSES = ['CONFIGURED', 'AUTO_CONFIGURED']
const ELIGIBLE_PUBLISH_STATUSES = ['PUBLISHED', 'READY']

function hasCapability(enabledCapabilities: unknown, cap: string): boolean {
  if (Array.isArray(enabledCapabilities)) {
    return enabledCapabilities.some(c => String(c).toUpperCase() === cap)
  }
  if (enabledCapabilities && typeof enabledCapabilities === 'object') {
    const obj = enabledCapabilities as Record<string, unknown>
    if (Array.isArray(obj.list)) {
      return (obj.list as unknown[]).some(c => String(c).toUpperCase() === cap)
    }
    if (Array.isArray(obj.capabilities)) {
      return (obj.capabilities as unknown[]).some(c => String(c).toUpperCase() === cap)
    }
  }
  return false
}

/**
 * MODE A — EXISTING_BACKINGS provider eligibility.
 *
 * A provider may back a OneSIM custom retail package when:
 *   - it is operational (ACTIVE / DEGRADED / TESTING), AND
 *   - it supports fulfillment/purchase (PURCHASE capability), AND
 *   - it owns at least one configured + purchase-ready ProviderPackage.
 *
 * It must NOT require CUSTOM_PACKAGE_CREATION: a provider like AirHub can back a
 * custom package even though it cannot author a brand-new upstream plan.
 *
 * Provider-neutral — never branches on provider.code.
 */
export async function getEligibleBackingProviders(): Promise<EligibleBackingProvider[]> {
  const providers = await prisma.provider.findMany({
    where: { status: { in: OPERATIONAL_STATUSES } },
    select: {
      id: true,
      name: true,
      code: true,
      status: true,
      adapterStrategy: true,
      enabledCapabilities: true,
    },
  })

  const result: EligibleBackingProvider[] = []
  for (const provider of providers) {
    const hasPurchase = hasCapability(provider.enabledCapabilities, ProviderCapability.PURCHASE)
    if (!hasPurchase) continue

    const eligiblePackageCount = await prisma.providerPackage.count({
      where: {
        providerId: provider.id,
        configurationStatus: { in: ELIGIBLE_CONFIG_STATUSES },
        publishStatus: { in: ELIGIBLE_PUBLISH_STATUSES },
        sellingPrice: { gt: 0 },
        costPrice: { gt: 0 },
      },
    })
    if (eligiblePackageCount === 0) continue

    result.push({
      id: provider.id,
      name: provider.name,
      code: provider.code,
      status: provider.status,
      adapterStrategy: provider.adapterStrategy,
      hasPurchaseCapability: true,
      hasCustomPackageCreationCapability: hasCapability(provider.enabledCapabilities, ProviderCapability.CUSTOM_PACKAGE_CREATION),
      eligiblePackageCount,
    })
  }

  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * MODE B — UPSTREAM_CREATE provider eligibility.
 *
 * A provider may author a NEW upstream package/template ONLY when the operation
 * is actually usable server-side. Derived from the runtime connector capability
 * profile (NOT a provider-name branch):
 *   - contractSupported     — the connector implements getCustomPackageDefinition()
 *   - implementationSupported — connector.capabilities.customPackageCreation === true
 *   - accountEnabled        — getCustomPackageCreationReadiness() says ready (i.e.
 *     the provider has been explicitly enabled via enabledCapabilities)
 *
 * oneSimExposure is always false for now; exposure is only informative.
 * Providers that are not fully usable are surfaced with a gatedReason so the UI
 * can show them disabled (never silently enabled).
 */
export async function getEligibleUpstreamCreationProviders(): Promise<EligibleUpstreamCreationProvider[]> {
  const providers = await prisma.provider.findMany({
    where: { status: { in: OPERATIONAL_STATUSES } },
    select: {
      id: true,
      name: true,
      code: true,
      status: true,
      adapterStrategy: true,
      enabledCapabilities: true,
    },
  })

  const result: EligibleUpstreamCreationProvider[] = []
  for (const provider of providers) {
    const connector = await buildConnectorFromProvider(provider.id).catch(() => null)
    const caps: ConnectorCapabilities = connector?.capabilities
      ? { ...DEFAULT_CONNECTOR_CAPABILITIES, ...connector.capabilities }
      : { ...DEFAULT_CONNECTOR_CAPABILITIES }

    // Implementation is only "supported" when the connector DECLARES the
    // capability AND implements both contract methods. A capability flag alone
    // (without a wired method) is NOT true support.
    const bothMethodsPresent = typeof connector?.getCustomPackageDefinition === 'function' &&
      typeof connector?.createCustomPackage === 'function'
    const implementationSupported = caps.customPackageCreation === true && bothMethodsPresent
    const contractSupported = bothMethodsPresent

    if (!implementationSupported && !contractSupported) continue

    const readiness = await getCustomPackageCreationReadiness(provider.id).catch(() => ({ ready: false, reason: 'readiness-check-failed' }))

    let gatedReason: string | undefined
    if (!implementationSupported) {
      gatedReason = 'Provider API supports the capability but the OneSIM implementation is not yet certified/wired.'
    } else if (!readiness.ready) {
      if ((readiness.reason || '').includes('account-not-enabled')) {
        gatedReason = 'Supported by provider — account certification required.'
      } else {
        gatedReason = readiness.reason || 'Not ready for upstream creation.'
      }
    }

    result.push({
      id: provider.id,
      name: provider.name,
      code: provider.code,
      status: provider.status,
      adapterStrategy: provider.adapterStrategy,
      contractSupported,
      implementationSupported,
      accountEnabled: readiness.ready,
      oneSimExposure: false,
      gatedReason,
    })
  }

  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Backward-compatible alias used by existing pages/tests. Now returns MODE A
 * providers (build-from-existing backings) only — the current behavior.
 */
export async function getEligibleCustomPackageProviders(): Promise<EligibleBackingProvider[]> {
  return getEligibleBackingProviders()
}

/**
 * Returns the purchase-ready ProviderPackages owned by a single provider,
 * scoped so the UI never mixes packages from different providers.
 */
export async function getEligibleProviderPackagesForProvider(providerId: string) {
  return prisma.providerPackage.findMany({
    where: {
      providerId,
      configurationStatus: { in: ELIGIBLE_CONFIG_STATUSES },
      publishStatus: { in: ELIGIBLE_PUBLISH_STATUSES },
      sellingPrice: { gt: 0 },
      costPrice: { gt: 0 },
    },
    include: { provider: { select: { id: true, name: true, code: true, status: true } } },
    orderBy: [{ name: 'asc' }],
    take: 500,
  })
}

export { getCustomPackageCreationReadiness }