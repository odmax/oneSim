/**
 * Device-activation-aware eSIM lifecycle status derivation.
 *
 * A provider reporting "active" package status does NOT prove the eSIM is
 * installed or in use — that requires usage, network events, or an explicit
 * device-level signal.
 */

export interface LifecycleInput {
  /** The connector-normalized status (e.g. ACTIVE, PENDING_ACTIVATION, SUSPENDED). */
  providerNormalizedStatus: string
  /** Current stored eSIM.status. */
  currentStatus: string
  /** Current stored eSIM.dataUsedMB (0–N). */
  dataUsedMB: number
  /** Current stored eSIM.activatedAt (null until proven). */
  activatedAt: Date | null | undefined
  /** Optional explicit device-level evidence from the provider response. */
  providerInstalledSignal?: boolean
}

export interface LifecycleResult {
  status: string
  /** True when this transition should set/update activatedAt. */
  setActivatedAt: boolean
  /** Reason for the decision (for logs/audit). */
  reason: string
}

/** Statuses that represent a meaningful lifecycle state and should be preserved
 *  unless the provider explicitly reports a terminal/better state. */
const STICKY_STATUSES = ['ACTIVE', 'SUSPENDED', 'EXPIRED', 'FAILED', 'CANCELLED']

/** Provider-reported statuses that represent device-level activation. */
const DEVICE_ACTIVATION_SIGNALS = ['INSTALLED', 'ACTIVATED_ON_DEVICE', 'DEVICE_ACTIVATED', 'IN_USE', 'ONLINE', 'ATTACHED']

/** Whether a positive usage value counts as activation evidence. */
function hasUsageEvidence(dataUsedMB: number): boolean {
  return dataUsedMB > 0
}

function hasActivationHistory(activatedAt: Date | null | undefined): boolean {
  return activatedAt != null
}

export function deriveEsimLifecycleStatus(input: LifecycleInput): LifecycleResult {
  const { providerNormalizedStatus, currentStatus, dataUsedMB, activatedAt, providerInstalledSignal } = input
  const upper = providerNormalizedStatus.toUpperCase()
  const currentUpper = (currentStatus || '').toUpperCase()

  // Explicit device-installed signal from provider
  if (providerInstalledSignal || DEVICE_ACTIVATION_SIGNALS.includes(upper)) {
    return { status: 'INSTALLED', setActivatedAt: !hasActivationHistory(activatedAt), reason: 'provider-installed-signal' }
  }

  // Provider says ACTIVE — check for usage/activation evidence
  if (upper === 'ACTIVE') {
    if (hasActivationHistory(activatedAt)) {
      return { status: 'ACTIVE', setActivatedAt: false, reason: 'already-activated' }
    }
    if (hasUsageEvidence(dataUsedMB)) {
      return { status: 'ACTIVE', setActivatedAt: !hasActivationHistory(activatedAt), reason: 'usage-evidence' }
    }
    // Already ACTIVE and provider confirms — preserve existing state
    if (currentUpper === 'ACTIVE') {
      return { status: 'ACTIVE', setActivatedAt: false, reason: 'preserve-active' }
    }
    // Provider says active but no evidence → pending activation
    return { status: 'PENDING_ACTIVATION', setActivatedAt: false, reason: 'provider-active-no-evidence' }
  }

  // Explicit pending states
  if (upper === 'PENDING_ACTIVATION' || upper === 'PENDING') {
    return { status: 'PENDING_ACTIVATION', setActivatedAt: false, reason: 'provider-pending' }
  }

  // Failed/error states
  if (upper === 'FAILED' || upper === 'ERROR' || upper === 'REJECTED') {
    return { status: 'FAILED', setActivatedAt: false, reason: 'provider-failed' }
  }

  // Suspended
  if (upper === 'SUSPENDED' || upper === 'DISABLED') {
    return { status: 'SUSPENDED', setActivatedAt: false, reason: 'provider-suspended' }
  }

  // Expired
  if (upper === 'EXPIRED' || upper === 'EXPIRING') {
    return { status: 'EXPIRED', setActivatedAt: false, reason: 'provider-expired' }
  }

  // CANCELLED
  if (upper === 'CANCELLED' || upper === 'CANCELED') {
    return { status: 'CANCELLED', setActivatedAt: false, reason: 'provider-cancelled' }
  }

  // Unknown provider status — preserve current if meaningful
  if (STICKY_STATUSES.includes(currentUpper)) {
    return { status: currentUpper, setActivatedAt: false, reason: 'preserve-current-on-unknown-provider' }
  }

  return { status: 'PENDING_ACTIVATION', setActivatedAt: false, reason: 'unknown-provider-fallback' }
}
