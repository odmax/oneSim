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
 *  canonical evidence. DEPLETED is included: only the authoritative usage rule
 *  (remaining data > 0) may move a depleted line back to ACTIVE. */
const PRESERVABLE_CURRENT_STATUSES = ['ACTIVE', 'INSTALLED', 'INSTALLING', 'SUSPENDED', 'DEPLETED']

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

  // 1b. Explicit provider "data exhausted" status → customer-visible DEPLETED,
  //     even for providers WITHOUT usage lookup (e.g. AirHub, iBASIS that report
  //     the exhausted lifecycle through status sync/webhooks/reconciliation).
  //     Precedence: an already-expired or terminal/refunded line is never
  //     converted to DEPLETED; an already-DEPLETED line stays DEPLETED
  //     (idempotent). providerStatus keeps the raw provider value at the callers.
  if (isProviderExhaustedStatus(providerNormalizedStatus)) {
    if (currentUpper === 'DEPLETED') {
      return { status: 'DEPLETED', setActivatedAt: false, reason: 'provider-exhausted-preserved' }
    }
    if ((DEPLETION_IMMUTABLE_STATUSES as string[]).includes(currentUpper)) {
      return { status: currentUpper, setActivatedAt: false, reason: 'preserve-terminal-on-exhausted' }
    }
    return { status: 'DEPLETED', setActivatedAt: false, reason: 'provider-exhausted' }
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
    if (currentUpper === 'DEPLETED') {
      return { status: 'DEPLETED', setActivatedAt: false, reason: 'depleted-preserved' }
    }
    if (currentUpper === 'ACTIVE' || currentUpper === 'SUSPENDED') {
      return { status: currentUpper, setActivatedAt: false, reason: 'preserve-authoritative-on-installed-signal' }
    }
    return { status: 'INSTALLED', setActivatedAt: !hasActivationHistory(activatedAt), reason: 'provider-installed-signal' }
  }

  // 4. Provider says ACTIVE — check for usage/activation evidence. The connector
  //    may provide VERIFIED network-attach evidence (providerNetworkAttachedSignal)
  //    that proves device activation without usage history.
  if (upper === 'ACTIVE') {
    if (currentUpper === 'DEPLETED') {
      // Ordinary provider ACTIVE status is NOT evidence of replenished data:
      // a depleted eSIM returns to ACTIVE only via the authoritative usage rule
      // (deriveDepletionStatus with remaining data > 0).
      return { status: 'DEPLETED', setActivatedAt: false, reason: 'depleted-needs-authoritative-replenishment' }
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// Provider-neutral DEPLETED status (customer-visible "data allowance exhausted").
//
// Only ONE canonical decision point: a depleted line is derived from AUTHORITATIVE
// usage evidence (finite remaining data <= 0 on a valid snapshot) OR an explicit
// provider status that unambiguously means exhausted data. It is never inferred
// from missing/unknown remaining data, a failed usage request, total allowance
// alone, or a provider lifecycle status of ACTIVE without usage evidence.
// ─────────────────────────────────────────────────────────────────────────────

/** Provider statuses that unambiguously mean the data allowance is exhausted. */
export const EXHAUSTED_PROVIDER_STATUSES = ['DEPLETED', 'EXHAUSTED', 'DATA_DEPLETED', 'OUT_OF_DATA'] as const

export function isProviderExhaustedStatus(providerStatus?: string | null): boolean {
  const upper = String(providerStatus || '').toUpperCase()
  return (EXHAUSTED_PROVIDER_STATUSES as readonly string[]).includes(upper)
}

/** Irreversible/lifecycle-closed states a depleted line is NEVER derived from
 *  (an EXPIRED eSIM must not become DEPLETED; FAILED/CANCELLED/REFUNDED are
 *  already terminal for the customer). */
const DEPLETION_IMMUTABLE_STATUSES = ['EXPIRED', 'FAILED', 'CANCELLED', 'REFUNDED']

export interface DepletionEvidence {
  /** dataRemainingMB from an authoritative usage snapshot (null = unknown). */
  dataRemainingMB?: number | null
  /** True only when the provider/connector considered the snapshot valid. */
  snapshotValid?: boolean
  /** Explicit provider status that unambiguously means exhausted data. */
  providerExhausted?: boolean
}

/**
 * Canonical provider-neutral DEPLETED transition.
 *
 * Returns:
 *  - 'DEPLETED'  status change (remaining <= 0 on a valid snapshot, or an
 *                explicit exhausted provider status) unless the current status
 *                is already DEPLETED (no-op → idempotent);
 *  - 'ACTIVE'    when a DEPLETED line is replenished by an authoritative
 *                snapshot with remaining data > 0 (top-up reactivation);
 *  - null        no status change (idempotent / insufficient evidence).
 *
 * Negative remaining values are treated safely as depleted (clamped for the
 * decision). EXPIRED/FAILED/CANCELLED/REFUNDED are never converted to DEPLETED.
 */
export function deriveDepletionStatus(
  currentStatus: string | null | undefined,
  evidence: DepletionEvidence,
): 'DEPLETED' | 'ACTIVE' | null {
  const current = String(currentStatus || 'PENDING').toUpperCase()
  if (DEPLETION_IMMUTABLE_STATUSES.includes(current)) return null

  const remaining = evidence.dataRemainingMB
  const numericDepleted =
    evidence.snapshotValid === true &&
    typeof remaining === 'number' &&
    Number.isFinite(remaining) &&
    remaining <= 0

  if (numericDepleted || evidence.providerExhausted === true) {
    return current === 'DEPLETED' ? null : 'DEPLETED'
  }

  const replenished =
    typeof remaining === 'number' &&
    Number.isFinite(remaining) &&
    remaining > 0 &&
    evidence.snapshotValid === true

  if (current === 'DEPLETED' && replenished) return 'ACTIVE'

  return null
}
