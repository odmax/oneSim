/**
 * Provider-neutral eSIM inventory status fields.
 *
 * One canonical, PURE (no prisma, no provider) derivation of the separate
 * inventory fields shared by the business and admin eSIM lists:
 *
 *   1. SERVICE LIFECYCLE  — canonical stored `status`, customer-safe label.
 *   2. INSTALLATION DETAILS — whether installation instructions exist. True
 *        only when usable QR/activation install data is present, or when
 *        installationStatus is READY (which reliably marks details available).
 *        Device-installation values (INSTALLED/ENABLED/DOWNLOADED/INSTALLING)
 *        alone never prove install instructions exist and never prove the eSIM
 *        is uninstalled or installed.
 *   3. DEVICE INSTALLATION — CURRENT-installation evidence ONLY. "Installed" is
 *        reserved for explicit normalized installation evidence
 *        (installationStatus INSTALLED/ENABLED, labelled "latest evidence" with
 *        the status-check time when known). Canonical ACTIVE/DEPLETED,
 *        activation timestamps, and recorded usage PROVE the eSIM was activated
 *        or used historically — they do not prove its profile is still
 *        installed — so they render the distinct
 *        "Activated/used; current installation unconfirmed". A raw provider
 *        ACTIVE claim, a lookup/recovery FAILED installationStatus, or merely
 *        "READY" never manufactures an installed or uninstalled device label.
 *   4. USAGE — "Usage unavailable" when no authoritative snapshot exists;
 *        a genuine zero never renders as missing and missing never renders as
 *        zero. When known, displays used / total / remaining and the last
 *        usage check time.
 *   5. STATUS POLLING — sync state, last check time, and next scheduled check,
 *        derived from the scheduler's own bookkeeping (lastStatusSyncAt /
 *        statusSyncRetryCount / statusNextSyncAt) — never from an arbitrary
 *        staleness threshold:
 *          - `statusSyncRetryCount > 0`      → the scheduler is failing (a
 *            successful sync resets it to 0; a failed sync records the attempt
 *            in lastStatusSyncAt AND increments the counter — that exact shape
 *            is the real failure signal);
 *          - `statusNextSyncAt === null`      → the scheduler stopped polling
 *            this row (retry budget exhausted, capability-unsupported, or a
 *            terminal lifecycle status);
 *          - `statusNextSyncAt <= now`        → the check is due/overdue;
 *          - `statusNextSyncAt > now`         → healthy, on cadence.
 *
 * Provider-specific raw status/raw payloads are NEVER read here, so a provider
 * response can never leak through this module.
 */

import { ESIM_STATUS_META } from '@/lib/status-constants'
import { hasUsableInstallData } from './installation-data'
import { deriveUsageMetrics, usageRemainingLabel } from './usage-metrics'

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

export interface EsimInventoryStatus {
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
    // No attempt yet and never failed.
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

  // A successful check exists (retries reset to 0). The scheduler's own next
  // check timestamp decides the state — never an external staleness threshold.
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

function labelOfGigabytes(d: number): string {
  return `${(d / 1024).toFixed(2)} GB`
}

/**
 * Canonical provider-neutral inventory status for a persisted eSIM row.
 * Consumes ONLY the safe normalized columns — never providerStatus/providerRawData.
 */
export function deriveEsimInventoryStatus(row: InventoryStatusRow, now: Date = new Date()): EsimInventoryStatus {
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
  const evidence: string[] = []
  if (hasDeviceInstallEvidence(row)) {
    evidence.push('explicit normalized installation evidence (installationStatus=INSTALLED/ENABLED)')
    device = { state: 'INSTALLED', label: 'Installed (latest evidence)', tone: 'success', evidence, checkedAt }
  } else if (install === 'INSTALLING' || String(row.status || '').toUpperCase() === 'INSTALLING') {
    evidence.push('installation lifecycle value')
    device = { state: 'INSTALLING', label: 'Installing', tone: 'warn', evidence, checkedAt }
  } else if (install === 'DOWNLOADED') {
    evidence.push('explicit downloaded-but-not-installed value')
    device = { state: 'DOWNLOADED', label: 'Downloaded, not installed', tone: 'warn', evidence, checkedAt }
  } else if (install === 'ERROR' || install === 'FAILED') {
    if (isProviderReportedInstallFailure(row.installationLastError)) {
      evidence.push('provider-reported installation failure')
      device = { state: 'INSTALL_FAILED', label: 'Installation failed', tone: 'danger', evidence, checkedAt }
    } else {
      evidence.push('installation lookup or recovery failed without device failure evidence')
      device = { state: 'UNKNOWN', label: 'Installation details unavailable', tone: 'warn', evidence, checkedAt }
    }
  } else if (hasHistoricalActivationEvidence(row)) {
    // ACTIVE / activatedAt / activationDetectedAt / usage>0 prove activation or
    // use, NOT that the profile is still installed today.
    evidence.push('canonical ACTIVE or activation/usage history without current installation evidence')
    device = { state: 'ACTIVATED_UNCONFIRMED_INSTALL', label: 'Activated/used; current installation unconfirmed', tone: 'warn', evidence, checkedAt }
  } else {
    evidence.push('no device-installation evidence yet')
    device = { state: 'UNKNOWN', label: 'Installation status unknown', tone: 'neutral', evidence, checkedAt }
  }

  // Usage — used / total / remaining and the last usage check when the snapshot
  // is authoritative; otherwise exactly "Usage unavailable" (never a zero).
  const metrics = deriveUsageMetrics(row.dataUsedMB, row.dataTotalMB, row.dataRemainingMB)
  const lastUsage = toTime(row.lastUsageSyncAt)
  let usage: InventoryStatusUsage
  if (!metrics.hasSnapshot) {
    usage = {
      hasSnapshot: false,
      label: 'Usage unavailable',
      usedLabel: null,
      totalLabel: null,
      remainingLabel: null,
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
      lastUsageCheckAt: lastUsage !== null ? new Date(lastUsage).toISOString() : null,
      tone: metrics.used > 0 ? 'success' : 'neutral',
    }
  }

  const polling = derivePollingState(row, now)

  return {
    service,
    installation,
    device,
    usage,
    polling,
    providerNeutral: true,
  }
}

/** Convenience: derive from a Prisma eSIM row (safe fields only). */
export function deriveEsimInventoryStatusFromRow(
  esim: InventoryStatusRow,
  now: Date = new Date(),
): EsimInventoryStatus {
  return deriveEsimInventoryStatus(esim, now)
}

/** Canonical set of all lifecycle statuses available to the admin filter. */
export { ESIM_LIFECYCLE_STATUSES } from '@/lib/status-constants'
