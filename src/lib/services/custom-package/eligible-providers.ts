import { prisma } from '@/lib/prisma'
import { ProviderCapability } from '@/lib/providers/capabilities/types'
import { ProviderStatus } from '@prisma/client'

export interface EligibleCustomProvider {
  id: string
  name: string
  code: string
  status: string
  adapterStrategy: string | null
  hasPurchaseCapability: boolean
  hasCustomPackageCreationCapability: boolean
  eligiblePackageCount: number
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
 * Provider-neutral eligibility for the Custom Package Builder.
 *
 * A provider is eligible to be a custom-package backing provider when:
 *   - it is operational (ACTIVE / DEGRADED / TESTING)
 *   - it has PURCHASE capability (and optionally CUSTOM_PACKAGE_CREATION)
 *   - it owns at least one configured + purchase-ready ProviderPackage
 *
 * Never hard-codes a provider name. Provider identity is always derived from
 * capabilities + package availability.
 */
export async function getEligibleCustomPackageProviders(): Promise<EligibleCustomProvider[]> {
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

  const result: EligibleCustomProvider[] = []
  for (const provider of providers) {
    const hasPurchase = hasCapability(provider.enabledCapabilities, ProviderCapability.PURCHASE)
    const hasCustom = hasCapability(provider.enabledCapabilities, ProviderCapability.CUSTOM_PACKAGE_CREATION)
    if (!hasPurchase && !hasCustom) continue

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
      hasPurchaseCapability: hasPurchase,
      hasCustomPackageCreationCapability: hasCustom,
      eligiblePackageCount,
    })
  }

  return result.sort((a, b) => a.name.localeCompare(b.name))
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
