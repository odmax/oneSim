/**
 * Provider-neutral eSIM inventory status.
 *
 * ONE canonical, PURE (no prisma, no provider) source for every eSIM inventory
 * surface. It exposes (a) a single primary, customer-safe status badge used by
 * the Business and Admin lists, and (b) the separate normalized detail axes
 * (service lifecycle, install-instructions availability, current device-
 * installation evidence, usage, status polling) that back the badge's tooltip.
 *
 *   1. SERVICE LIFECYCLE    — canonical stored `status`, customer-safe label.
 *   2. INSTALLATION DETAILS — whether installation instructions exist. True
 *        only when usable QR/activation install data is present, or when
 *        installationStatus is READY (which reliably marks details available).
 *        Device-installation values (INSTALLED/ENABLED/DOWNLOADED/INSTALLING)
 *        alone never prove install instructions exist.
 *   3. DEVICE INSTALLATION  — CURRENT-installation evidence ONLY. "Installed" is
 *        reserved for explicit normalized installation evidence
 *        (installationStatus INSTALLED/ENABLED, labelled "latest evidence" with
 *        the status-check time when known) OR a separately recorded customer
 *        confirmation (labelled "Installed (customer confirmed)" so the evidence
 *        SOURCE — provider vs customer — stays distinguishable in audit data).
 *        Canonical ACTIVE/DEPLETED, activation timestamps, and recorded usage
 *        PROVE the eSIM was activated or used historically — they do not prove
 *        its profile is still installed — so they render the distinct
 *        "Activated/used; current installation unconfirmed".
 *   4. USAGE                — "Usage unavailable" when no authoritative snapshot
 *        exists; a genuine zero never renders as missing and missing never
 *        renders as zero. When known, reports used / total / remaining, the
 *        last usage check, and whether the snapshot is stale per the shared
 *        usage-freshness policy.
 *   5. STATUS POLLING       — sync state, last check time, and next scheduled
 *        check from the scheduler's own bookkeeping (lastStatusSyncAt /
 *        statusSyncRetryCount / statusNextSyncAt) — never a staleness guess.
 *   6. PRIMARY STATUS       — one consistent badge for every provider with the
 *        canonical precedence below; terminal lifecycle states are preserved
 *        verbatim and never disguised as a primary status. "Ready to install"
 *        means usable profile/activation details are available (available to
 *        install only — it never asserts the customer has NOT already installed
 *        it) and is produced ONLY when the canonical service is still
 *        provisioning with no device-install or activation evidence either way.
 *        A provider-reported DOWNLOADED checkpoint renders the distinct
 *        evidence-exact "Profile downloaded" instead, and QR / activation-code /
 *        install-details alone never imply Installed or Active.
 *
 * Provider-specific raw status/raw payloads are NEVER read here, so a provider
 * response can never leak through this module.
 */

import { ESIM_STATUS_META } from '@/lib/status-constants'
import { hasUsableInstallData } from './installation-data'
import { deriveUsageMetrics, usageRemainingLabel, getUsageStaleness } from './usage-metrics'

export type DeviceInstallationState =
  | 'INSTALLED'
  | 'INSTALLING'
  | 'DOWNLOADED'
  | 'INSTALL_FAILED'
  | 'ACTIVATED_UNCONFIRMED_INSTALL'
  | 'UNKNOWN'
export type PollingState = 'SYNCED' | 'FAILED' | 'UNSYNCED'

