import { ESIM_STATUS_META } from '@/lib/status-constants'

/**
 * Customer-facing two-axis eSIM lifecycle presentation.
 *
 * Service axis  : what the service lifecycle means for the customer
 *                 (Provisioned / Provisioning / Active / Depleted / Suspended /
 *                 Expired / Failed / Cancelled / Refunded ...).
 * Setup axis    : how ready the eSIM is to install on a device
 *                 (Ready to install / Installing / Installed / Preparing /
 *                 Installation failed / Installation unavailable / Unknown).
 *
 * This module is PURE and provider-neutral. It NEVER receives the raw
 * provider status or provider vocabulary. "Installed" is only implied from
 * oneSIM's own authoritative evidence (canonical INSTALLED/ACTIVE/DEPLETED,
 * device-installed/network-attach evidence, authoritative activation
 * timestamps, real usage > 0) — never from a provider ACTIVE claim alone.
 *
 * Shared by server components, client components and API serializers so one
 * canonical mapping is used everywhere (no duplicate page-level maps).
 */

export type StatusTone = 'success' | 'warn' | 'danger' | 'neutral'

export interface EsimLifecyclePresentation {
  serviceStatus: string
  serviceLabel: string
  serviceTone: StatusTone
  setupStatus: string
  setupLabel: string
  setupTone: StatusTone
}

export interface LifecyclePresentationInput {
  /** Canonical stored eSIM.status (never raw providerStatus). */
  status?: string | null
  /** Stored installation status column (READY/PENDING/FAILED/STALE/...). */
  installationStatus?: string | null
  /** Whether usable install data (QR/activation code/manual pair) exists. */
  hasUsableInstallData?: boolean
  activatedAt?: Date | string | null
  activationDetectedAt?: Date | string | null
  /** Finite authoritative used value; absent/missing = unknown, never 0. */
  dataUsedMB?: number | null
  /** Normalized device-installed evidence already persisted by oneSIM. */
  deviceInstalled?: boolean
  /** Normalized network-attach evidence already persisted by oneSIM. */
  networkAttached?: boolean
}

const INSTALL_UNSUPPORTED_STATES = ['NOT_SUPPORTED', 'NOT_RECOVERABLE', 'PERMANENT_FAILURE']

function hasDate(value: Date | string | null | undefined): boolean {
  if (value == null) return false
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(t)
}

function setupPresentation(
  setupStatus: EsimLifecyclePresentation['setupStatus'],
  setupLabel: string,
  setupTone: StatusTone,
): Pick<EsimLifecyclePresentation, 'setupStatus' | 'setupLabel' | 'setupTone'> {
  return { setupStatus, setupLabel, setupTone }
}

function deriveSetupAxis(input: LifecyclePresentationInput): Pick<EsimLifecyclePresentation, 'setupStatus' | 'setupLabel' | 'setupTone'> {
  const status = String(input.status || '').toUpperCase()
  const install = String(input.installationStatus || '').toUpperCase()
  const usageKnown =
    typeof input.dataUsedMB === 'number' && Number.isFinite(input.dataUsedMB) && input.dataUsedMB > 0

  // Authoritative oneSIM evidence implies the eSIM reached a device.
  //  - canonical INSTALLED is itself device-installed evidence;
  //  - canonical ACTIVE required activation evidence in the lifecycle engine;
  //  - canonical DEPLETED had consumption (activation + usage) on a valid line;
  //  - deviceInstalled / networkAttached normalized evidence;
  //  - authoritative activation timestamps;
  //  - real usage greater than zero.
  const impliedInstalled =
    status === 'ACTIVE' ||
    status === 'INSTALLED' ||
    status === 'DEPLETED' ||
    input.deviceInstalled === true ||
    input.networkAttached === true ||
    hasDate(input.activatedAt) ||
    hasDate(input.activationDetectedAt) ||
    usageKnown

  if (impliedInstalled) return setupPresentation('INSTALLED', 'Installed', 'success')

  // Explicit installation lifecycle values.
  if (install === 'INSTALLING' || status === 'INSTALLING') {
    return setupPresentation('INSTALLING', 'Installing', 'warn')
  }
  if (install === 'FAILED') {
    return setupPresentation('INSTALLATION_FAILED', 'Installation failed', 'danger')
  }
  if (INSTALL_UNSUPPORTED_STATES.includes(install)) {
    return setupPresentation('INSTALLATION_UNAVAILABLE', 'Installation unavailable', 'warn')
  }
  if (install === 'STALE') {
    return setupPresentation('INSTALLATION_UNAVAILABLE', 'Installation unavailable', 'warn')
  }
  if (install === 'READY') {
    // READY is only "Ready to install" when usable install data actually
    // exists. READY without data must never present "Ready to install".
    return input.hasUsableInstallData === true
      ? setupPresentation('READY_TO_INSTALL', 'Ready to install', 'warn')
      : setupPresentation('PREPARING', 'Preparing', 'warn')
  }
  if (install === 'PENDING') {
    return setupPresentation('PREPARING', 'Preparing', 'warn')
  }

  // Missing/unknown installation state.
  return setupPresentation('UNKNOWN', 'Unknown', 'neutral')
}

