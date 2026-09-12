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
  /** Optional VERIFIED network-attach evidence from the provider response.
   *  Only set when the connector proved a successful network attach for the
   *  exact target eSIM (never from a weak "package active" claim). */
  providerNetworkAttachedSignal?: boolean
}

export interface LifecycleResult {
  status: string
  /** True when this transition should set/update activatedAt. */
  setActivatedAt: boolean
  /** Reason for the decision (for logs/audit). */
  reason: string
}

/**
 * Canonical provider-terminal lifecycle states. Once the canonical engine maps
 * a provider report into one of these, the eSIM must never be pulled back out by
 * a later weaker, unrecognized, or ambiguous report (e.g. an unverified ACTIVE
 * claim, a device-installed signal, a PENDING report, or an unknown value).
 * Legitimate recovery flows operate above this engine and rewrite the row
 * directly, so no in-engine exit is needed.
 */
const TERMINAL_STATUSES = ['EXPIRED', 'FAILED', 'CANCELLED']

/** Lifecycle states backed by OneSIM's own device/activation evidence (or a
 *  provider suspension that has no legitimate silent exit). A weaker or
 *  unrecognized provider report must never downgrade these to a "not yet
 *  active" provisioning state; they may still move to recognized authoritative
 *  terminal states (SUSPENDED/EXPIRED/FAILED/CANCELLED) or to ACTIVE via
 *  canonical evidence. */
const PRESERVABLE_CURRENT_STATUSES = ['ACTIVE', 'INSTALLED', 'INSTALLING', 'SUSPENDED']

/** Provider-reported statuses that represent device-level activation. */
const DEVICE_ACTIVATION_SIGNALS = ['INSTALLED', 'ACTIVATED_ON_DEVICE', 'DEVICE_ACTIVATED', 'IN_USE', 'ONLINE', 'ATTACHED']

/** Provider-reported "not yet active" states (weaker than ACTIVE). */
const WEAKER_PROVISIONING_STATES = ['PENDING', 'PENDING_ACTIVATION', 'PROCESSING', 'PROVISIONING', 'QUEUED', 'RESERVED']

/** Whether a positive usage value counts as activation evidence. */
function hasUsageEvidence(dataUsedMB: number): boolean {
  return dataUsedMB > 0
}

function hasActivationHistory(activatedAt: Date | null | undefined): boolean {
  return activatedAt != null
}

export function deriveEsimLifecycleStatus(input: LifecycleInput): LifecycleResult {
  const { providerNormalizedStatus, currentStatus, dataUsedMB, activatedAt, providerInstalledSignal, providerNetworkAttachedSignal } = input
  const upper = providerNormalizedStatus.toUpperCase()
  const currentUpper = (currentStatus || '').toUpperCase()

  // 1. Canonical terminal states are one-way: never resurrect EXPIRED, FAILED,
  //    or CANCELLED from a weaker/unrecognized/ambiguous provider report
  //    (unverified ACTIVE claim, device-installed signal, PENDING report, or
  //    unknown value). Preserve the terminal state and only the terminal state.
  if (TERMINAL_STATUSES.includes(currentUpper)) {
    return { status: currentUpper, setActivatedAt: false, reason: 'preserve-terminal' }
  }

  // 2. Monotonic guard: never regress from a state backed by OneSIM's own
  //    device/activation evidence (or from a provider suspension) to a "not
  //    yet active" provisioning state based on a weaker provider report.
  if (PRESERVABLE_CURRENT_STATUSES.includes(currentUpper) && WEAKER_PROVISIONING_STATES.includes(upper)) {
    return { status: currentUpper, setActivatedAt: false, reason: 'monotonic-preserve-active' }
  }

  // 3. Explicit device-installed signal from provider. A device/install signal
  //    is weaker than authoritative local evidence: it never downgrades ACTIVE
  //    (which holds stronger activation evidence) and never erases a provider
  //    suspension. It upgrades provisioning states (PENDING / PROCESSING /
  //    PENDING_ACTIVATION / INSTALLING) up to INSTALLED, and is a no-op for a
  //    current INSTALLED.
  if (providerInstalledSignal || DEVICE_ACTIVATION_SIGNALS.includes(upper)) {
    if (currentUpper === 'ACTIVE' || currentUpper === 'SUSPENDED') {
      return { status: currentUpper, setActivatedAt: false, reason: 'preserve-authoritative-on-installed-signal' }
    }
    return { status: 'INSTALLED', setActivatedAt: !hasActivationHistory(activatedAt), reason: 'provider-installed-signal' }
  }

  // 4. Provider says ACTIVE — check for usage/activation evidence. The connector
  //    may provide VERIFIED network-attach evidence (providerNetworkAttachedSignal)
  //    that proves device activation without usage history.
  if (upper === 'ACTIVE') {
    if (hasActivationHistory(activatedAt)) {
      return { status: 'ACTIVE', setActivatedAt: false, reason: 'already-activated' }
    }
    if (providerNetworkAttachedSignal) {
      return { status: 'ACTIVE', setActivatedAt: !hasActivationHistory(activatedAt), reason: 'network-attach-evidence' }
    }
    if (hasUsageEvidence(dataUsedMB)) {
      return { status: 'ACTIVE', setActivatedAt: !hasActivationHistory(activatedAt), reason: 'usage-evidence' }
    }
    if (currentUpper === 'ACTIVE') {
      return { status: 'ACTIVE', setActivatedAt: false, reason: 'preserve-active' }
    }
    // Provider claims active but has no evidence: never fabricate ACTIVE, and
    // never let an unverified claim downgrade stronger local evidence either.
    if (PRESERVABLE_CURRENT_STATUSES.includes(currentUpper)) {
      return { status: currentUpper, setActivatedAt: false, reason: 'preserve-authoritative-on-weak-active' }
    }
    return { status: 'PENDING_ACTIVATION', setActivatedAt: false, reason: 'provider-active-no-evidence' }
  }

  // 5. Explicit pending states
  if (upper === 'PENDING_ACTIVATION' || upper === 'PENDING') {
    return { status: 'PENDING_ACTIVATION', setActivatedAt: false, reason: 'provider-pending' }
  }

  // 6. Failed/error states
  if (upper === 'FAILED' || upper === 'ERROR' || upper === 'REJECTED') {
    return { status: 'FAILED', setActivatedAt: false, reason: 'provider-failed' }
  }

  // 7. Suspended
  if (upper === 'SUSPENDED' || upper === 'DISABLED') {
    return { status: 'SUSPENDED', setActivatedAt: false, reason: 'provider-suspended' }
  }

  // 8. Expired
  if (upper === 'EXPIRED' || upper === 'EXPIRING') {
    return { status: 'EXPIRED', setActivatedAt: false, reason: 'provider-expired' }
  }

  // 9. CANCELLED
  if (upper === 'CANCELLED' || upper === 'CANCELED') {
    return { status: 'CANCELLED', setActivatedAt: false, reason: 'provider-cancelled' }
  }

  // 10. Unknown provider status — fail-safe: an unrecognized value must not
  //     destroy canonical authoritative (device evidence / activation /
  //     suspension) or canonical terminal evidence. Only early/non-authoritative
  //     states fall back to PENDING_ACTIVATION.
  if (PRESERVABLE_CURRENT_STATUSES.includes(currentUpper) || TERMINAL_STATUSES.includes(currentUpper)) {
    return { status: currentUpper, setActivatedAt: false, reason: 'preserve-current-on-unknown-provider' }
  }

  return { status: 'PENDING_ACTIVATION', setActivatedAt: false, reason: 'unknown-provider-fallback' }
}