export interface InventoryStatusRow {
  /** Canonical stored eSIM status (never the raw provider status). */
  status?: string | null
  installationStatus?: string | null
  /** Stored explanation of installationStatus (e.g. installationLastError). */
  installationLastError?: string | null
  /** Last time installation evidence was (re)checked/reconciled. */
  installationLastCheckedAt?: Date | string | null
  activationCode?: string | null
  qrCodeUrl?: string | null
  qrCode?: string | null
  smdpAddress?: string | null
  matchingId?: string | null
  activatedAt?: Date | string | null
  activationDetectedAt?: Date | string | null
  dataUsedMB?: number | null
  dataTotalMB?: number | null
  dataRemainingMB?: number | null
  lastStatusSyncAt?: Date | string | null
  statusSyncRetryCount?: number | null
  /** Scheduler-owned next status-check timestamp (null ⇒ scheduler stopped). */
  statusNextSyncAt?: Date | string | null
  lastUsageSyncAt?: Date | string | null
  /**
   * Separately recorded customer confirmation that the eSIM was installed on a
   * device. Distinct from provider evidence so the evidence SOURCE stays
   * distinguishable in details/audit data — customer-reported installation is
   * never presented as if the provider confirmed it. Not read from any raw
   * provider field.
   *
   * How this is produced today:
   *  - confirmEsimInstalledAction (src/lib/actions/esim-confirm-installed.ts)
   *    writes ONLY the `ESIM.customerConfirmedInstalledAt` column (inside one
   *    transaction with the CUSTOMER_CONFIRMED_INSTALLED AuditLog row, using a
   *    conditional update so concurrent requests cannot double-record) and never
   *    touches provider status / installationStatus / providerStatus / providerResponse.
   *  - Both inventory pages map the persisted column into this flag:
   *    `customerReportedInstalled: esim.customerConfirmedInstalledAt != null`.
   *  - Status/usage syncs and provider webhooks do not write the column, so it
   *    survives reload, polling, webhooks, and worker sync.
   *
   * DEPLOYMENT REQUIREMENT: the additive migration
   *   prisma/migrations/20261001000000_add_esim_customer_confirmed_install
   *   (ALTER TABLE "esims" ADD COLUMN "customerConfirmedInstalledAt" TIMESTAMP(3))
   *   MUST be applied to a database BEFORE deploying application code that reads
   *   this column. Until the migration is applied, the column does not exist and
   *   readers/writers fail. Rollout order is documented in the migration header:
   *   apply the migration to the environment first, then deploy the image.
   */
  customerReportedInstalled?: boolean
}

export interface InventoryStatusService {
  status: string
  label: string
  tone: 'success' | 'warn' | 'danger' | 'neutral'
}

export interface InventoryStatusInstallation {
  /** READY / QR / activation code ⇒ install instructions exist. */
  detailsAvailable: boolean
  label: string
  tone: 'success' | 'warn' | 'danger' | 'neutral'
}

export interface InventoryStatusDevice {
  state: DeviceInstallationState
  label: string
  tone: 'success' | 'warn' | 'danger' | 'neutral'
  /** The exact evidence that produced the label (visibility + audit). */
  evidence: string[]
  /** Latest evidence check time (installationLastCheckedAt ?? lastStatusSyncAt). */
  checkedAt: string | null
}

export interface InventoryStatusUsage {
  /** Authoritative snapshot exists (total or remaining recorded). */
  hasSnapshot: boolean
  /** Summary label; "Usage unavailable" when no authoritative snapshot exists. */
  label: string
  /** Used value when known (a genuine zero is valid and shown). */
  usedLabel: string | null
  /** Total allowance when known. */
  totalLabel: string | null
  /** Remaining value when known. */
  remainingLabel: string | null
  /** True when the provider reported an authoritative remaining value. */
  remainingKnown: boolean
  /** Numeric remaining MB when remainingKnown (clamped ≥ 0). */
  remaining: number
  /** Numeric total MB (derived total when only used+remaining are known). */
  total: number
  /** True when an old snapshot is beyond the shared usage-freshness threshold. */
  stale: boolean
  /** Last usage check (lastUsageSyncAt) when known, else null. */
  lastUsageCheckAt: string | null
  tone: 'success' | 'warn' | 'neutral'
}

export interface InventoryStatusPolling {
  state: PollingState
  label: string
  tone: 'success' | 'warn' | 'danger' | 'neutral'
  /** Last sync attempt time (success or failure), when recorded. */
  lastCheckAt: string | null
  /** Scheduler-owned next check time (null ⇒ scheduler stopped). */
  nextSyncAt: string | null
  /** Never checked at all. */
  neverChecked: boolean
  /** Consecutive failures with a live retry schedule (statusSyncRetryCount > 0). */
  failing: boolean
  /** The scheduler stopped polling this row (statusNextSyncAt = null). */
  stopped: boolean
  /** The scheduled check is due/overdue (statusNextSyncAt <= now) while healthy. */
  due: boolean
}

/**
 * One provider-neutral badge per eSIM. Terminal / exceptional lifecycle states
 * are preserved verbatim; otherwise the shared ladder is used.
 */