function deriveServiceAxis(status: string | null | undefined): Pick<EsimLifecyclePresentation, 'serviceStatus' | 'serviceLabel' | 'serviceTone'> {
  const key = String(status || '').toUpperCase()
  const meta = ESIM_STATUS_META[key]
  if (meta) return { serviceStatus: key, serviceLabel: meta.label, serviceTone: meta.tone }
  return { serviceStatus: key || 'UNKNOWN', serviceLabel: key || 'Unknown', serviceTone: 'neutral' }
}

/** The single shared two-axis presentation used by all customer surfaces. */
export function deriveEsimLifecyclePresentation(input: LifecyclePresentationInput): EsimLifecyclePresentation {
  return {
    ...deriveServiceAxis(input.status),
    ...deriveSetupAxis(input),
  }
}

/** Convenience: derive from a persisted eSIM row (safe fields only). */
export function deriveEsimLifecyclePresentationFromRow(esim: {
  status?: string | null
  installationStatus?: string | null
  hasUsableInstallData?: boolean
  activatedAt?: Date | string | null
  activationDetectedAt?: Date | string | null
  dataUsedMB?: number | null
}): EsimLifecyclePresentation {
  return deriveEsimLifecyclePresentation({
    status: esim.status,
    installationStatus: esim.installationStatus,
    hasUsableInstallData: esim.hasUsableInstallData,
    activatedAt: esim.activatedAt,
    activationDetectedAt: esim.activationDetectedAt,
    dataUsedMB: esim.dataUsedMB,
  })
}

/**
 * Single customer-facing summary status badge for compact/list surfaces.
 *
 * Detail surfaces keep the full two-axis presentation; summary/list surfaces
 * must show ONE clear status. This helper is deterministic and provider-neutral:
 *   - terminal/service-impacting statuses always dominate (REFUNDED, CANCELLED,
 *     FAILED, EXPIRED, SUSPENDED, DEPLETED);
 *   - an ACTIVE service always displays `Active` regardless of setup state;
 *   - a provisioned eSIM (PENDING_ACTIVATION) maps its setup state to the most
 *     actionable customer status (Ready to install / Installing / Installation
 *     failed / Installation unavailable / Preparing / Provisioned);
 *   - other non-terminal provisioning states keep their established
 *     customer-safe service labels.
 *
 * It NEVER infers `Active` from QR availability, install data, a raw provider
 * ACTIVE claim or any setup evidence when the canonical lifecycle has not yet
 * derived ACTIVE. Presentation-only — never mutates lifecycle state.
 */
export interface EsimCustomerDisplayStatus {
  /** Canonical stored oneSIM service status that produced the summary (never a synthetic value). */
  status: string
  label: string
  tone: StatusTone
}

/** Service-impacting statuses that always dominate the summary badge. */
const SERVICE_DOMINANT_STATUSES = ['REFUNDED', 'CANCELLED', 'FAILED', 'EXPIRED', 'SUSPENDED', 'DEPLETED']

export function deriveEsimCustomerDisplayStatus(input: LifecyclePresentationInput): EsimCustomerDisplayStatus {
  const service = deriveServiceAxis(input.status)
  const setup = deriveSetupAxis(input)
  const status = String(input.status || '').toUpperCase() || 'UNKNOWN'

  // 1. Terminal / service-impacting statuses always dominate setup.
  if (SERVICE_DOMINANT_STATUSES.includes(status)) {
    return { status, label: service.serviceLabel, tone: service.serviceTone }
  }

  // 2. Active service dominates — a single `Active` badge, never a second
  //    `Installed` badge on summary/list views.
  if (status === 'ACTIVE' || status === 'INSTALLED') {
    return { status, label: service.serviceLabel, tone: service.serviceTone }
  }

  // 3. Provisioned / setup flow — the setup state is the most actionable truth.
  if (status === 'PENDING_ACTIVATION') {
    switch (setup.setupStatus) {
      case 'READY_TO_INSTALL':
        return { status, label: 'Ready to install', tone: 'warn' }
      case 'INSTALLING':
        return { status, label: 'Installing', tone: 'warn' }
      case 'INSTALLATION_FAILED':
        return { status, label: 'Installation failed', tone: 'danger' }
      case 'INSTALLATION_UNAVAILABLE':
        return { status, label: 'Installation unavailable', tone: 'warn' }
      case 'PREPARING':
        return { status, label: 'Preparing', tone: 'warn' }
      case 'INSTALLED':
        // Setup reports installed, but the canonical lifecycle has NOT derived
        // ACTIVE. Presentation never infers Active from install/QR/usage
        // evidence alone — show Provisioned.
        return { status, label: 'Provisioned', tone: 'warn' }
      case 'UNKNOWN':
      default:
        return { status, label: 'Provisioned', tone: 'warn' }
    }
  }

  // 4. Other non-terminal provisioning states keep established service labels.
  return { status, label: service.serviceLabel, tone: service.serviceTone }
}

/** Convenience: derive the customer summary status from a persisted eSIM row. */
export function deriveEsimCustomerDisplayStatusFromRow(esim: {
  status?: string | null
  installationStatus?: string | null
  hasUsableInstallData?: boolean
  activatedAt?: Date | string | null
  activationDetectedAt?: Date | string | null
  dataUsedMB?: number | null
}): EsimCustomerDisplayStatus {
  return deriveEsimCustomerDisplayStatus({
    status: esim.status,
    installationStatus: esim.installationStatus,
    hasUsableInstallData: esim.hasUsableInstallData,
    activatedAt: esim.activatedAt,
    activationDetectedAt: esim.activationDetectedAt,
    dataUsedMB: esim.dataUsedMB,
  })
}