import { providerSupports, type CapabilityProvider } from './registry'
import { buildChoiceStatusLookup, hasChoiceIdentifier } from '@/lib/services/esims/choice-lookup'

export interface EsimActionState {
  visible: boolean
  enabled: boolean
  reason?: string
}

export interface EsimActionAvailability {
  refreshStatus: EsimActionState
  refreshUsage: EsimActionState
  qrCode: EsimActionState
  suspend: EsimActionState
  resume: EsimActionState
  topUp: EsimActionState
  isChoiceProvider: boolean
}

export interface EsimAvailabilityEsim {
  iccid?: string | null
  imsi?: string | null
  activationCode?: string | null
  qrCodeUrl?: string | null
  providerResponse?: any
  providerActivationId?: string | null
  providerSubscriptionId?: string | null
  providerSubscriberId?: string | null
  dataTotalMB?: number | null
  dataRemainingMB?: number | null
  status?: string | null
}

export type EsimAvailabilityProvider = (CapabilityProvider & {
  supportsTopUp?: boolean | null
  supportsQRCode?: boolean | null
}) | null | undefined

export interface EsimAvailabilityInput {
  provider: EsimAvailabilityProvider
  esim: EsimAvailabilityEsim
}

/** Statuses for which a suspend is a meaningful state transition. */
export const SUSPENDABLE_STATUSES = ['ACTIVE', 'PENDING_ACTIVATION', 'PENDING', 'INSTALLED']

/** Statuses that rule out top-up entirely. */
export const TERMINAL_TOP_UP_STATUSES = ['EXPIRED', 'FAILED', 'CANCELLED', 'REFUNDED']

function trimOrEmpty(value?: string | null): string {
  return value && String(value).trim() ? String(value).trim() : ''
}

export type UsagePanelMode = 'capability' | 'historic' | 'hidden'

/**
 * Decide how the usage panel should render. A USAGE-capable provider always
 * shows the panel (with "Usage unavailable" when no snapshot has synced yet).
 * A provider without USAGE only shows the panel when a real snapshot exists,
 * clearly labeled as last-synced usage; otherwise it is hidden entirely.
 */
export function getUsagePanelState(provider: EsimAvailabilityProvider, esim: EsimAvailabilityEsim): { mode: UsagePanelMode } {
  const hasUsageCapability = providerSupports(provider, 'USAGE')
  const hasSnapshot = esim.dataTotalMB != null || esim.dataRemainingMB != null
  if (hasUsageCapability) return { mode: 'capability' }
  if (hasSnapshot) return { mode: 'historic' }
  return { mode: 'hidden' }
}

export interface EsimStatusLabel {
  label: string
  tone: 'success' | 'warn' | 'danger' | 'neutral'
}

/**
 * Human label for eSIM lifecycle status. PENDING_ACTIVATION is never labelled
 * as ACTIVE — it maps to its own "ready to install" state.
 * ACTIVE means "Active" (not "Activated on device" — device activation requires
 * explicit evidence per deriveEsimLifecycleStatus).
 */
export function getEsimStatusLabel(status: string | null | undefined): EsimStatusLabel {
  const s = status || ''
  switch (s.toUpperCase()) {
    case 'ACTIVE':
      return { label: 'Active', tone: 'success' }
    case 'PENDING_ACTIVATION':
      return { label: 'Ready to install', tone: 'warn' }
    case 'INSTALLED':
      return { label: 'Installed on device', tone: 'success' }
    case 'PENDING':
      return { label: 'Provisioning', tone: 'warn' }
    case 'SUSPENDED':
      return { label: 'Suspended', tone: 'warn' }
    case 'EXPIRED':
      return { label: 'Expired', tone: 'danger' }
    case 'FAILED':
      return { label: 'Failed', tone: 'danger' }
    case 'CANCELLED':
      return { label: 'Cancelled', tone: 'danger' }
    case 'REFUNDED':
      return { label: 'Refunded', tone: 'danger' }
    default:
      return { label: s || 'Unknown', tone: 'neutral' }
  }
}

/**
 * Central capability/status/identifier gating for admin eSIM actions.
 *
 * Every action reports whether it should be rendered (`visible`) and whether it
 * is currently safe to run (`enabled`), plus a human-readable `reason` whenever
 * it is disabled. The rules live here once and are shared by every button, so
 * no visibility logic is duplicated across components.
 *
 * Identifier rule: a valid provider lookup identifier is the ICCID, a provider
 * IMSI stored in metadata, or a valid provider subscription/reference. The
 * local OneSIM eSIM DB id is never a valid provider identifier.
 */
