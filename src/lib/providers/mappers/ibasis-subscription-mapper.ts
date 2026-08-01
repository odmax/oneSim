/**
 * iBASIS subscription lifecycle mapper.
 *
 * Normalizes raw iBASIS subscription payloads (GET /api/v1/subscriptions/{id},
 * GET /api/v1/subscriptions/activations/{id}) into the app-level lifecycle:
 *
 *   PENDING, PROVISIONING, READY_TO_INSTALL, ACTIVE, SUSPENDED, EXPIRED, FAILED, CANCELLED
 *
 * All provider-specific status strings stay inside this module.
 */

export const SUBSCRIPTION_LIFECYCLE = [
  'PENDING',
  'PROVISIONING',
  'READY_TO_INSTALL',
  'ACTIVE',
  'SUSPENDED',
  'EXPIRED',
  'FAILED',
  'CANCELLED',
] as const

export type SubscriptionLifecycleStatus = (typeof SUBSCRIPTION_LIFECYCLE)[number]

/** Terminal states must never regress unless explicitly allowed. */
export const TERMINAL_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(['EXPIRED', 'CANCELLED'])

/**
 * iBASIS activation statuses: scheduled, pending, processing, reserved, completed,
 * canceled, rejected, failed. Subscription statuses: active, activation pending,
 * deactivated, suspended. Both vocabularies are folded into the app lifecycle.
 */
const IBASIS_STATUS_MAP: Record<string, SubscriptionLifecycleStatus> = {
  scheduled: 'PENDING',
  pending: 'PENDING',
  'activation pending': 'PENDING',
  activation_pending: 'PENDING',
  processing: 'PROVISIONING',
  reserved: 'PROVISIONING',
  completed: 'READY_TO_INSTALL',
  active: 'ACTIVE',
  suspended: 'SUSPENDED',
  deactivated: 'EXPIRED',
  expired: 'EXPIRED',
  retired: 'EXPIRED',
  rejected: 'FAILED',
  failed: 'FAILED',
  canceled: 'CANCELLED',
  cancelled: 'CANCELLED',
}

export function normalizeSubscriptionStatus(providerStatus: string | null | undefined): string {
  if (!providerStatus) return 'UNKNOWN'
  const key = providerStatus.trim().toLowerCase()
  return IBASIS_STATUS_MAP[key] || 'UNKNOWN'
}

export function isTerminalSubscriptionStatus(status: string): boolean {
  return TERMINAL_SUBSCRIPTION_STATUSES.has(status)
}

/**
 * Whether a local subscription may move from `current` to `next`.
 * Terminal states (EXPIRED/CANCELLED) never regress unless explicitly allowed.
 * FAILED remains retryable (iBASIS supports retrying failed activations).
 */
export function canTransitionSubscriptionStatus(
  current: string,
  next: string,
  opts: { allowedTransitions?: Array<[string, string]>; force?: boolean } = {},
): boolean {
  if (current === next) return true
  if (opts.force) return true
  if (opts.allowedTransitions?.some(([from, to]) => from === current && to === next)) return true
  if (isTerminalSubscriptionStatus(current)) return false
  return true
}

export interface MappedIbasisSubscription {
  providerSubscriptionId: string
  subscriberId: string | null
  iccid: string | null
  activationCode: string | null
  msisdn: string | null
  planId: string | null
  status: string
  providerStatus: string
  createdAt: string | null
  activatedAt: string | null
  expiresAt: string | null
  rawData: Record<string, unknown>
}

const DATE_FIELDS: Record<'createdAt' | 'activatedAt' | 'expiresAt', string[]> = {
  createdAt: ['created_at', 'createdAt', 'date_created'],
  activatedAt: ['activated_at', 'activatedAt', 'activation_date', 'date_activated'],
  expiresAt: ['expires_at', 'expiresAt', 'expiry_date', 'expiration_date'],
}

