import { isCapabilityExposedToPortal } from '@/lib/providers/capabilities/exposure'
import { ProviderCapability } from '@/lib/providers/capabilities/types'

export interface ESimClientCapabilities {
  canRefreshStatus: boolean
  canViewUsage: boolean
  canRefreshUsage: boolean
  canTopUp: boolean
  canSuspend: boolean
  canResume: boolean
  canViewInstallation: boolean
}

export async function getEsimClientCapabilities(providerId: string | null): Promise<ESimClientCapabilities> {
  if (!providerId) return allFalse()

  const check = (cap: ProviderCapability) => isCapabilityExposedToPortal(providerId, cap)

  const [status, usage, topUp, suspend, resume] = await Promise.all([
    check('STATUS' as ProviderCapability),
    check('USAGE' as ProviderCapability),
    check('TOP_UP' as ProviderCapability),
    check('SUSPEND' as ProviderCapability),
    check('RESUME' as ProviderCapability),
  ])

  return {
    canRefreshStatus: status,
    canViewUsage: usage,
    canRefreshUsage: usage,
    canTopUp: topUp,
    canSuspend: suspend,
    canResume: resume,
    canViewInstallation: true, // Always allow viewing installation data; provider-specific availability handled by installationStatus
  }
}

function allFalse(): ESimClientCapabilities {
  return { canRefreshStatus: false, canViewUsage: false, canRefreshUsage: false, canTopUp: false, canSuspend: false, canResume: false, canViewInstallation: false }
}