export type PrimaryInventoryStatus =
  | 'PROFILE_DOWNLOADED'
  | 'READY_TO_INSTALL'
  | 'INSTALLED'
  | 'ACTIVE'
  | 'LOW'
  | 'DEPLETED'
  | 'INSTALL_FAILED'
  | 'PROVISIONED'
  | 'PREPARING'
  | 'STATUS_UNAVAILABLE'
  // exceptional lifecycle states (never disguised as a primary status)
  | 'EXPIRED'
  | 'FAILED'
  | 'SUSPENDED'
  | 'CANCELLED'
  | 'REFUNDED'

export interface EsimPrimaryStatus {
  status: PrimaryInventoryStatus
  label: string
  tone: 'success' | 'warn' | 'danger' | 'neutral'
  /** The exact canonical evidence that produced the badge. */
  evidence: string[]
}

export interface EsimInventoryStatus {
  primary: EsimPrimaryStatus
  service: InventoryStatusService
  installation: InventoryStatusInstallation
  device: InventoryStatusDevice
  usage: InventoryStatusUsage
  polling: InventoryStatusPolling
  providerNeutral: true
}

/** Stored device-install evidence values that themselves mean "installed". */
const STORED_INSTALL_EVIDENCE = ['INSTALLED', 'ENABLED']

/** Canonical lifecycle statuses that only OneSIM reaches with its own device/
 *  activation/usage evidence (the lifecycle engine never sets them from a bare
 *  provider ACTIVE claim). */
const CANONICAL_INSTALLED_STATUSES = ['ACTIVE', 'INSTALLED', 'DEPLETED']

/**
 * Shared LOW-data threshold: the eSIM is "Low" when an ACTIVE line has a valid
 * authoritative usage snapshot whose REMAINING data is at or below this ratio
 * of its total allowance. Applied identically for every provider (no per
 * provider thresholds). 10% of the total allowance by default.
 */
export const LOW_DATA_RATIO_DEFAULT = 0.1

/**
 * The EXACT provider error messages the app persists into installationLastError
 * when a provider explicitly reports an eSIM profile download/installation
 * failure (never a OneSIM lookup/recovery failure):
 *   - status sync evidence:  src/lib/services/esims/sync-esim-status.ts
 *       updateData.installationLastError = 'Provider reports profile installation error'
 *   - Telna webhook:         src/lib/services/webhooks/provider-webhook-processor.ts
 *       installationLastError = 'Telna reported an eSIM profile download or installation failure'
 *
 * A device installation FAILED label is produced ONLY from an EXACT match
 * against these app-persisted messages (trimmed, case-normalized) — extra text,
 * lookup/recovery failures, and generic failure text never match. New providers
 * must add their canonical message here (the same list backs the unit tests).
 */
export const KNOWN_PROVIDER_REPORTED_INSTALL_FAILURES = [
  'Provider reports profile installation error',
  'Telna reported an eSIM profile download or installation failure',
] as const

function normalizeFailureReason(reason: string): string {
  return reason.trim().toLowerCase()
}

export function isProviderReportedInstallFailure(reason?: string | null): boolean {
  if (!reason) return false
  const normalized = normalizeFailureReason(reason)
  return KNOWN_PROVIDER_REPORTED_INSTALL_FAILURES.some(
    (message) => normalized === normalizeFailureReason(message),
  )
}

/**
 * TRUE only for EXPLICIT normalized device-installation evidence. Canonical
 * ACTIVE/DEPLETED, activation timestamps, and recorded usage prove the eSIM
 * was activated or used historically — they do NOT prove its profile is still
 * installed on the device and must never label it "Installed".
 */
export function hasDeviceInstallEvidence(row: InventoryStatusRow): boolean {
  const install = String(row.installationStatus || '').toUpperCase()
  return STORED_INSTALL_EVIDENCE.includes(install)
}

/** Historical activation/usage evidence that does NOT prove current install. */
export function hasHistoricalActivationEvidence(row: InventoryStatusRow): boolean {
  const status = String(row.status || '').toUpperCase()
  if (CANONICAL_INSTALLED_STATUSES.includes(status)) return true
  if (hasDate(row.activatedAt) || hasDate(row.activationDetectedAt)) return true
  return isFinitePositive(row.dataUsedMB)
}

