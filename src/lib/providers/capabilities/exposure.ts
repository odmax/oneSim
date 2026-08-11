import { prisma } from '@/lib/prisma'
import { ProviderCapability } from '@/lib/providers/capabilities/types'
import { parseCapabilities } from '@/lib/providers/capabilities/registry'

/**
 * Check if a capability is exposed to Client Portal or Client API.
 * Defaults: normal capabilities (PURCHASE, STATUS, USAGE, TOP_UP, SUSPEND, RESUME) → true
 *          sensitive capabilities (CREATE_BUNDLE, UPDATE_BUNDLE, DIRECT_IMSI_CREATE, EVENT_LOGS, RATE_LIST) → false
 */
const DEFAULT_EXPOSED_CAPABILITIES = new Set<string>([
  ProviderCapability.PURCHASE, ProviderCapability.STATUS, ProviderCapability.USAGE,
  ProviderCapability.TOP_UP, ProviderCapability.SUSPEND, ProviderCapability.RESUME,
  ProviderCapability.BALANCE,
])

export async function isCapabilityExposedToPortal(providerId: string, capability: ProviderCapability): Promise<boolean> {
  const row = await prisma.$queryRawUnsafe<{ clientPortalEnabled: boolean }[]>(
    `SELECT "clientPortalEnabled" FROM provider_capability_exposure WHERE "providerId"=$1 AND capability=$2`, providerId, capability
  ).catch(() => [])
  if (row.length) return row[0].clientPortalEnabled
  return DEFAULT_EXPOSED_CAPABILITIES.has(capability)
}

export async function isCapabilityExposedToApi(providerId: string, capability: ProviderCapability): Promise<boolean> {
  const row = await prisma.$queryRawUnsafe<{ clientApiEnabled: boolean }[]>(
    `SELECT "clientApiEnabled" FROM provider_capability_exposure WHERE "providerId"=$1 AND capability=$2`, providerId, capability
  ).catch(() => [])
  if (row.length) return row[0].clientApiEnabled
  return DEFAULT_EXPOSED_CAPABILITIES.has(capability)
}

export async function requireCapabilityExposure(providerId: string, capability: ProviderCapability, context: 'portal' | 'api'): Promise<void> {
  const allowed = context === 'portal'
    ? await isCapabilityExposedToPortal(providerId, capability)
    : await isCapabilityExposedToApi(providerId, capability)
  if (!allowed) throw new Error(`capability_not_available: ${capability}`)
}