function readDate(raw: any, keys: string[]): string | null {
  for (const key of keys) {
    const val = raw?.[key]
    if (typeof val === 'string' && val.trim() !== '') return val
  }
  return null
}

function extractIccid(raw: any): string | null {
  const devices = raw?.devices
  if (Array.isArray(devices)) {
    for (const d of devices) {
      if (d && (d.type === 'iccid' || d.type === 'ICC_ID') && typeof d.device === 'string' && d.device.trim() !== '') {
        return d.device
      }
    }
  }
  if (typeof raw?.iccid === 'string' && raw.iccid.trim() !== '') return raw.iccid
  return null
}

export function mapIbasisSubscription(raw: any): MappedIbasisSubscription | null {
  if (!raw || typeof raw !== 'object') return null
  const id = raw.id ?? raw.subscription_id
  if (id === undefined || id === null || String(id).trim() === '') return null

  const providerStatus = typeof raw.status === 'string' && raw.status.trim() !== '' ? raw.status : 'UNKNOWN'

  return {
    providerSubscriptionId: String(id),
    subscriberId: typeof raw.subscriber === 'string' && raw.subscriber ? raw.subscriber : null,
    iccid: extractIccid(raw),
    activationCode: typeof raw.activation_code === 'string' && raw.activation_code ? raw.activation_code : null,
    msisdn: typeof raw.msisdn === 'string' && raw.msisdn ? raw.msisdn : null,
    planId: typeof raw.plan === 'string' && raw.plan ? raw.plan : null,
    status: normalizeSubscriptionStatus(providerStatus),
    providerStatus,
    createdAt: readDate(raw, DATE_FIELDS.createdAt),
    activatedAt: readDate(raw, DATE_FIELDS.activatedAt),
    expiresAt: readDate(raw, DATE_FIELDS.expiresAt),
    rawData: raw as Record<string, unknown>,
  }
}

/** Result of polling the activation-status endpoint (which returns a subscription_id once completed). */
export interface MappedIbasisActivationStatus {
  activationId: string
  status: string
  providerStatus: string
  providerSubscriptionId: string | null
  iccids: string[]
}

function extractIccids(raw: any): string[] {
  const out: string[] = []
  const devices = raw?.devices
  if (Array.isArray(devices)) {
    for (const d of devices) {
      if (d && (d.type === 'iccid' || d.type === 'ICC_ID') && typeof d.device === 'string' && d.device.trim() !== '') out.push(d.device.trim())
    }
  }
  if (typeof raw?.iccid === 'string' && raw.iccid.trim() !== '' && !out.includes(raw.iccid.trim())) out.push(raw.iccid.trim())
  return out
}

export function mapIbasisActivationStatus(raw: any, activationId: string): MappedIbasisActivationStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const providerStatus = typeof raw.status === 'string' && raw.status.trim() !== '' ? raw.status : 'UNKNOWN'
  const subscriptionId = typeof raw.subscription_id === 'string' && raw.subscription_id ? raw.subscription_id : null
  return {
    activationId,
    status: normalizeSubscriptionStatus(providerStatus),
    providerStatus,
    providerSubscriptionId: subscriptionId,
    iccids: extractIccids(raw),
  }
}

/**
 * Removes sensitive provider payload fields (SIM PIN/PUK, eSIM activation codes)
 * before metadata is persisted. Never log or store these in plain view.
 */
const SENSITIVE_SUBSCRIPTION_KEYS = new Set(['pin1', 'puk1', 'pin2', 'puk2', 'activation_code'])

export function sanitizeSubscriptionMetadata(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {}
  if (Array.isArray(raw)) {
    return raw.map((item) => sanitizeSubscriptionMetadata(item)) as unknown as Record<string, unknown>
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (SENSITIVE_SUBSCRIPTION_KEYS.has(k)) continue
    if (v && typeof v === 'object') out[k] = sanitizeSubscriptionMetadata(v)
    else out[k] = v
  }
  return out
}