/**
 * Install-instruction availability is its own axis from device-installation
 * state. Returns true ONLY when usable QR/activation install data exists, or
 * when installationStatus is READY (READY reliably means installation details
 * were made available). INSTALLED / ENABLED / DOWNLOADED / INSTALLING alone
 * describe the device-installation lifecycle — they NEVER imply install
 * instructions are available and must not mark details available.
 */
function installDetailsAvailable(row: InventoryStatusRow): boolean {
  if (hasUsableInstallData(row)) return true
  return String(row.installationStatus || '').toUpperCase() === 'READY'
}

function hasDate(value: Date | string | null | undefined): boolean {
  if (value == null) return false
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(t)
}

function toTime(value: Date | string | null | undefined): number | null {
  if (value == null) return null
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(t) ? t : null
}

function serviceLabel(status: string | null | undefined): InventoryStatusService {
  const key = String(status || '').toUpperCase()
  const meta = ESIM_STATUS_META[key]
  if (meta) return { status: key, label: meta.label, tone: meta.tone }
  return { status: key || 'UNKNOWN', label: key || 'Unknown', tone: 'neutral' }
}

function isFinitePositive(n: number | null | undefined): boolean {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

const PROVISIONING_STATUSES = ['PENDING', 'PENDING_ACTIVATION', 'PROCESSING', 'PROVISIONING', 'RESERVED']

function primary(axis: {
  service: InventoryStatusService
  installation: InventoryStatusInstallation
  device: InventoryStatusDevice
  usage: InventoryStatusUsage
}, lowRatio: number, customerReportedInstalled: boolean): EsimPrimaryStatus {
  const serviceKey = axis.service.status
  const withEvidence = (...evidence: string[]): EsimPrimaryStatus['evidence'] => evidence

  // 0. Exceptional/terminal lifecycle states are preserved verbatim.
  if (serviceKey === 'EXPIRED' || serviceKey === 'FAILED' || serviceKey === 'CANCELLED' ||
      serviceKey === 'CANCELED' || serviceKey === 'REFUNDED' || serviceKey === 'SUSPENDED') {
    const label = serviceKey === 'CANCELED' ? 'Cancelled' : axis.service.label
    return { status: serviceKey === 'CANCELED' ? 'CANCELLED' : serviceKey as PrimaryInventoryStatus, label, tone: axis.service.tone, evidence: withEvidence(`canonical lifecycle ${serviceKey}`) }
  }

  // 1. Depleted — canonical DEPLETED, or an authoritative usage snapshot proves
  //    no data remains (remaining ≤ 0). Missing usage is never treated as zero.
  if (serviceKey === 'DEPLETED') {
    return { status: 'DEPLETED', label: 'Depleted', tone: 'danger', evidence: withEvidence('canonical lifecycle DEPLETED') }
  }
  if (axis.usage.hasSnapshot && axis.usage.remainingKnown && !axis.usage.stale && axis.usage.remaining <= 0) {
    return { status: 'DEPLETED', label: 'Depleted', tone: 'danger', evidence: withEvidence('authoritative usage snapshot with no remaining data') }
  }

  // 2. Low — ACTIVE line with a valid authoritative snapshot whose remaining
  //    data is above zero and at/below the shared threshold of total allowance.
  if (serviceKey === 'ACTIVE' &&
      axis.usage.hasSnapshot && axis.usage.remainingKnown && !axis.usage.stale &&
      axis.usage.total > 0 && axis.usage.remaining > 0 &&
      axis.usage.remaining / axis.usage.total <= lowRatio) {
    return { status: 'LOW', label: 'Low', tone: 'warn', evidence: withEvidence('active line below the shared low-data threshold') }
  }

  // 3. Active — canonical OneSIM lifecycle is ACTIVE. Never promoted from QR /
  //    installation details / usage history / a raw provider ACTIVE claim.
  if (serviceKey === 'ACTIVE') {
    return { status: 'ACTIVE', label: 'Active', tone: 'success', evidence: withEvidence('canonical lifecycle ACTIVE') }
  }

  // 4. Installed on device — explicit normalized install evidence (provider
  //    INSTALLED/ENABLED) or a separately recorded customer confirmation, while
  //    the service is not yet ACTIVE. The evidence SOURCE is preserved so
  //    customer-reported installation is distinguishable from provider-confirmed.
  if (serviceKey === 'INSTALLED' || axis.device.state === 'INSTALLED' || customerReportedInstalled) {
    // Detect the SOURCE from the device axis evidence strings: provider evidence
    // is the explicit normalized string; a customer-only confirmation carries the
    // distinct customer string even though device.state is also INSTALLED.
    const deviceEvidenceIsProvider = axis.device.state === 'INSTALLED' &&
      axis.device.evidence.every((e) => !e.includes('customer-confirmed installation'))
    const evidence = deviceEvidenceIsProvider
      ? axis.device.evidence
      : customerReportedInstalled
        ? ['customer-confirmed installation (separately recorded)']
        : ['explicit normalized installation evidence']
    // The evidence SOURCE is reflected in the label so a customer-confirmed
    // install is never presented as if the provider confirmed it.
    const sourceIsCustomer = !deviceEvidenceIsProvider && customerReportedInstalled
    return { status: 'INSTALLED', label: sourceIsCustomer ? 'Installed on device — customer confirmed' : 'Installed on device', tone: 'success', evidence: withEvidence(...evidence) }
  }

  // 4b. Device-installation failure — preserved as an exceptional device state.
  if (axis.device.state === 'INSTALL_FAILED') {
    return { status: 'INSTALL_FAILED', label: 'Installation failed', tone: 'danger', evidence: withEvidence('provider-reported installation failure') }
  }

  // 5. Profile downloaded — provider-reported DOWNLOADED checkpoint. Kept
  //    evidence-exact (a download checkpoint does NOT prove installation).
  if (axis.device.state === 'DOWNLOADED') {
    return { status: 'PROFILE_DOWNLOADED', label: 'Profile downloaded', tone: 'warn', evidence: withEvidence('provider-reported profile download checkpoint; installation unconfirmed') }
  }

  // 5b. Ready to install — usable profile/activation details are available
  //    ("available to install"). This never asserts the customer has NOT already
  //    installed it: it is produced ONLY when the canonical service is still
  //    provisioning and there is no device-install or activation evidence either
  //    way (device state unknown). QR/install-details alone never imply Installed
  //    or Active — those require explicit evidence elsewhere in this ladder.
  if (axis.installation.detailsAvailable &&
      axis.device.state === 'UNKNOWN' &&
      PROVISIONING_STATUSES.includes(serviceKey)) {
    return { status: 'READY_TO_INSTALL', label: 'Ready to install', tone: 'warn', evidence: withEvidence('usable installation details available; install state not asserted') }
  }

  // 6. Honest fallback. An eSIM still being provisioned (no install details yet)
  //    is "Preparing"; historical activation/usage with an unconfirmed current
  //    install is "Provisioned"; unmapped evidence falls back to a truthful
  //    "Status unavailable". None of these claims Installed, Ready to install,
  //    or Active without explicit evidence.
  if (serviceKey === 'INSTALLING' || axis.device.state === 'INSTALLING') {
    return { status: 'PREPARING', label: 'Preparing', tone: 'neutral', evidence: withEvidence('installation in progress') }
  }
  if (PROVISIONING_STATUSES.includes(serviceKey)) {
    if (axis.device.state === 'ACTIVATED_UNCONFIRMED_INSTALL') {
      return { status: 'PROVISIONED', label: 'Provisioned', tone: 'warn', evidence: withEvidence('activated/used historically; current installation unconfirmed') }
    }
    return { status: 'PREPARING', label: 'Preparing', tone: 'neutral', evidence: withEvidence('no installation or activation evidence yet') }
  }
  return { status: 'STATUS_UNAVAILABLE', label: 'Status unavailable', tone: 'neutral', evidence: withEvidence('insufficient evidence for a status') }
}

function labelOfGigabytes(d: number): string {
  return `${(d / 1024).toFixed(2)} GB`
}

/**
 * Status polling state from the scheduler's own bookkeeping.
 *
 * Scheduler contract (src/lib/services/jobs/handlers/esim-sync-batch.ts and
 * sync-policy.ts):
 *   - on SUCCESS: lastStatusSyncAt = now, statusNextSyncAt = cadence (> now),
 *     statusSyncRetryCount = 0;
 *   - on FAILURE: lastStatusSyncAt = now, statusSyncRetryCount += 1,
 *     statusNextSyncAt = backoff (> now) OR null when the retry budget is
 *     exhausted / the failure is permanent;
 *   - scheduler STOP: statusNextSyncAt = null.
 */
export function derivePollingState(row: InventoryStatusRow, now: Date = new Date()): InventoryStatusPolling {
  const last = toTime(row.lastStatusSyncAt)
  const next = toTime(row.statusNextSyncAt)
  const retries = Number(row.statusSyncRetryCount || 0)
  const nowMs = now.getTime()

  // The real scheduler failure shape: a failed attempt records lastStatusSyncAt
  // AND increments statusSyncRetryCount. retries > 0 ⇒ the scheduler is failing.
  if (retries > 0) {
    const stopped = next === null
    return {
      state: 'FAILED',
      label: stopped ? 'Status check stopped' : 'Status check failing',
      tone: 'danger',
      lastCheckAt: last !== null ? new Date(last).toISOString() : null,
      nextSyncAt: next !== null ? new Date(next).toISOString() : null,
      neverChecked: last === null,
      failing: true,
      stopped,
      due: false,
    }
  }

  if (last === null) {
    return {
      state: 'UNSYNCED',
      label: 'Not yet checked',
      tone: 'neutral',
      lastCheckAt: null,
      nextSyncAt: next !== null ? new Date(next).toISOString() : null,
      neverChecked: true,
      failing: false,
      stopped: next === null,
      due: false,
    }
  }

  if (next === null) {
    // Synced at least once, then the scheduler stopped polling this row.
    return {
      state: 'SYNCED',
      label: 'Status synced — polling stopped',
      tone: 'warn',
      lastCheckAt: new Date(last).toISOString(),
      nextSyncAt: null,
      neverChecked: false,
      failing: false,
      stopped: true,
      due: false,
    }
  }

  const due = next <= nowMs
  return {
    state: 'SYNCED',
    label: due ? 'Status check due' : 'Status synced',
    tone: due ? 'warn' : 'success',
    lastCheckAt: new Date(last).toISOString(),
    nextSyncAt: new Date(next).toISOString(),
    neverChecked: false,
    failing: false,
    stopped: false,
    due,
  }
}

/**
 * Canonical provider-neutral inventory status for a persisted eSIM row.
 * Consumes ONLY the safe normalized columns — never providerStatus/providerRawData.
 *
 * `lowRatio` is the shared low-data threshold (default LOW_DATA_RATIO_DEFAULT).
 */
export function deriveEsimInventoryStatus(
  row: InventoryStatusRow,
  now: Date = new Date(),
  lowRatio: number = LOW_DATA_RATIO_DEFAULT,
): EsimInventoryStatus {
  const install = String(row.installationStatus || '').toUpperCase()
  const service = serviceLabel(row.status)

  const details = installDetailsAvailable(row)
  const installation = details
    ? { detailsAvailable: true, label: 'Installation details available', tone: 'success' as const }
    : { detailsAvailable: false, label: 'No installation details', tone: 'warn' as const }

  // Device installation — CURRENT-installation evidence only. Explicit
  // normalized installation evidence wins; historical activation/usage is a
  // distinct, weaker label. READY/QR/install details never imply Installed and
  // never imply Not installed.
  const installCheck = toTime(row.installationLastCheckedAt ?? row.lastStatusSyncAt)
  const checkedAt = installCheck !== null ? new Date(installCheck).toISOString() : null
  let device: InventoryStatusDevice
  const deviceEvidence: string[] = []
  if (hasDeviceInstallEvidence(row)) {
    deviceEvidence.push('explicit normalized installation evidence (installationStatus=INSTALLED/ENABLED)')
    device = { state: 'INSTALLED', label: 'Installed (latest evidence)', tone: 'success', evidence: deviceEvidence, checkedAt }
  } else if (row.customerReportedInstalled === true) {
    // Separately recorded customer confirmation — distinct from provider
    // evidence in both the state label and the audit evidence string.
    deviceEvidence.push('customer-confirmed installation (separately recorded)')
    device = { state: 'INSTALLED', label: 'Installed (customer confirmed)', tone: 'success', evidence: deviceEvidence, checkedAt }
  } else if (install === 'INSTALLING' || String(row.status || '').toUpperCase() === 'INSTALLING') {
    deviceEvidence.push('installation lifecycle value')
    device = { state: 'INSTALLING', label: 'Installing', tone: 'warn', evidence: deviceEvidence, checkedAt }
  } else if (install === 'DOWNLOADED') {
    deviceEvidence.push('provider-reported profile download checkpoint')
    device = { state: 'DOWNLOADED', label: 'Profile downloaded; installation unconfirmed', tone: 'warn', evidence: deviceEvidence, checkedAt }
  } else if (install === 'ERROR' || install === 'FAILED') {
    if (isProviderReportedInstallFailure(row.installationLastError)) {
      deviceEvidence.push('provider-reported installation failure')
      device = { state: 'INSTALL_FAILED', label: 'Installation failed', tone: 'danger', evidence: deviceEvidence, checkedAt }
    } else {
      deviceEvidence.push('installation lookup or recovery failed without device failure evidence')
      device = { state: 'UNKNOWN', label: 'Installation details unavailable', tone: 'warn', evidence: deviceEvidence, checkedAt }
    }
  } else if (hasHistoricalActivationEvidence(row)) {
    // ACTIVE / activatedAt / activationDetectedAt / usage>0 prove activation or
    // use, NOT that the profile is still installed today.
    deviceEvidence.push('canonical ACTIVE or activation/usage history without current installation evidence')
    device = { state: 'ACTIVATED_UNCONFIRMED_INSTALL', label: 'Activated/used; current installation unconfirmed', tone: 'warn', evidence: deviceEvidence, checkedAt }
  } else {
    deviceEvidence.push('no device-installation evidence yet')
    device = { state: 'UNKNOWN', label: 'Installation status unknown', tone: 'neutral', evidence: deviceEvidence, checkedAt }
  }

  // Usage — used / total / remaining and the last usage check when the snapshot
  // is authoritative; otherwise exactly "Usage unavailable" (never a zero).
  const metrics = deriveUsageMetrics(row.dataUsedMB, row.dataTotalMB, row.dataRemainingMB)
  const lastUsage = toTime(row.lastUsageSyncAt)
  const usageFresh = getUsageStaleness(row.lastUsageSyncAt, now).stale
  let usage: InventoryStatusUsage
  if (!metrics.hasSnapshot) {
    usage = {
      hasSnapshot: false,
      label: 'Usage unavailable',
      usedLabel: null,
      totalLabel: null,
      remainingLabel: null,
      remainingKnown: false,
      remaining: 0,
      total: 0,
      stale: false,
      lastUsageCheckAt: lastUsage !== null ? new Date(lastUsage).toISOString() : null,
      tone: 'neutral',
    }
  } else {
    const usedLabel = metrics.usedKnown ? labelOfGigabytes(metrics.used) : null
    const totalLabel = metrics.total > 0 ? labelOfGigabytes(metrics.total) : null
    const remaining = usageRemainingLabel(metrics)
    const remainingLabel = remaining === '—' ? null : remaining
    const parts = [usedLabel, totalLabel, remainingLabel].filter((x): x is string => !!x)
    usage = {
      hasSnapshot: true,
      label: parts.length > 0 ? parts.join(' / ') : 'Usage unavailable',
      usedLabel,
      totalLabel,
      remainingLabel,
      remainingKnown: metrics.remainingKnown,
      remaining: metrics.remaining,
      total: metrics.total,
      stale: usageFresh,
      lastUsageCheckAt: lastUsage !== null ? new Date(lastUsage).toISOString() : null,
      tone: metrics.used > 0 ? 'success' : 'neutral',
    }
  }

  const polling = derivePollingState(row, now)
  const primary = primaryStatus({ service, installation, device, usage }, lowRatio, row.customerReportedInstalled === true)

  return {
    primary,
    service,
    installation,
    device,
    usage,
    polling,
    providerNeutral: true,
  }
}

const primaryStatus = primary

/** Convenience: derive from a Prisma eSIM row (safe fields only). */
export function deriveEsimInventoryStatusFromRow(
  esim: InventoryStatusRow,
  now: Date = new Date(),
  lowRatio: number = LOW_DATA_RATIO_DEFAULT,
): EsimInventoryStatus {
  return deriveEsimInventoryStatus(esim, now, lowRatio)
}

/** Canonical set of all lifecycle statuses available to the admin filter. */
export { ESIM_LIFECYCLE_STATUSES } from '@/lib/status-constants'