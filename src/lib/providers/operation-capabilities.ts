/**
 * GENERIC PROVIDER OPERATION CAPABILITY GATE
 *
 * Central helper deciding whether a provider supports a given operation.
 * Maps generic operation keys to the EXISTING ProviderCapability strings so the
 * definition stays single-source (capabilities/types.ts). Backward compatible:
 * the same resolution the purchase orchestrator uses today is preserved exactly
 * (provider.enabledCapabilities ?? DEFAULT_PROVIDER_CAPABILITIES[code]).
 */
import { ProviderCapability } from './capabilities/types'
import { DEFAULT_PROVIDER_CAPABILITIES } from './capabilities/defaults'
import type { ProviderOperation } from './execution-policy'

export type ProviderOperationCapability = (typeof ProviderCapability)[keyof typeof ProviderCapability]

/** Generic operation → existing capability string (single source). */
export const OPERATION_TO_CAPABILITY: Record<ProviderOperation, ProviderOperationCapability> = {
  PURCHASE_ESIM: ProviderCapability.PURCHASE,
  GET_STATUS: ProviderCapability.STATUS,
  GET_USAGE: ProviderCapability.USAGE,
  TOP_UP: ProviderCapability.TOP_UP,
  SUSPEND: ProviderCapability.SUSPEND,
  RESUME: ProviderCapability.RESUME,
  REFRESH_QR: ProviderCapability.QR_CODE,
  WEBHOOK_STATUS: ProviderCapability.WEBHOOKS,
  // Reserved future IoT operations — mapped to the closest existing capability
  // for structural compatibility; NOT gated anywhere in this phase.
  IOT_ACTIVATE: ProviderCapability.PURCHASE,
  IOT_CHANGE_PLAN: ProviderCapability.CREATE_BUNDLE,
  IOT_SET_APN: ProviderCapability.PCR_PROFILE,
}

/** Driver/strategy aliases that resolve to a canonical provider code for capability defaults. */
const CAPABILITY_CODE_ALIASES: Record<string, string> = {
  TELNA_SEAMLESS: 'TELNA_SEAMLESS',
  TELNA_FLEX: 'TELNA_FLEX',
}

export interface CapabilityProviderLike {
  code?: string | null
  enabledCapabilities?: unknown // Prisma Json — string[] typically
}

function capabilityList(provider: CapabilityProviderLike): ProviderOperationCapability[] {
  const raw = provider.enabledCapabilities
  if (Array.isArray(raw)) return raw.map((c) => String(c)) as ProviderOperationCapability[]
  const code = CAPABILITY_CODE_ALIASES[provider.code || ''] || provider.code || ''
  const defs = DEFAULT_PROVIDER_CAPABILITIES[code]
  return defs ? ([...defs] as ProviderOperationCapability[]) : []
}

/**
 * Whether a provider supports an operation.
 * Mirrors the current purchase gate semantics: an EXPLICIT enabledCapabilities
 * list is authoritative; otherwise the provider-code defaults apply. Absent
 * capability ⇒ not supported (same as today's `caps.includes('PURCHASE')` fail).
 */
export function providerSupportsOperation(provider: CapabilityProviderLike, operation: ProviderOperation): boolean {
  const required = OPERATION_TO_CAPABILITY[operation]
  return capabilityList(provider).includes(required)
}

/**
 * Map a persisted job/attempt operation label to the generic ProviderOperation
 * key. 'purchase' is the legacy dispatch label; everything else (activation
 * polling, top-up, …) is a status/auxiliary lane.
 */
export function providerOperationFromLabel(label: string | undefined | null): ProviderOperation {
  const l = String(label || '').toLowerCase()
  if (l === 'purchase') return 'PURCHASE_ESIM'
  if (l === 'topup' || l === 'top_up') return 'TOP_UP'
  if (l === 'status' || l === 'activation') return 'GET_STATUS'
  if (l === 'usage') return 'GET_USAGE'
  if (l === 'suspend') return 'SUSPEND'
  if (l === 'resume') return 'RESUME'
  if (l === 'qr' || l === 'refresh_qr') return 'REFRESH_QR'
  if (l === 'webhook') return 'WEBHOOK_STATUS'
  return 'GET_STATUS'
}