export function getEsimActionAvailability(input: EsimAvailabilityInput): EsimActionAvailability {
  const { provider, esim } = input
  const isChoiceProvider = provider?.code?.toUpperCase() === 'CHOICE'
  const hasCapability = (cap: Parameters<typeof providerSupports>[1]) => providerSupports(provider, cap)

  const choiceLookup = buildChoiceStatusLookup(esim)
  const hasChoiceLookupIdentifier = hasChoiceIdentifier(choiceLookup)
  const iccid = trimOrEmpty(esim.iccid)
  const imsi = trimOrEmpty(esim.imsi)
  const hasReference = Boolean(
    trimOrEmpty(esim.providerActivationId) ||
    trimOrEmpty(esim.providerSubscriptionId) ||
    trimOrEmpty(esim.providerSubscriberId),
  )
  const hasLookupIdentifier = isChoiceProvider ? hasChoiceLookupIdentifier : Boolean(iccid || imsi || hasReference)
  const noIdentifierReason = isChoiceProvider
    ? 'Provider identifier unavailable (no ICCID, IMSI, or imsi_version).'
    : 'Provider identifier unavailable.'

  const status = (esim.status || '').toUpperCase()

  const refreshStatus: EsimActionState = {
    visible: hasCapability('STATUS'),
    enabled: hasCapability('STATUS') && hasLookupIdentifier,
    reason: hasCapability('STATUS') && !hasLookupIdentifier ? noIdentifierReason : undefined,
  }

  const refreshUsage: EsimActionState = {
    visible: hasCapability('USAGE'),
    enabled: hasCapability('USAGE') && hasLookupIdentifier,
    reason: hasCapability('USAGE') && !hasLookupIdentifier ? noIdentifierReason : undefined,
  }

  // QR is gated by stored activation data first: a stored qrCodeUrl, a stored
  // activationCode (the modal can render the LPA profile), or a provider that
  // declares a verified QR retrieval path for the ICCID. There is no QR
  // capability enum; when neither stored data nor a retrieval flag exists the
  // action is disabled with a friendly note instead of a dead provider call.
  const hasStoredQrData = Boolean(trimOrEmpty(esim.qrCodeUrl) || trimOrEmpty(esim.activationCode))
  const canRetrieveQrFromProvider = provider?.supportsQRCode === true && Boolean(iccid)
  const qrCode: EsimActionState = {
    visible: true,
    enabled: hasStoredQrData || canRetrieveQrFromProvider,
    reason:
      hasStoredQrData || canRetrieveQrFromProvider
        ? undefined
        : isChoiceProvider
          ? 'Choice did not return QR activation data for this eSIM.'
          : 'No QR activation data available for this eSIM.',
  }

  const suspend: EsimActionState = {
    visible: hasCapability('SUSPEND'),
    enabled: hasCapability('SUSPEND') && SUSPENDABLE_STATUSES.includes(status) && hasLookupIdentifier,
    reason: !hasCapability('SUSPEND')
      ? undefined
      : !hasLookupIdentifier
        ? noIdentifierReason
        : !SUSPENDABLE_STATUSES.includes(status)
          ? `Suspend is not available for ${status} status.`
          : undefined,
  }

  const resume: EsimActionState = {
    visible: hasCapability('RESUME'),
    enabled: hasCapability('RESUME') && status === 'SUSPENDED' && hasLookupIdentifier,
    reason: !hasCapability('RESUME')
      ? undefined
      : status !== 'SUSPENDED'
        ? 'Resume is only available for suspended eSIMs.'
        : !hasLookupIdentifier
          ? noIdentifierReason
          : undefined,
  }

  const topUp: EsimActionState = {
    visible: hasCapability('TOP_UP'),
    enabled:
      hasCapability('TOP_UP') &&
      provider?.supportsTopUp === true &&
      !TERMINAL_TOP_UP_STATUSES.includes(status) &&
      Boolean(iccid),
    reason: !hasCapability('TOP_UP')
      ? undefined
      : provider?.supportsTopUp !== true
        ? 'Top up is disabled for this provider.'
        : TERMINAL_TOP_UP_STATUSES.includes(status)
          ? `Top up is not available for ${status} status.`
          : !iccid
            ? 'Provider identifier unavailable for top-up.'
            : undefined,
  }

  return { refreshStatus, refreshUsage, qrCode, suspend, resume, topUp, isChoiceProvider }
}
