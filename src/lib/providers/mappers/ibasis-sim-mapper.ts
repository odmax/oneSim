/**
 * iBASIS SIM inventory mapper.
 *
 * Normalizes raw iBASIS inventory SIM payloads (GET /api/v1/inventory/sims)
 * into app-level SIM records and statuses. Also provides masking helpers so
 * that ICCIDs and eSIM activation codes are never logged in plain text.
 */

export interface IbasisInventorySim {
  iccid?: string
  type?: string
  carrier?: string
  status?: string
  activation_code?: string
}

export interface MappedIbasisSim {
  iccid: string
  providerStatus: string
  status: string
  normalizedStatus: string
  simType: string
  carrier: string | null
  activationCode: string | null
  rawData: Record<string, unknown>
}

const IBASIS_STATUS_MAP: Record<string, string> = {
  inventory: 'NOT_SENT',
  'activation pending': 'PENDING',
  pending: 'PENDING',
  activation_pending: 'PENDING',
  active: 'ACTIVE',
  suspended: 'SUSPENDED',
  deactivated: 'INACTIVE',
  inactive: 'INACTIVE',
  retired: 'RETIRED',
  cancelled: 'RETIRED',
  canceled: 'RETIRED',
  expired: 'EXPIRED',
}

export function normalizeSimStatus(providerStatus: string | null | undefined): string {
  if (!providerStatus) return 'UNKNOWN'
  const key = providerStatus.trim().toLowerCase()
  return IBASIS_STATUS_MAP[key] || 'UNKNOWN'
}

/** Masks an eSIM activation code for safe logging. Never log the raw code. */
export function maskActivationCode(code: string | null | undefined): string {
  if (!code) return ''
  if (code.length <= 8) return '••••'
  return `${code.slice(0, 4)}••••${code.slice(-4)}`
}

/** Masks an ICCID for safe logging. Never log a full ICCID. */
export function maskIccid(iccid: string | null | undefined): string {
  if (!iccid) return ''
  if (iccid.length <= 8) return '••••'
  return `${iccid.slice(0, 4)}••••${iccid.slice(-4)}`
}

/** Short, stable fingerprint of an activation code — used for change detection without persisting the raw code twice. */
export function activationCodeFingerprint(code: string | null | undefined): string {
  if (!code) return ''
  let hash = 0
  for (let i = 0; i < code.length; i++) {
    hash = ((hash << 5) - hash) + code.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

export function mapIbasisSim(sim: IbasisInventorySim): MappedIbasisSim {
  const providerStatus = sim.status || 'UNKNOWN'
  const status = normalizeSimStatus(providerStatus)

  return {
    iccid: sim.iccid || '',
    providerStatus,
    status,
    normalizedStatus: status,
    simType: sim.type || 'unknown',
    carrier: sim.carrier || null,
    activationCode: sim.activation_code || null,
    rawData: sim as unknown as Record<string, unknown>,
  }
}

export function computeSimComparableKey(iccid: string): string {
  return `sim:iccid:${iccid}`
}
